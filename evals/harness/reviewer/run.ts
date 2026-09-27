// Reviewer evals runner (PLAN §11.1). Invokes the `reviewer` agent headlessly on every case in
// ./cases and scores recall and false positives. It spends tokens, so it runs on demand only:
//
//   npm run eval:harness                        all cases
//   npm run eval:harness -- bind-all-interfaces one or more cases by name
//   npm run eval:harness -- --dry-run           validate cases, print the command, spend nothing
//   npm run eval:harness -- --trials 3          run every case 3 times (pass rule in trials.ts)
//
// Node built-ins only. Parsing and scoring live in score.ts, trial aggregation in trials.ts and
// version parsing in versions.ts (all unit-tested); this file does I/O.

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
  parseClaudeJson,
  parseExpected,
  parseReviewOutput,
  type ReviewOutput,
  scoreCase,
  scoreErroredCase,
} from './score.ts';
import {
  formatBaselineRow,
  formatTrialsTable,
  MAX_TRIALS,
  parseTrials,
  requiredPasses,
  summarizeTrials,
} from './trials.ts';
import { describeModels, distinctModels, parseClaudeVersion, UNKNOWN } from './versions.ts';

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const CASES_DIR = path.join(HERE, 'cases');
const RESULTS_DIR = path.join(HERE, 'results');
const AGENT_FILE = path.join(REPO_ROOT, '.claude', 'agents', 'reviewer.md');
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const VERSION_TIMEOUT_MS = 30 * 1000;

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
  trials: number;
}

interface CaseRun {
  score: CaseScore;
  review: ReviewOutput | null;
  resultText: string;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number;
  stderr: string;
  /** Model ids from the result's `modelUsage`, costliest first; ['unknown'] if it had none. */
  models: string[];
}

const USAGE = `Usage: npm run eval:harness -- [case ...] [options]

Options:
  --dry-run              Validate cases and print the claude command; spend no tokens
  --model <name>         Model override (default: the agent's model / your default)
  --max-turns <n>        Turn cap per case (default ${DEFAULT_INVOCATION.maxTurns})
  --max-budget-usd <n>   Spend cap per case in USD (default ${DEFAULT_INVOCATION.maxBudgetUsd})
  --timeout-ms <n>       Kill a case after n ms (default ${DEFAULT_TIMEOUT_MS})
  --trials <n>           Run each case n times, 1-${MAX_TRIALS} (default 1); a case passes
                         when at least ceil(2n/3) of its trials pass
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
      trials: { type: 'string' },
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
    trials: parseTrials(values.trials),
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
  const base = {
    review: null,
    resultText: '',
    costUsd: null,
    numTurns: null,
    stderr: '',
    models: [UNKNOWN],
  };
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
  const models = claude.value.models.length > 0 ? claude.value.models : [UNKNOWN];
  const extra = { resultText, costUsd, numTurns, stderr, models };
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

/** `claude --version`, parsed; `unknown` if it fails. Spends no tokens. */
async function claudeCodeVersion(binary: ResolvedBinary | undefined): Promise<string> {
  if (!binary) return UNKNOWN;
  try {
    const output = await runClaude(binary, ['--version'], '', VERSION_TIMEOUT_MS);
    return output.code === 0 && !output.timedOut ? parseClaudeVersion(output.stdout) : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
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
  const version = await claudeCodeVersion(binary);
  const trialsNote = `${cli.trials} trial(s) per case, a case passes when >= ${requiredPasses(cli.trials)} pass`;

  if (cli.dryRun) {
    console.log(`Rule catalog: ${catalog.length} ids from ${path.relative(REPO_ROOT, AGENT_FILE)}`);
    console.log(`Cases: ${cases.length} valid`);
    for (const c of cases) {
      const kind = c.expected.mustFind.length === 0 ? 'clean' : c.expected.mustFind.join(', ');
      const bytes = Buffer.byteLength(buildPrompt(c.diff));
      console.log(`  ${c.name.padEnd(28)} ${String(bytes).padStart(6)} B stdin  ${kind}`);
    }
    const shown = binary?.path ?? 'claude';
    console.log(`\nclaude: ${binary ? binary.path : 'NOT FOUND on PATH'} (Claude Code ${version})`);
    console.log(`Trials: ${trialsNote}; ${cases.length * cli.trials} session(s) in total`);
    console.log(`Would run per trial (cwd ${REPO_ROOT}), prompt + diff on stdin:`);
    console.log(`  ${formatCommand(shown, args)}${binary?.needsShell ? '  [via shell]' : ''}`);
    return binary ? 0 : 1;
  }

  if (!binary) {
    console.error(
      'eval:harness: `claude` was not found on PATH. Install Claude Code and log in, then retry.',
    );
    return 1;
  }

  const total = cases.length * cli.trials;
  console.log(
    `Running ${cases.length} reviewer case(s) x ${cli.trials} trial(s) with Claude Code ` +
      `${version} (${binary.path}); ${trialsNote}. This spends tokens.`,
  );
  const perCase: CaseRun[][] = [];
  let done = 0;
  for (const evalCase of cases) {
    const trials: CaseRun[] = [];
    for (let trial = 1; trial <= cli.trials; trial++) {
      done += 1;
      const label = cli.trials > 1 ? ` trial ${trial}/${cli.trials}` : '';
      process.stdout.write(`[${done}/${total}] ${evalCase.name}${label} ... `);
      const run = await runCase(evalCase, binary, args, catalog, cli.timeoutMs);
      trials.push(run);
      const cost = run.costUsd === null ? '' : ` $${run.costUsd.toFixed(3)}`;
      const status = run.score.status === 'error' ? `ERROR: ${run.score.error ?? ''}` : 'done';
      console.log(`${status} (${(run.durationMs / 1000).toFixed(0)}s${cost})`);
    }
    perCase.push(trials);
  }

  const report = summarizeTrials(perCase.map((trials) => trials.map((r) => r.score)));
  const allRuns = perCase.flat();
  const totalCost = allRuns.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const models = distinctModels(allRuns.map((r) => r.models));
  const modelFlag = cli.invocation.model;
  console.log(
    `\nClaude Code ${version}, reviewer model: ${describeModels(models, modelFlag)}, ` +
      `trials: ${cli.trials}`,
  );
  console.log(formatTrialsTable(report));
  const scores = allRuns.map((r) => r.score);
  const unknownIds = [...new Set(scores.flatMap((s) => s.unknownRuleIds))];
  if (unknownIds.length > 0) console.log(`Rule ids not in the catalog: ${unknownIds.join(', ')}`);
  for (const reason of report.reasons) console.log(`  - ${reason}`);

  await mkdir(RESULTS_DIR, { recursive: true });
  const createdAt = new Date();
  const resultFile = path.join(RESULTS_DIR, `${timestamp()}.json`);
  const results = {
    createdAt: createdAt.toISOString(),
    claudeBinary: binary.path,
    claudeCodeVersion: version,
    models,
    modelFlag: modelFlag ?? null,
    trials: cli.trials,
    requiredPasses: requiredPasses(cli.trials),
    args,
    timeoutMs: cli.timeoutMs,
    totalCostUsd: totalCost,
    passed: report.passed,
    reasons: report.reasons,
    summary: report.summary,
    cases: report.cases.map((c, index) => ({
      name: c.name,
      clean: c.clean,
      passes: c.passes,
      trials: c.trials,
      required: c.required,
      errors: c.errors,
      passed: c.passed,
      flaky: c.flaky,
      runs: perCase[index] ?? [],
    })),
  };
  await writeFile(resultFile, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  console.log(
    `\nTotal cost ~$${totalCost.toFixed(2)}. Results: ${path.relative(REPO_ROOT, resultFile)}`,
  );
  console.log('\nBaseline history row for evals/harness/README.md (edit the Notes as needed):');
  console.log(
    formatBaselineRow({
      date: createdAt,
      models,
      modelFlag,
      claudeCodeVersion: version,
      totalCostUsd: totalCost,
      report,
    }),
  );
  return report.passed ? 0 : 1;
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
