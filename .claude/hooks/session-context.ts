// SessionStart context hook (docs/dev-harness.md, principle 5: dynamic state is computed, not
// written down). It injects a short block with the branch, the dirty-tree size, the current PLAN
// phase, the next unticked task, the reviewer rules due with it, and the task workflow, so
// CLAUDE.md doesn't have to carry any of that.
//
// Contract (verified against https://code.claude.com/docs/en/hooks, Claude Code 2.1.283):
// - stdin: the SessionStart payload ({ source: startup|resume|clear|compact|fork, ... }). Not
//   needed here: the block is the same for every source the settings matcher selects.
// - stdout: `{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }`. The
//   string is capped at 10,000 characters by Claude Code; this block stays far below that.
// - SessionStart can't block. This hook still fails open: any error prints nothing on stdout,
//   one line on stderr, and exits 0.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  parsePlanTasks,
  parseUncovered,
  rulesDueWith,
  type UncoveredSchedule,
} from '../../evals/harness/reviewer/coverage.ts';

export const MAX_LINES = 25;
export const MAX_LINE_LENGTH = 240;
export const MAX_TITLE_LENGTH = 120;

export const PLAN_PATH = 'docs/PLAN.md';
export const UNCOVERED_PATH = 'evals/harness/reviewer/uncovered.json';

export interface ContextInput {
  /** `git rev-parse --abbrev-ref HEAD`; `HEAD` when detached; null when git failed. */
  readonly branch: string | null;
  /** Lines of `git status --porcelain`; null when git failed. */
  readonly dirtyCount: number | null;
  /** PLAN task id → ticked, in document order (`parsePlanTasks`). */
  readonly tasks: ReadonlyMap<string, boolean>;
  /** PLAN task id → the text after the id on its checkbox line. */
  readonly titles: ReadonlyMap<string, string>;
  /** The eval-coverage schedule; null when uncovered.json couldn't be read or parsed. */
  readonly schedule: UncoveredSchedule | null;
}

// `- [ ] 2.9 Security tests: ...` in docs/PLAN.md §10 (same shape as coverage.ts's TASK_LINE).
const TASK_TITLE_LINE = /^- \[[ x]\] (\d+[a-z]?\.\d+) (.*)$/gm;
const PHASE_ID = /^(\d+)([a-z]*)$/;

/** Parses PLAN.md checkbox lines into `task id → title text`. */
export function parseTaskTitles(planMarkdown: string): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  for (const match of planMarkdown.matchAll(TASK_TITLE_LINE)) {
    const [, id, title] = match;
    if (id !== undefined && title !== undefined) titles.set(id, title.trim());
  }
  return titles;
}

/** The phase of a task id: `4a.7` → `4a`. */
export function phaseOf(taskId: string): string {
  return taskId.slice(0, taskId.indexOf('.'));
}

/** Orders phases numerically, then by suffix: `0 < 1 < 2 < 4 < 4a < 4b < 10`. */
export function comparePhases(a: string, b: string): number {
  const [, numA = '', suffixA = ''] = PHASE_ID.exec(a) ?? [];
  const [, numB = '', suffixB = ''] = PHASE_ID.exec(b) ?? [];
  const byNumber = Number(numA) - Number(numB);
  if (byNumber !== 0) return byNumber;
  return suffixA < suffixB ? -1 : suffixA > suffixB ? 1 : 0;
}

/** Shortens a line to `max` characters, ending with `…` when cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The first unticked task of the current phase, in document order, or null when every task is
 * ticked. Taking it from the current phase keeps the phase line and the next task consistent even
 * if PLAN.md ever lists phases out of order.
 */
export function nextTask(tasks: ReadonlyMap<string, boolean>): string | null {
  const phase = currentPhase(tasks);
  for (const [id, done] of tasks) if (!done && phaseOf(id) === phase) return id;
  return null;
}

/** The earliest phase (by `comparePhases`) that still has an unticked task. */
export function currentPhase(tasks: ReadonlyMap<string, boolean>): string | null {
  const open = [...tasks].filter(([, done]) => !done).map(([id]) => phaseOf(id));
  return open.sort(comparePhases)[0] ?? null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function branchLine(branch: string | null, dirtyCount: number | null): string {
  const name = branch ?? 'unknown (git failed)';
  if (dirtyCount === null) return `Branch: ${name}`;
  const tree = dirtyCount === 0 ? 'clean tree' : `${plural(dirtyCount, 'uncommitted file')}`;
  return `Branch: ${name} (${tree})`;
}

function rulesLine(task: string, schedule: UncoveredSchedule | null): string {
  if (schedule === null)
    return `Reviewer rules due with ${task}: unknown (${UNCOVERED_PATH} unreadable)`;
  const due = rulesDueWith(task, schedule);
  if (due.length === 0) return `Reviewer rules due with ${task}: none`;
  return `Reviewer rules due with ${task} (each needs a planted eval case before the task is ticked): ${due.join(', ')}`;
}

/** The context block. Pure: every input is plain data. */
export function buildContext(input: ContextInput): string {
  const lines = [
    'micro-minds session context (computed at session start by .claude/hooks/session-context.ts)',
    branchLine(input.branch, input.dirtyCount),
  ];
  if (input.branch === 'main' && input.dirtyCount !== null && input.dirtyCount > 0) {
    lines.push(
      'WARNING: uncommitted changes on main. Create a branch before changing files (`/start-task <id>` does it).',
    );
  }

  const next = nextTask(input.tasks);
  const phase = currentPhase(input.tasks);
  if (next === null || phase === null) {
    lines.push(`All ${plural(input.tasks.size, 'task')} in ${PLAN_PATH} are ticked.`);
    lines.push('Workflow: agree the next piece of work with the user before starting.');
  } else {
    const inPhase = [...input.tasks].filter(([id]) => phaseOf(id) === phase);
    const done = inPhase.filter(([, ticked]) => ticked).length;
    const title = truncate(input.titles.get(next) ?? '', MAX_TITLE_LENGTH);
    lines.push(`Current phase: ${phase} (${done} of ${inPhase.length} tasks ticked)`);
    lines.push(`Next task: ${next}${title.length > 0 ? ` ${title}` : ''}`);
    lines.push(rulesLine(next, input.schedule));
    lines.push(
      `Workflow: \`/start-task ${next}\` (scope, branch, plan, tests locked by the test writer) → implement against them → \`/finish-task\` (check and lock, independent review, tick, commit). Read the task in ${PLAN_PATH} first.`,
    );
    lines.push(
      `Until the MVP ships (4a), prefer the whole phase: \`/run-phase ${phase}\` (one branch and PR per phase; stops for human steps; the user merges).`,
    );
  }

  const capped = lines.map((line) => truncate(line, MAX_LINE_LENGTH));
  return capped.length <= MAX_LINES
    ? capped.join('\n')
    : [...capped.slice(0, MAX_LINES - 1), '…'].join('\n');
}

/** The SessionStart JSON output that adds `context` to Claude's context. */
export function formatOutput(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  });
}

export interface ContextIo {
  /** Reads a file relative to the project root. May throw. */
  readonly readText: (relativePath: string) => string;
  /** Runs git with the given arguments in the project root and returns stdout. May throw. */
  readonly git: (args: readonly string[]) => string;
}

function tryOrNull<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Gathers the context input. Git and the coverage schedule are optional (their line says
 * "unknown"); PLAN.md is required, so a read failure throws and the hook prints nothing.
 */
export function gatherInput(io: ContextIo): ContextInput {
  const plan = io.readText(PLAN_PATH);
  const branch = tryOrNull(() => io.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim());
  const dirtyCount = tryOrNull(
    () =>
      io
        .git(['status', '--porcelain'])
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0).length,
  );
  const schedule = tryOrNull(() => {
    const parsed = parseUncovered(JSON.parse(io.readText(UNCOVERED_PATH)));
    return parsed.ok ? parsed.value : null;
  });
  return {
    branch: branch === null || branch.length === 0 ? null : branch,
    dirtyCount,
    tasks: parsePlanTasks(plan),
    titles: parseTaskTitles(plan),
    schedule,
  };
}

/* v8 ignore start -- process entry point: covered by the subprocess test in evals/harness/session, which v8 cannot instrument. */
const GIT_TIMEOUT_MS = 2_000;

function main(): void {
  const projectDir =
    process.env.CLAUDE_PROJECT_DIR ?? path.resolve(import.meta.dirname, '..', '..');
  const io: ContextIo = {
    readText: (relativePath) => readFileSync(path.join(projectDir, relativePath), 'utf8'),
    git: (args) =>
      execFileSync('git', args, {
        cwd: projectDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      }),
  };
  process.stdout.write(`${formatOutput(buildContext(gatherInput(io)))}\n`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `micro-minds session-context: skipped (${error instanceof Error ? error.message : String(error)})\n`,
    );
  }
  process.exitCode = 0;
}
/* v8 ignore stop */
