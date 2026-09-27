// Reviewer evals runner (PLAN §11.1). Invokes the `reviewer` agent headlessly on every case in
// ./cases and scores recall and false positives. It spends tokens, so it runs on demand only:
//
//   npm run eval:harness                        all cases
//   npm run eval:harness -- bind-all-interfaces one or more cases by name
//   npm run eval:harness -- --dry-run           validate cases, print the command, spend nothing
//
// Node built-ins only. Parsing and scoring live in score.ts (unit-tested); this file does I/O.

import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import {
  buildClaudeArgs,
  buildPrompt,
  DEFAULT_INVOCATION,
  formatCommand,
  type InvocationOptions,
} from './invocation.ts';
import { type ResolvedBinary, resolveOnPath } from './resolve-bin.ts';
import {
  type CaseScore,
  checkUnifiedDiff,
  type Expected,
  extractRuleCatalog,
  formatSummaryTable,
  parseClaudeJson,
  parseExpected,
  parseReviewOutput,
  type ReviewOutput,
  scoreCase,
  scoreErroredCase,
  summarize,
} from './score.ts';

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const CASES_DIR = path.join(HERE, 'cases');
const RESULTS_DIR = path.join(HERE, 'results');
const AGENT_FILE = path.join(REPO_ROOT, '.claude', 'agents', 'reviewer.md');
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface EvalCase {
  name: string;
  diff: string;
  expected: Expected;
}

interface CliOptions {
  dryRun: boolean;
  caseNames: string[];
  invocation: InvocationOptions;
  timeoutMs: number;
}

interface CaseRun {
  score: CaseScore;
  review: ReviewOutput | null;
  resultText: string;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number;
  stderr: string;
}

const USAGE = `Usage: npm run eval:harness -- [case ...] [options]

Options:
  --dry-run              Validate cases and print the claude command; spend no tokens
  --model <name>         Model override (default: the agent's model / your default)
  --max-turns <n>        Turn cap per case (default ${DEFAULT_INVOCATION.maxTurns})
  --max-budget-usd <n>   Spend cap per case in USD (default ${DEFAULT_INVOCATION.maxBudgetUsd})
  --timeout-ms <n>       Kill a case after n ms (default ${DEFAULT_TIMEOUT_MS})
  -h, --help             Show this help`;

function positiveNumber(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive number`);
  return value;
}

function parseCli(argv: readonly string[]): CliOptions | 'help' {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      model: { type: 'string' },
      'max-turns': { type: 'string' },
      'max-budget-usd': { type: 'string' },
      'timeout-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return 'help';
  const maxTurns = positiveNumber(values['max-turns'], '--max-turns', DEFAULT_INVOCATION.maxTurns);
  if (!Number.isInteger(maxTurns)) throw new Error('--max-turns must be an integer');
  return {
    dryRun: values['dry-run'],
    caseNames: positionals,
    invocation: {
      maxTurns,
      maxBudgetUsd: positiveNumber(
        values['max-budget-usd'],
        '--max-budget-usd',
        DEFAULT_INVOCATION.maxBudgetUsd,
      ),
      model: values.model,
    },
    timeoutMs: positiveNumber(values['timeout-ms'], '--timeout-ms', DEFAULT_TIMEOUT_MS),
  };
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveClaude(): ResolvedBinary | undefined {
  return resolveOnPath('claude', {
    platform: process.platform,
    pathEnv: process.env.PATH,
    pathExt: process.env.PATHEXT,
    isFile: isExecutableFile,
  });
}

function loadCases(catalog: readonly string[], filter: readonly string[]): EvalCase[] {
  const available = readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const unknown = filter.filter((name) => !available.includes(name));
  if (unknown.length > 0) {
    throw new Error(`unknown case(s): ${unknown.join(', ')}\navailable: ${available.join(', ')}`);
  }
  const names = filter.length > 0 ? available.filter((n) => filter.includes(n)) : available;
  const problems: string[] = [];
  const cases: EvalCase[] = [];
  for (const name of names) {
    const dir = path.join(CASES_DIR, name);
    let diff: string;
    let expectedRaw: unknown;
    try {
      diff = readFileSync(path.join(dir, 'change.diff'), 'utf8');
      expectedRaw = JSON.parse(readFileSync(path.join(dir, 'expected.json'), 'utf8'));
    } catch (error: unknown) {
      problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const diffCheck = checkUnifiedDiff(diff);
    if (!diffCheck.ok) problems.push(`${name}/change.diff: ${diffCheck.error}`);
    const expected = parseExpected(expectedRaw, catalog);
    if (!expected.ok) problems.push(`${name}/expected.json: ${expected.error}`);
    if (diffCheck.ok && expected.ok) cases.push({ name, diff, expected: expected.value });
  }
  if (problems.length > 0) throw new Error(`invalid cases:\n  ${problems.join('\n  ')}`);
  return cases;
}

interface ProcessOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Kills the child and everything it started. On Windows `child.kill()` only ends the direct
 * child, which for a `.cmd` shim is `cmd.exe`, leaving `claude` running (and spending tokens).
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    }).on('error', () => child.kill());
    return;
  }
  child.kill('SIGKILL');
}

function runClaude(
  binary: ResolvedBinary,
  args: readonly string[],
  stdin: string,
  timeoutMs: number,
): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    // A `.cmd` shim needs a shell on Windows; every arg is pre-validated as shell-safe
    // (invocation.ts), and the binary path is quoted because it may contain spaces.
    const child = binary.needsShell
      ? spawn(`"${binary.path}"`, [...args], { cwd: REPO_ROOT, shell: true, windowsHide: true })
      : spawn(binary.path, [...args], { cwd: REPO_ROOT, shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const settle = (code: number | null, timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      killTree(child);
      // A surviving grandchild can keep the pipes open, so don't wait for 'close'.
      child.stdout.destroy();
      child.stderr.destroy();
      settle(null, true);
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => settle(code, false));
    child.stdin.on('error', () => {
      // EPIPE if claude exits before reading stdin; the exit code and stderr explain why.
    });
    child.stdin.end(stdin, 'utf8');
  });
}

async function runCase(
  evalCase: EvalCase,
  binary: ResolvedBinary,
  args: readonly string[],
  catalog: readonly string[],
  timeoutMs: number,
): Promise<CaseRun> {
  const started = performance.now();
  const base = { review: null, resultText: '', costUsd: null, numTurns: null, stderr: '' };
  const fail = (error: string, extra: Partial<CaseRun> = {}): CaseRun => ({
    ...base,
    ...extra,
    score: scoreErroredCase(evalCase.name, evalCase.expected, error),
    durationMs: performance.now() - started,
  });

  let output: ProcessOutput;
  try {
    output = await runClaude(binary, args, buildPrompt(evalCase.diff), timeoutMs);
  } catch (error: unknown) {
    return fail(
      `failed to start claude: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const stderr = output.stderr.trim();
  if (output.timedOut) return fail(`timed out after ${timeoutMs} ms`, { stderr });

  const claude = parseClaudeJson(output.stdout);
  if (!claude.ok) {
    return fail(`${claude.error} (exit ${String(output.code)})`, { stderr });
  }
  const { resultText, costUsd, numTurns, isError, subtype } = claude.value;
  const extra = { resultText, costUsd, numTurns, stderr };
  if (isError) return fail(`claude run failed: ${subtype}`, extra);

  const review = parseReviewOutput(resultText);
  if (!review.ok) return fail(`unparseable review: ${review.error}`, extra);
  return {
    ...extra,
    review: review.value,
    score: scoreCase(evalCase.name, evalCase.expected, review.value, catalog),
    durationMs: performance.now() - started,
  };
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  if (cli === 'help') {
    console.log(USAGE);
    return 0;
  }

  if (process.env.CI) {
    console.log(
      'eval:harness: CI is set, so the reviewer evals are skipped. They call the real Claude ' +
        'CLI and spend tokens, so PLAN §11.1 keeps them out of CI. Run them locally on demand.',
    );
    return 0;
  }

  const catalog = extractRuleCatalog(readFileSync(AGENT_FILE, 'utf8'));
  if (catalog.length === 0) throw new Error(`no rule catalog found in ${AGENT_FILE}`);
  const cases = loadCases(catalog, cli.caseNames);
  const args = buildClaudeArgs(cli.invocation);
  const binary = resolveClaude();

  if (cli.dryRun) {
    console.log(`Rule catalog: ${catalog.length} ids from ${path.relative(REPO_ROOT, AGENT_FILE)}`);
    console.log(`Cases: ${cases.length} valid`);
    for (const c of cases) {
      const kind = c.expected.mustFind.length === 0 ? 'clean' : c.expected.mustFind.join(', ');
      const bytes = Buffer.byteLength(buildPrompt(c.diff));
      console.log(`  ${c.name.padEnd(28)} ${String(bytes).padStart(6)} B stdin  ${kind}`);
    }
    const shown = binary?.path ?? 'claude';
    console.log(`\nclaude: ${binary ? binary.path : 'NOT FOUND on PATH'}`);
    console.log(`Would run per case (cwd ${REPO_ROOT}), prompt + diff on stdin:`);
    console.log(`  ${formatCommand(shown, args)}${binary?.needsShell ? '  [via shell]' : ''}`);
    return binary ? 0 : 1;
  }

  if (!binary) {
    console.error(
      'eval:harness: `claude` was not found on PATH. Install Claude Code and log in, then retry.',
    );
    return 1;
  }

  console.log(`Running ${cases.length} reviewer case(s) with ${binary.path}. This spends tokens.`);
  const runs: CaseRun[] = [];
  for (const [index, evalCase] of cases.entries()) {
    process.stdout.write(`[${index + 1}/${cases.length}] ${evalCase.name} ... `);
    const run = await runCase(evalCase, binary, args, catalog, cli.timeoutMs);
    runs.push(run);
    const cost = run.costUsd === null ? '' : ` $${run.costUsd.toFixed(3)}`;
    const status = run.score.status === 'error' ? `ERROR: ${run.score.error ?? ''}` : 'done';
    console.log(`${status} (${(run.durationMs / 1000).toFixed(0)}s${cost})`);
  }

  const scores = runs.map((r) => r.score);
  const summary = summarize(scores);
  const totalCost = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  console.log(`\n${formatSummaryTable(scores, summary)}`);
  const unknownIds = [...new Set(scores.flatMap((s) => s.unknownRuleIds))];
  if (unknownIds.length > 0) console.log(`Rule ids not in the catalog: ${unknownIds.join(', ')}`);
  for (const reason of summary.reasons) console.log(`  - ${reason}`);

  await mkdir(RESULTS_DIR, { recursive: true });
  const resultFile = path.join(RESULTS_DIR, `${timestamp()}.json`);
  const report = {
    createdAt: new Date().toISOString(),
    claudeBinary: binary.path,
    args,
    timeoutMs: cli.timeoutMs,
    totalCostUsd: totalCost,
    summary,
    cases: runs,
  };
  await writeFile(resultFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    `\nTotal cost ~$${totalCost.toFixed(2)}. Results: ${path.relative(REPO_ROOT, resultFile)}`,
  );
  return summary.passed ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`eval:harness: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);
