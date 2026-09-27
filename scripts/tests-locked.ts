// The test lock (ADR 0028). After a task's tests were written by the separate test writer and
// committed with a `Test-lock: <task-id>` trailer, nothing later in the task may edit, delete or add
// a test. An instruction to the implementer is a request; this exit code is a fact.
//
//   node scripts/tests-locked.ts <task-id> [--base <ref>]      (npm run tests:locked -- <id>)
//
// Only commits in <base>..HEAD count (default base: `git merge-base HEAD origin/main`). The
// current state is HEAD, the index and the working tree, including untracked files that aren't
// ignored. Content is compared as git blob ids (`git hash-object` applies the path's checkout
// filters), so CRLF from checkout conversion is not a modification.
//
// A revision (the second lock commit) is also checked against the original lock: nothing may change
// a test between them, and no other task may have locked tests in between (the revision would
// reopen a closed unit).
//
// Exit: 0 the lock holds, 1 a lock rule is broken, 2 a usage or environment error (bad arguments,
// an unresolvable --base, no git repository).

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export type LockProblemKind =
  | 'missing'
  | 'too-many'
  | 'not-test-only'
  | 'no-reason'
  | 'not-ancestor'
  | 'late-revision'
  | 'modified'
  | 'deleted'
  | 'added';

export interface LockProblem {
  kind: LockProblemKind;
  detail: string;
}

export interface LockResult {
  ok: boolean;
  problems: LockProblem[];
  lockSha: string | null;
  checked: number;
  notes: string[];
}

export interface LockOptions {
  cwd: string;
  taskId: string;
  base: string;
}

/** The original lock plus at most one revision. */
const MAX_LOCK_COMMITS = 2;

/** Test paths: what the test writer may write and what the lock protects. Forward-slash paths. */
export function isTestPath(repoPath: string): boolean {
  if (repoPath.endsWith('.test.ts') || repoPath.endsWith('.test.tsx')) return true;
  if (repoPath.endsWith('.test-helpers.ts') || repoPath.endsWith('.test-helpers.tsx')) return true;
  if (repoPath.startsWith('fixtures/') || repoPath.startsWith('e2e/')) return true;
  return isSnapshotPath(repoPath);
}

/** A file under a `__snapshots__/` directory segment. */
function isSnapshotPath(repoPath: string): boolean {
  return repoPath.split('/').slice(0, -1).includes('__snapshots__');
}

function git(cwd: string, args: readonly string[], input?: string): string {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitOk(cwd: string, args: readonly string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** NUL-separated output → entries, dropping the empty tail. */
function nulSplit(text: string): string[] {
  return text.split('\0').filter((entry) => entry !== '');
}

interface LogEntry {
  sha: string;
  locks: string[];
  reasons: string[];
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** Commits in base..HEAD, oldest first, with their Test-lock and Revision-reason trailer values. */
function commitsWithTrailers(cwd: string, base: string): LogEntry[] {
  const format = [
    '%H',
    '%(trailers:key=Test-lock,valueonly,separator=%x1d)',
    '%(trailers:key=Revision-reason,valueonly,separator=%x1d)',
  ].join(FIELD);
  const out = git(cwd, ['log', '--reverse', `--format=${format}${RECORD}`, `${base}..HEAD`]);
  const values = (field: string | undefined): string[] =>
    (field ?? '')
      .split('\x1d')
      .map((value) => value.trim())
      .filter((value) => value !== '');
  return out
    .split(RECORD)
    .map((record) => record.replace(/^\s+/, ''))
    .filter((record) => record !== '')
    .map((record) => {
      const [sha = '', locks, reasons] = record.split(FIELD);
      return { sha: sha.trim(), locks: values(locks), reasons: values(reasons) };
    });
}

/** Paths a commit adds, modifies or deletes relative to its first parent. */
function changedPaths(cwd: string, sha: string): string[] {
  return nulSplit(
    git(cwd, ['diff-tree', '-r', '--root', '--no-commit-id', '--name-only', '-z', sha]),
  );
}

/** path → blob id for every file in a tree-ish. */
function treeBlobs(cwd: string, treeish: string): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const entry of nulSplit(git(cwd, ['ls-tree', '-r', '-z', treeish]))) {
    const tab = entry.indexOf('\t');
    const [, type, blob] = entry.slice(0, tab).split(' ');
    if (type === 'blob' && blob !== undefined) blobs.set(entry.slice(tab + 1), blob);
  }
  return blobs;
}

/** path → blob id for every stage-0 index entry. */
function indexBlobs(cwd: string): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const entry of nulSplit(git(cwd, ['ls-files', '-s', '-z']))) {
    const tab = entry.indexOf('\t');
    const [, blob, stage] = entry.slice(0, tab).split(' ');
    if (stage === '0' && blob !== undefined) blobs.set(entry.slice(tab + 1), blob);
  }
  return blobs;
}

/** Untracked, not-ignored files, one path per file (never collapsed into directories). */
function untrackedPaths(cwd: string): string[] {
  return nulSplit(git(cwd, ['ls-files', '-o', '--exclude-standard', '-z']));
}

/** Blob ids of working-tree files as git would store them (path attributes applied). */
function workingBlobs(cwd: string, repoPaths: readonly string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  const present = repoPaths.filter((p) => existsSync(path.join(cwd, ...p.split('/'))));
  if (present.length === 0) return blobs;
  const ids = git(cwd, ['hash-object', '--stdin-paths'], `${present.join('\n')}\n`)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  present.forEach((p, i) => {
    const id = ids[i];
    if (id !== undefined) blobs.set(p, id);
  });
  return blobs;
}

/** Test paths -> blob ids in a tree-ish. */
function testBlobs(cwd: string, treeish: string): Map<string, string> {
  return new Map([...treeBlobs(cwd, treeish)].filter(([p]) => isTestPath(p)));
}

/**
 * Test changes from one tree to another, reported with `suffix` in each detail. New snapshot
 * files are noted instead of reported.
 */
function compareTrees(
  from: Map<string, string>,
  to: Map<string, string>,
  suffix: string,
  problems: LockProblem[],
  notes: string[],
): void {
  for (const [repoPath, blob] of from) {
    const now = to.get(repoPath);
    if (now === undefined) problems.push({ kind: 'deleted', detail: `${repoPath} (${suffix})` });
    else if (now !== blob) problems.push({ kind: 'modified', detail: `${repoPath} (${suffix})` });
  }
  for (const repoPath of [...to.keys()].sort()) {
    if (from.has(repoPath)) continue;
    if (isSnapshotPath(repoPath)) notes.push(`new snapshot ${repoPath} (${suffix}; allowed)`);
    else problems.push({ kind: 'added', detail: `${repoPath} (${suffix})` });
  }
}

export function checkLock(options: LockOptions): LockResult {
  const { cwd, taskId, base } = options;
  const problems: LockProblem[] = [];
  const notes: string[] = [];

  const commits = commitsWithTrailers(cwd, base);
  const locks = commits.filter((c) => c.locks.includes(taskId));
  const effective = locks.at(-1);
  if (effective === undefined) {
    problems.push({
      kind: 'missing',
      detail: `no commit in ${base}..HEAD has "Test-lock: ${taskId}"`,
    });
    return { ok: false, problems, lockSha: null, checked: 0, notes };
  }

  if (locks.length > MAX_LOCK_COMMITS) {
    problems.push({
      kind: 'too-many',
      detail: `${locks.length} lock commits for ${taskId}; the original plus one revision is the limit`,
    });
  }
  for (const lock of locks) {
    for (const changed of changedPaths(cwd, lock.sha)) {
      if (!isTestPath(changed)) {
        problems.push({
          kind: 'not-test-only',
          detail: `lock commit ${lock.sha.slice(0, 7)} touches ${changed}`,
        });
      }
    }
  }
  const revision = locks[1];
  if (revision !== undefined && !revision.reasons.some((reason) => reason !== '')) {
    problems.push({
      kind: 'no-reason',
      detail: `revision lock ${revision.sha.slice(0, 7)} has no "Revision-reason:" trailer`,
    });
  }
  const original = locks[0];
  if (revision !== undefined && original !== undefined) {
    // Another task's lock between the original and the revision: this unit was already closed.
    const from = commits.indexOf(original);
    const to = commits.indexOf(revision);
    const others = new Set(
      commits
        .slice(from + 1, to)
        .flatMap((c) => c.locks)
        .filter((id) => id !== taskId),
    );
    for (const other of others) {
      problems.push({
        kind: 'late-revision',
        detail: `revision ${revision.sha.slice(0, 7)} comes after task ${other}'s lock; revise only while the task is open`,
      });
    }
    // Nothing may change a test between the original lock and the revision.
    compareTrees(
      testBlobs(cwd, original.sha),
      testBlobs(cwd, `${revision.sha}^`),
      `changed before revision ${revision.sha.slice(0, 7)}`,
      problems,
      notes,
    );
  }
  if (!gitOk(cwd, ['merge-base', '--is-ancestor', effective.sha, 'HEAD'])) {
    problems.push({ kind: 'not-ancestor', detail: `${effective.sha} is not an ancestor of HEAD` });
  }

  const locked = testBlobs(cwd, effective.sha);
  const head = treeBlobs(cwd, 'HEAD');
  const index = indexBlobs(cwd);
  const untracked = untrackedPaths(cwd);
  const working = workingBlobs(cwd, [...locked.keys()]);

  for (const [repoPath, blob] of locked) {
    const where: string[] = [];
    if (!head.has(repoPath)) where.push('HEAD');
    if (!index.has(repoPath)) where.push('index');
    if (!working.has(repoPath)) where.push('working tree');
    if (where.length > 0) {
      problems.push({ kind: 'deleted', detail: `${repoPath} (missing from ${where.join(', ')})` });
      continue;
    }
    const changedIn = [
      head.get(repoPath) !== blob ? 'HEAD' : '',
      index.get(repoPath) !== blob ? 'index' : '',
      working.get(repoPath) !== blob ? 'working tree' : '',
    ].filter((w) => w !== '');
    if (changedIn.length > 0) {
      problems.push({
        kind: 'modified',
        detail: `${repoPath} (differs in ${changedIn.join(', ')})`,
      });
    }
  }

  const current = new Set([...head.keys(), ...index.keys(), ...untracked]);
  for (const repoPath of [...current].sort()) {
    if (!isTestPath(repoPath) || locked.has(repoPath)) continue;
    if (isSnapshotPath(repoPath)) {
      notes.push(`new snapshot ${repoPath} (allowed: written by the first run)`);
    } else {
      problems.push({
        kind: 'added',
        detail: `${repoPath} (not in lock commit ${effective.sha.slice(0, 7)})`,
      });
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    lockSha: effective.sha,
    checked: locked.size,
    notes,
  };
}

const USAGE = 'usage: node scripts/tests-locked.ts <task-id> [--base <ref>]';

function main(argv: readonly string[]): number {
  const [taskId, flag, ref, ...rest] = argv;
  const validBase = flag === undefined || (flag === '--base' && ref !== undefined && ref !== '');
  if (
    taskId === undefined ||
    taskId === '' ||
    taskId.startsWith('--') ||
    !validBase ||
    rest.length > 0
  ) {
    console.error(USAGE);
    return 2;
  }
  const cwd = process.cwd();
  if (!gitOk(cwd, ['rev-parse', '--git-dir'])) {
    console.error('tests-locked: not inside a git repository');
    return 2;
  }
  if (ref !== undefined && !gitOk(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) {
    console.error(`tests-locked: --base ${ref} can't be resolved to a commit`);
    return 2;
  }
  let base = ref;
  if (base === undefined) {
    try {
      base = git(cwd, ['merge-base', 'HEAD', 'origin/main']).trim();
    } catch {
      console.error('tests-locked: no merge base with origin/main; pass --base <ref>');
      return 2;
    }
  }
  let result: LockResult;
  try {
    result = checkLock({ cwd, taskId, base });
  } catch (error) {
    const message = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    console.error(`tests-locked: git failed: ${message}`);
    return 2;
  }
  for (const problem of result.problems) console.log(`LOCK ${problem.kind}: ${problem.detail}`);
  for (const note of result.notes) console.log(`note: ${note}`);
  if (!result.ok) return 1;
  const short = (result.lockSha ?? '').slice(0, 7);
  console.log(`tests-locked: ${result.checked} file(s) unchanged since ${short} (task ${taskId})`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
