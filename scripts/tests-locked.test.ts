// Tests for the test lock (scripts/tests-locked.ts): after a task's tests were committed with a
// `Test-lock: <task-id>` trailer, nothing later in the task may edit, delete or add a test.
//
// Every case runs `checkLock()` against a real, throwaway git repository. Two templates are built
// once (a base commit, and the base plus a lock commit for task 2.1) and copied per test, so each
// test starts from a known repository without re-running every git command.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkLock } from './tests-locked.ts';

type LockResult = ReturnType<typeof checkLock>;
type Kind = LockResult['problems'][number]['kind'];

const SCRIPT = path.join(import.meta.dirname, 'tests-locked.ts');
const TASK = '2.1';
const TIMEOUT = 60_000;

// Committed in the base commit, before any lock.
const BASE_FILES: Record<string, string> = {
  'README.md': '# demo\n',
  '.gitignore': 'ignored/\n*.local.test.ts\nfixtures/private/\n',
  'src/impl.ts': 'export const x = 1;\n',
  'src/old.test.ts': 'old test\n', // a test path from an earlier task: part of L's tree
};

// Added by the lock commit for task 2.1. Every kind of test path appears once.
const LOCKED_FILES: Record<string, string> = {
  'src/impl.test.ts': 'impl test\n',
  'src/__snapshots__/impl.test.ts.snap': 'exports[`x`] = `1`;\n',
  'apps/web/src/App.test.tsx': 'app test\n',
  'fixtures/claude/basic.jsonl': '{"hook_event_name":"Stop"}\n',
  'fixtures/claude/with space.jsonl': '{"hook_event_name":"Notification"}\n',
  'e2e/smoke.spec.ts': 'smoke\n',
};

// Test paths in L's tree for the locked template: the old test plus every locked file.
const LOCKED_CHECKED = 1 + Object.keys(LOCKED_FILES).length;

let root = '';
let gitEnv: NodeJS.ProcessEnv = {};
let baseTemplate = '';
let lockedTemplate = '';
let baseSha = '';
let lockSha = '';

function content(rel: string): string {
  const text = LOCKED_FILES[rel] ?? BASE_FILES[rel];
  if (text === undefined) throw new Error(`no fixture content for ${rel}`);
  return text;
}

function abs(repo: string, rel: string): string {
  return path.join(repo, ...rel.split('/'));
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    env: gitEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(repo: string, rel: string, text: string): void {
  const file = abs(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function remove(repo: string, rel: string): void {
  fs.rmSync(abs(repo, rel), { recursive: true });
}

/** Stages everything (`git add -A`) and commits; each message is one paragraph (`-m`). */
function commitAll(repo: string, ...messages: string[]): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', ...messages.flatMap((m) => ['-m', m]));
  return git(repo, 'rev-parse', 'HEAD');
}

function lockCommit(repo: string, taskId: string, ...extraTrailers: string[]): string {
  return commitAll(
    repo,
    `test: lock tests for ${taskId}`,
    [`Test-lock: ${taskId}`, ...extraTrailers].join('\n'),
  );
}

function copyOf(template: string): string {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  fs.cpSync(template, dir, { recursive: true });
  return dir;
}

function check(repo: string, taskId = TASK, base = baseSha): LockResult {
  const result = checkLock({ cwd: repo, taskId, base });
  // Rule 8: `ok` is true exactly when `problems` is empty, in every result.
  expect(result.ok).toBe(result.problems.length === 0);
  return result;
}

function kinds(result: LockResult): Kind[] {
  return [...new Set(result.problems.map((p) => p.kind))].sort();
}

function expectProblem(result: LockResult, kind: Kind, repoPath: string): void {
  expect(result.problems).toContainEqual({ kind, detail: expect.stringContaining(repoPath) });
}

function expectClean(result: LockResult): void {
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tests-locked-'));

  // Isolate the test's own git calls from the user's and the system's git config and from any
  // GIT_* variables of an enclosing git process (e.g. when run from a git hook).
  const emptyConfig = path.join(root, 'empty.gitconfig');
  fs.writeFileSync(emptyConfig, '');
  gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };

  baseTemplate = path.join(root, 'base-template');
  fs.mkdirSync(baseTemplate);
  git(baseTemplate, 'init', '-q');
  git(baseTemplate, 'config', 'user.name', 'Test Writer');
  git(baseTemplate, 'config', 'user.email', 'test-writer@example.invalid');
  git(baseTemplate, 'config', 'core.autocrlf', 'false');
  git(baseTemplate, 'config', 'commit.gpgsign', 'false');
  for (const [rel, text] of Object.entries(BASE_FILES)) write(baseTemplate, rel, text);
  baseSha = commitAll(baseTemplate, 'chore: initial commit');

  lockedTemplate = path.join(root, 'locked-template');
  fs.cpSync(baseTemplate, lockedTemplate, { recursive: true });
  for (const [rel, text] of Object.entries(LOCKED_FILES)) write(lockedTemplate, rel, text);
  lockSha = lockCommit(lockedTemplate, TASK);
}, TIMEOUT);

afterAll(() => {
  if (root !== '') fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('the locked template, untouched', () => {
  it(
    'is ok, reports L as lockSha, counts every test path in L and no notes',
    () => {
      const result = check(copyOf(lockedTemplate));
      expectClean(result);
      expect(result.lockSha).toBe(lockSha);
      expect(result.lockSha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.checked).toBe(LOCKED_CHECKED);
      expect(result.notes).toEqual([]);
    },
    TIMEOUT,
  );
});

describe('rule 1: missing', () => {
  const rows: Array<{ name: string; taskId: string; setup: (repo: string) => void }> = [
    {
      name: 'no lock commit at all',
      taskId: TASK,
      setup: (repo) => {
        write(repo, 'src/impl.test.ts', 'test\n');
        commitAll(repo, 'test: add tests without a trailer');
      },
    },
    {
      name: 'a lock for 2.14 does not match task 2.1',
      taskId: '2.1',
      setup: (repo) => {
        write(repo, 'src/impl.test.ts', 'test\n');
        lockCommit(repo, '2.14');
      },
    },
    {
      name: 'a lock for 2.1 does not match task 2.14',
      taskId: '2.14',
      setup: (repo) => {
        write(repo, 'src/impl.test.ts', 'test\n');
        lockCommit(repo, '2.1');
      },
    },
    {
      name: 'a Test-lock line in the body, not in the trailer block, is not a trailer',
      taskId: TASK,
      setup: (repo) => {
        write(repo, 'src/impl.test.ts', 'test\n');
        commitAll(repo, 'test: add tests', `Test-lock: ${TASK}`, 'Prose after the line.');
      },
    },
  ];

  it.each(rows)(
    '$name → missing, lockSha null, checked 0',
    ({ taskId, setup }) => {
      const repo = copyOf(baseTemplate);
      setup(repo);
      const result = check(repo, taskId);
      expect(kinds(result)).toEqual(['missing']);
      expect(result.ok).toBe(false);
      expect(result.lockSha).toBeNull();
      expect(result.checked).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'a lock commit outside base..HEAD (base = the lock itself) → missing',
    () => {
      const result = check(copyOf(lockedTemplate), TASK, lockSha);
      expect(kinds(result)).toEqual(['missing']);
      expect(result.lockSha).toBeNull();
    },
    TIMEOUT,
  );
});

describe('lock commit matching', () => {
  it(
    'Test-lock among other trailers still matches',
    () => {
      const repo = copyOf(baseTemplate);
      write(repo, 'src/impl.test.ts', 'test\n');
      const sha = lockCommit(repo, TASK, 'Co-Authored-By: Someone <someone@example.invalid>');
      const result = check(repo);
      expectClean(result);
      expect(result.lockSha).toBe(sha);
    },
    TIMEOUT,
  );

  it(
    'a task id with a letter (4a.3) matches exactly',
    () => {
      const repo = copyOf(baseTemplate);
      write(repo, 'src/impl.test.ts', 'test\n');
      const sha = lockCommit(repo, '4a.3');
      const result = check(repo, '4a.3');
      expectClean(result);
      expect(result.lockSha).toBe(sha);
    },
    TIMEOUT,
  );

  it(
    "another task's later lock (2.14) is not taken as 2.1's lock",
    () => {
      const repo = copyOf(lockedTemplate);
      write(repo, 'src/other.test.ts', 'other\n');
      const otherSha = lockCommit(repo, '2.14');
      const other = check(repo, '2.14');
      expect(other.lockSha).toBe(otherSha);
      // For 2.1, src/other.test.ts was added after 2.1's lock.
      const result = check(repo, TASK);
      expect(result.lockSha).toBe(lockSha);
      expectProblem(result, 'added', 'src/other.test.ts');
    },
    TIMEOUT,
  );

  it(
    'non-lock commits between base and the lock are fine',
    () => {
      const repo = copyOf(baseTemplate);
      write(repo, 'src/impl.ts', 'export const x = 2;\n');
      commitAll(repo, 'refactor: prepare');
      write(repo, 'src/impl.test.ts', 'test\n');
      const sha = lockCommit(repo, TASK);
      const result = check(repo);
      expectClean(result);
      expect(result.lockSha).toBe(sha);
    },
    TIMEOUT,
  );
});

describe('rule 2: too-many, and the effective lock', () => {
  it(
    'a revision lock with a reason becomes the effective lock',
    () => {
      const repo = copyOf(lockedTemplate);
      write(repo, 'src/impl.test.ts', 'impl test, revised\n');
      write(repo, 'src/extra.test.ts', 'extra\n');
      const revision = lockCommit(repo, TASK, 'Revision-reason: the spec changed the event name');
      const result = check(repo);
      expectClean(result);
      expect(result.lockSha).toBe(revision);
      expect(result.checked).toBe(LOCKED_CHECKED + 1);
    },
    TIMEOUT,
  );

  it(
    'after a revision, edits are compared with the revision, not the original lock',
    () => {
      const repo = copyOf(lockedTemplate);
      write(repo, 'src/impl.test.ts', 'impl test, revised\n');
      lockCommit(repo, TASK, 'Revision-reason: the spec changed');
      write(repo, 'src/impl.test.ts', content('src/impl.test.ts')); // back to the original lock
      const result = check(repo);
      expectProblem(result, 'modified', 'src/impl.test.ts');
    },
    TIMEOUT,
  );

  it(
    'three lock commits for the task → too-many',
    () => {
      const repo = copyOf(lockedTemplate);
      write(repo, 'src/impl.test.ts', 'revision 1\n');
      lockCommit(repo, TASK, 'Revision-reason: first revision');
      write(repo, 'src/impl.test.ts', 'revision 2\n');
      lockCommit(repo, TASK, 'Revision-reason: second revision');
      const result = check(repo);
      expect(kinds(result)).toContain('too-many');
      expect(result.ok).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "locks for other tasks don't count toward the limit",
    () => {
      const repo = copyOf(lockedTemplate);
      write(repo, 'src/impl.test.ts', 'revision 1\n');
      lockCommit(repo, TASK, 'Revision-reason: first revision');
      lockCommit(repo, '2.14');
      lockCommit(repo, '2.10');
      expectClean(check(repo));
    },
    TIMEOUT,
  );
});

describe('rule 4: no-reason', () => {
  const rows: Array<{ name: string; trailers: string[]; firstReason: boolean; ok: boolean }> = [
    { name: 'revision without Revision-reason', trailers: [], firstReason: false, ok: false },
    {
      name: 'revision with an empty Revision-reason',
      trailers: ['Revision-reason:'],
      firstReason: false,
      ok: false,
    },
    {
      name: 'reason on the original lock only, not on the revision',
      trailers: [],
      firstReason: true,
      ok: false,
    },
    {
      name: 'revision with a Revision-reason text',
      trailers: ['Revision-reason: fixture was recorded against the wrong CLI version'],
      firstReason: false,
      ok: true,
    },
  ];

  it.each(rows)(
    '$name → ok is $ok',
    ({ trailers, firstReason, ok }) => {
      const repo = copyOf(baseTemplate);
      write(repo, 'src/impl.test.ts', 'original\n');
      lockCommit(repo, TASK, ...(firstReason ? ['Revision-reason: not needed here'] : []));
      write(repo, 'src/impl.test.ts', 'revised\n');
      lockCommit(repo, TASK, ...trailers);
      const result = check(repo);
      if (ok) {
        expectClean(result);
      } else {
        expect(kinds(result)).toEqual(['no-reason']);
      }
    },
    TIMEOUT,
  );

  it(
    'the original lock needs no Revision-reason',
    () => {
      expectClean(check(copyOf(lockedTemplate)));
    },
    TIMEOUT,
  );
});

describe('rule 3: not-test-only (the test-path pattern)', () => {
  const rows: Array<{ name: string; file: string; test: boolean }> = [
    { name: '.test.ts', file: 'src/a.test.ts', test: true },
    { name: '.test.tsx', file: 'apps/web/src/B.test.tsx', test: true },
    { name: 'a __snapshots__/ file', file: 'src/__snapshots__/a.test.ts.snap', test: true },
    { name: 'a fixtures/ file', file: 'fixtures/claude/x.jsonl', test: true },
    { name: 'a non-jsonl fixtures/ file', file: 'fixtures/README.md', test: true },
    { name: 'an e2e/ spec', file: 'e2e/a.spec.ts', test: true },
    { name: 'an e2e/ helper', file: 'e2e/helpers/util.ts', test: true },
    { name: 'source file', file: 'src/a.ts', test: false },
    { name: '.test.js', file: 'src/a.test.js', test: false },
    { name: '.spec.ts outside e2e/', file: 'src/a.spec.ts', test: false },
    { name: '.test.ts.bak', file: 'src/a.test.ts.bak', test: false },
    { name: 'fixtures/ not at the root', file: 'src/fixtures/y.json', test: false },
    { name: 'e2e/ not at the root', file: 'docs/e2e/x.md', test: false },
    { name: 'e2e- prefix without the slash', file: 'e2e-helpers/x.ts', test: false },
    { name: '__snapshots__ without a segment slash', file: 'src/__snapshots__.ts', test: false },
    // Addendum B4: test helpers are test paths.
    {
      name: 'a .test-helpers.ts helper',
      file: 'apps/server/src/providers/fake.test-helpers.ts',
      test: true,
    },
    {
      name: 'a .test-helpers.tsx helper',
      file: 'apps/web/src/render.test-helpers.tsx',
      test: true,
    },
    { name: 'test-helpers.ts without the dot segment', file: 'src/test-helpers.ts', test: false },
    { name: '.test-helpers.js', file: 'src/a.test-helpers.js', test: false },
    { name: '.test-helpers.ts.bak', file: 'src/a.test-helpers.ts.bak', test: false },
  ];

  it.each(rows)(
    'lock commit adding $file ($name) → test path: $test',
    ({ file, test }) => {
      const repo = copyOf(baseTemplate);
      write(repo, 'src/impl.test.ts', 'test\n');
      write(repo, file, 'content\n');
      lockCommit(repo, TASK);
      const result = check(repo);
      if (test) {
        expectClean(result);
      } else {
        expect(kinds(result)).toEqual(['not-test-only']);
        expectProblem(result, 'not-test-only', file);
      }
    },
    TIMEOUT,
  );

  it(
    'reports each non-test path a lock commit modifies or deletes',
    () => {
      const repo = copyOf(baseTemplate);
      write(repo, 'src/impl.test.ts', 'test\n');
      write(repo, 'src/impl.ts', 'export const x = 2;\n');
      remove(repo, 'README.md');
      lockCommit(repo, TASK);
      const result = check(repo);
      expect(kinds(result)).toEqual(['not-test-only']);
      expectProblem(result, 'not-test-only', 'src/impl.ts');
      expectProblem(result, 'not-test-only', 'README.md');
      expect(result.problems.filter((p) => p.kind === 'not-test-only')).toHaveLength(2);
    },
    TIMEOUT,
  );

  it(
    'a revision lock touching a non-test path → not-test-only',
    () => {
      const repo = copyOf(lockedTemplate);
      write(repo, 'src/impl.test.ts', 'revised\n');
      write(repo, 'src/impl.ts', 'export const x = 3;\n');
      lockCommit(repo, TASK, 'Revision-reason: the spec changed');
      const result = check(repo);
      expect(kinds(result)).toEqual(['not-test-only']);
      expectProblem(result, 'not-test-only', 'src/impl.ts');
    },
    TIMEOUT,
  );
});

type Scenario = { name: string; act: (repo: string) => void; paths: string[] };

describe('rule 6: modified', () => {
  const rows: Scenario[] = [
    {
      name: 'committed edit',
      act: (repo) => {
        write(repo, 'src/impl.test.ts', 'weakened\n');
        commitAll(repo, 'feat: implement');
      },
      paths: ['src/impl.test.ts'],
    },
    {
      name: 'staged-only edit',
      act: (repo) => {
        write(repo, 'src/impl.test.ts', 'weakened\n');
        git(repo, 'add', 'src/impl.test.ts');
      },
      paths: ['src/impl.test.ts'],
    },
    {
      name: 'unstaged-only edit',
      act: (repo) => write(repo, 'src/impl.test.ts', 'weakened\n'),
      paths: ['src/impl.test.ts'],
    },
    {
      name: 'staged edit, working tree put back (index differs)',
      act: (repo) => {
        write(repo, 'src/impl.test.ts', 'weakened\n');
        git(repo, 'add', 'src/impl.test.ts');
        write(repo, 'src/impl.test.ts', content('src/impl.test.ts'));
      },
      paths: ['src/impl.test.ts'],
    },
    {
      name: 'committed edit, working tree put back unstaged (HEAD differs)',
      act: (repo) => {
        write(repo, 'src/impl.test.ts', 'weakened\n');
        commitAll(repo, 'feat: implement');
        write(repo, 'src/impl.test.ts', content('src/impl.test.ts'));
      },
      paths: ['src/impl.test.ts'],
    },
    {
      name: 'edit to a test that predates the lock',
      act: (repo) => write(repo, 'src/old.test.ts', 'changed\n'),
      paths: ['src/old.test.ts'],
    },
    {
      name: 'edit to a .test.tsx',
      act: (repo) => write(repo, 'apps/web/src/App.test.tsx', 'changed\n'),
      paths: ['apps/web/src/App.test.tsx'],
    },
    {
      name: 'edit to a fixture whose name has a space',
      act: (repo) => write(repo, 'fixtures/claude/with space.jsonl', '{}\n'),
      paths: ['fixtures/claude/with space.jsonl'],
    },
    {
      name: 'edit to an e2e file',
      act: (repo) => write(repo, 'e2e/smoke.spec.ts', 'changed\n'),
      paths: ['e2e/smoke.spec.ts'],
    },
    {
      name: 'edit to an existing snapshot (the new-snapshot exception does not apply)',
      act: (repo) => {
        write(repo, 'src/__snapshots__/impl.test.ts.snap', 'exports[`x`] = `2`;\n');
        commitAll(repo, 'feat: implement, update snapshot');
      },
      paths: ['src/__snapshots__/impl.test.ts.snap'],
    },
    {
      name: 'LF → CRLF with no text attributes is a real content change',
      act: (repo) =>
        write(repo, 'src/impl.test.ts', content('src/impl.test.ts').replaceAll('\n', '\r\n')),
      paths: ['src/impl.test.ts'],
    },
    {
      name: 'two edited tests are each reported',
      act: (repo) => {
        write(repo, 'src/impl.test.ts', 'weakened\n');
        write(repo, 'fixtures/claude/basic.jsonl', '{}\n');
      },
      paths: ['src/impl.test.ts', 'fixtures/claude/basic.jsonl'],
    },
  ];

  it.each(rows)(
    '$name → modified',
    ({ act, paths }) => {
      const repo = copyOf(lockedTemplate);
      act(repo);
      const result = check(repo);
      expect(kinds(result)).toEqual(['modified']);
      for (const p of paths) expectProblem(result, 'modified', p);
      expect(result.lockSha).toBe(lockSha);
      expect(result.checked).toBe(LOCKED_CHECKED);
    },
    TIMEOUT,
  );
});

describe('rule 6: deleted', () => {
  const rows: Scenario[] = [
    {
      name: 'committed deletion',
      act: (repo) => {
        git(repo, 'rm', '-q', 'src/impl.test.ts');
        commitAll(repo, 'feat: implement');
      },
      paths: ['src/impl.test.ts'],
    },
    {
      name: 'staged deletion (git rm, not committed)',
      act: (repo) => git(repo, 'rm', '-q', 'src/impl.test.ts'),
      paths: ['src/impl.test.ts'],
    },
    {
      name: 'removed from the index only (file left untracked in the working tree)',
      act: (repo) => git(repo, 'rm', '-q', '--cached', 'src/impl.test.ts'),
      paths: ['src/impl.test.ts'],
    },
    {
      name: 'unstaged deletion from the working tree',
      act: (repo) => remove(repo, 'src/impl.test.ts'),
      paths: ['src/impl.test.ts'],
    },
    {
      name: 'deleted snapshot',
      act: (repo) => remove(repo, 'src/__snapshots__/impl.test.ts.snap'),
      paths: ['src/__snapshots__/impl.test.ts.snap'],
    },
    {
      name: 'a whole fixtures directory removed',
      act: (repo) => remove(repo, 'fixtures'),
      paths: ['fixtures/claude/basic.jsonl', 'fixtures/claude/with space.jsonl'],
    },
  ];

  it.each(rows)(
    '$name → deleted',
    ({ act, paths }) => {
      const repo = copyOf(lockedTemplate);
      act(repo);
      const result = check(repo);
      expect(result.ok).toBe(false);
      expect(kinds(result)).toContain('deleted');
      expect(kinds(result)).not.toContain('added');
      for (const p of paths) expectProblem(result, 'deleted', p);
    },
    TIMEOUT,
  );

  it(
    'a committed rename of a test → deleted old path and added new path',
    () => {
      const repo = copyOf(lockedTemplate);
      git(repo, 'mv', 'src/impl.test.ts', 'src/renamed.test.ts');
      commitAll(repo, 'refactor: rename');
      const result = check(repo);
      expectProblem(result, 'deleted', 'src/impl.test.ts');
      expectProblem(result, 'added', 'src/renamed.test.ts');
    },
    TIMEOUT,
  );
});

describe('rule 6: added', () => {
  const rows: Scenario[] = [
    {
      name: 'committed new test',
      act: (repo) => {
        write(repo, 'src/more.test.ts', 'more\n');
        commitAll(repo, 'feat: implement');
      },
      paths: ['src/more.test.ts'],
    },
    {
      name: 'staged new test',
      act: (repo) => {
        write(repo, 'src/more.test.ts', 'more\n');
        git(repo, 'add', 'src/more.test.ts');
      },
      paths: ['src/more.test.ts'],
    },
    {
      name: 'untracked new test',
      act: (repo) => write(repo, 'src/more.test.ts', 'more\n'),
      paths: ['src/more.test.ts'],
    },
    {
      name: 'untracked new test inside a new untracked directory',
      act: (repo) => write(repo, 'src/newdir/deep/more.test.ts', 'more\n'),
      paths: ['src/newdir/deep/more.test.ts'],
    },
    {
      name: 'untracked new .test.tsx',
      act: (repo) => write(repo, 'apps/web/src/Board.test.tsx', 'board\n'),
      paths: ['apps/web/src/Board.test.tsx'],
    },
    {
      name: 'untracked new fixture',
      act: (repo) => write(repo, 'fixtures/claude/new.jsonl', '{}\n'),
      paths: ['fixtures/claude/new.jsonl'],
    },
    {
      name: 'committed new e2e file',
      act: (repo) => {
        write(repo, 'e2e/extra.spec.ts', 'extra\n');
        commitAll(repo, 'feat: implement');
      },
      paths: ['e2e/extra.spec.ts'],
    },
  ];

  it.each(rows)(
    '$name → added',
    ({ act, paths }) => {
      const repo = copyOf(lockedTemplate);
      act(repo);
      const result = check(repo);
      expect(kinds(result)).toEqual(['added']);
      for (const p of paths) expectProblem(result, 'added', p);
      // Added paths are not in L's tree, so they are not counted as compared.
      expect(result.checked).toBe(LOCKED_CHECKED);
    },
    TIMEOUT,
  );
});

describe('rule 6: new snapshot files are allowed and noted', () => {
  const rows: Scenario[] = [
    {
      name: 'untracked new snapshot',
      act: (repo) => write(repo, 'src/__snapshots__/reduce.test.ts.snap', 'snap\n'),
      paths: ['src/__snapshots__/reduce.test.ts.snap'],
    },
    {
      name: 'staged new snapshot',
      act: (repo) => {
        write(repo, 'src/__snapshots__/reduce.test.ts.snap', 'snap\n');
        git(repo, 'add', 'src/__snapshots__/reduce.test.ts.snap');
      },
      paths: ['src/__snapshots__/reduce.test.ts.snap'],
    },
    {
      name: 'committed new snapshot in a new __snapshots__ directory',
      act: (repo) => {
        write(repo, 'apps/web/src/__snapshots__/App.test.tsx.snap', 'snap\n');
        commitAll(repo, 'feat: implement');
      },
      paths: ['apps/web/src/__snapshots__/App.test.tsx.snap'],
    },
    {
      name: 'two new snapshots',
      act: (repo) => {
        write(repo, 'src/__snapshots__/a.test.ts.snap', 'a\n');
        write(repo, 'packages/shared/src/__snapshots__/b.test.ts.snap', 'b\n');
      },
      paths: [
        'src/__snapshots__/a.test.ts.snap',
        'packages/shared/src/__snapshots__/b.test.ts.snap',
      ],
    },
  ];

  it.each(rows)(
    '$name → ok, recorded in notes',
    ({ act, paths }) => {
      const repo = copyOf(lockedTemplate);
      act(repo);
      const result = check(repo);
      expectClean(result);
      for (const p of paths) {
        expect(result.notes.some((note) => note.includes(p))).toBe(true);
      }
    },
    TIMEOUT,
  );
});

describe('rules 6 and 7: changes that are fine', () => {
  const rows: Array<Omit<Scenario, 'paths'>> = [
    {
      name: 'non-test files committed, staged, unstaged, untracked and deleted after L',
      act: (repo) => {
        write(repo, 'src/impl.ts', 'export const x = 2;\n');
        write(repo, 'src/new.ts', 'export const y = 1;\n');
        remove(repo, 'README.md');
        commitAll(repo, 'feat: implement');
        write(repo, 'src/impl.ts', 'export const x = 3;\n');
        write(repo, 'src/staged.ts', 'staged\n');
        git(repo, 'add', 'src/staged.ts');
        write(repo, 'docs/notes.md', 'untracked\n');
      },
    },
    {
      name: 'git-ignored test paths (ignored dir, ignored pattern, ignored fixtures dir)',
      act: (repo) => {
        write(repo, 'ignored/x.test.ts', 'ignored\n');
        write(repo, 'src/scratch.local.test.ts', 'ignored\n');
        write(repo, 'fixtures/private/raw.jsonl', 'ignored\n');
      },
    },
    {
      name: 'a locked test rewritten with identical content',
      act: (repo) => write(repo, 'src/impl.test.ts', content('src/impl.test.ts')),
    },
    {
      name: 'a test edited and reverted in later commits (only the current state counts)',
      act: (repo) => {
        write(repo, 'src/impl.test.ts', 'weakened\n');
        commitAll(repo, 'feat: try');
        write(repo, 'src/impl.test.ts', content('src/impl.test.ts'));
        commitAll(repo, 'revert: put the test back');
      },
    },
  ];

  it.each(rows)(
    '$name → ok',
    ({ act }) => {
      const repo = copyOf(lockedTemplate);
      act(repo);
      const result = check(repo);
      expectClean(result);
      expect(result.checked).toBe(LOCKED_CHECKED);
      expect(result.lockSha).toBe(lockSha);
    },
    TIMEOUT,
  );

  it(
    'CRLF from checkout conversion (text eol=crlf) is not a modification',
    () => {
      const repo = copyOf(baseTemplate);
      write(repo, '.gitattributes', '*.ts text eol=crlf\n');
      commitAll(repo, 'chore: line endings');
      write(repo, 'src/crlf.test.ts', 'line one\r\nline two\r\n');
      const sha = lockCommit(repo, TASK);
      // Let git itself write the file back out through its checkout conversion.
      remove(repo, 'src/crlf.test.ts');
      git(repo, 'checkout', '--', 'src/crlf.test.ts');

      expect(fs.readFileSync(abs(repo, 'src/crlf.test.ts'), 'utf8')).toContain('\r\n');
      expect(git(repo, 'cat-file', '-p', `${sha}:src/crlf.test.ts`)).not.toContain('\r');

      const result = check(repo);
      expectClean(result);
      expect(result.lockSha).toBe(sha);
      expect(result.checked).toBe(2); // src/old.test.ts and src/crlf.test.ts
    },
    TIMEOUT,
  );
});

describe('addendum B4: test helpers are locked like tests', () => {
  const HELPER_TS = 'apps/server/src/providers/fake.test-helpers.ts';
  const HELPER_TSX = 'apps/web/src/render.test-helpers.tsx';

  /** Base plus a lock commit containing a test and two helpers; returns the repo. */
  function lockedWithHelpers(): string {
    const repo = copyOf(baseTemplate);
    write(repo, 'src/impl.test.ts', 'impl test\n');
    write(repo, HELPER_TS, 'export const fake = 1;\n');
    write(repo, HELPER_TSX, 'export const render = 1;\n');
    lockCommit(repo, TASK);
    return repo;
  }

  it(
    'a lock with helpers, untouched → ok, helpers counted in checked',
    () => {
      const result = check(lockedWithHelpers());
      expectClean(result);
      // src/old.test.ts, src/impl.test.ts and the two helpers.
      expect(result.checked).toBe(4);
    },
    TIMEOUT,
  );

  const changed: Array<Scenario & { kind: Kind }> = [
    {
      name: 'unstaged edit to a .test-helpers.ts',
      act: (repo) => write(repo, HELPER_TS, 'export const fake = 2;\n'),
      paths: [HELPER_TS],
      kind: 'modified',
    },
    {
      name: 'committed edit to a .test-helpers.tsx',
      act: (repo) => {
        write(repo, HELPER_TSX, 'export const render = 2;\n');
        commitAll(repo, 'feat: implement');
      },
      paths: [HELPER_TSX],
      kind: 'modified',
    },
    {
      name: 'deleted .test-helpers.ts',
      act: (repo) => remove(repo, HELPER_TS),
      paths: [HELPER_TS],
      kind: 'deleted',
    },
  ];

  it.each(changed)(
    '$name → $kind',
    ({ act, paths, kind }) => {
      const repo = lockedWithHelpers();
      act(repo);
      const result = check(repo);
      expect(kinds(result)).toEqual([kind]);
      for (const p of paths) expectProblem(result, kind, p);
    },
    TIMEOUT,
  );

  const added: Scenario[] = [
    {
      name: 'untracked new .test-helpers.ts',
      act: (repo) => write(repo, 'src/new.test-helpers.ts', 'export const h = 1;\n'),
      paths: ['src/new.test-helpers.ts'],
    },
    {
      name: 'committed new .test-helpers.tsx',
      act: (repo) => {
        write(repo, 'apps/web/src/new.test-helpers.tsx', 'export const h = 1;\n');
        commitAll(repo, 'feat: implement');
      },
      paths: ['apps/web/src/new.test-helpers.tsx'],
    },
  ];

  it.each(added)(
    '$name after the lock → added',
    ({ act, paths }) => {
      const repo = copyOf(lockedTemplate);
      act(repo);
      const result = check(repo);
      expect(kinds(result)).toEqual(['added']);
      for (const p of paths) expectProblem(result, 'added', p);
    },
    TIMEOUT,
  );

  it(
    'test-helpers.ts without the dot segment, added after the lock → ok (not a test path)',
    () => {
      const repo = copyOf(lockedTemplate);
      write(repo, 'src/test-helpers.ts', 'export const h = 1;\n');
      write(repo, 'test-helpers.ts', 'export const h = 1;\n');
      const result = check(repo);
      expectClean(result);
      expect(result.checked).toBe(LOCKED_CHECKED);
    },
    TIMEOUT,
  );
});

describe('addendum A1: test changes between the original lock and a revision', () => {
  const REVISED_FIXTURE = 'fixtures/claude/basic.jsonl';

  /** Runs `before` on a copy of the locked template (L1), then commits a revision lock (L2). */
  function revise(before: (repo: string) => void): { repo: string; revision: string } {
    const repo = copyOf(lockedTemplate);
    before(repo);
    write(repo, REVISED_FIXTURE, '{"hook_event_name":"SubagentStop"}\n');
    const revision = lockCommit(repo, TASK, 'Revision-reason: the fixture was re-recorded');
    return { repo, revision };
  }

  function hasBeforeRevision(result: LockResult, kind: Kind, repoPath: string): boolean {
    return result.problems.some(
      (p) => p.kind === kind && p.detail.includes(repoPath) && p.detail.includes('before revision'),
    );
  }

  const rows: Array<{ name: string; before: (repo: string) => void; kind: Kind; path: string }> = [
    {
      name: 'a locked test edited in an implementation commit',
      before: (repo) => {
        write(repo, 'src/impl.test.ts', 'weakened\n');
        commitAll(repo, 'feat: implement');
      },
      kind: 'modified',
      path: 'src/impl.test.ts',
    },
    {
      name: 'a test that predates the lock edited in an implementation commit',
      before: (repo) => {
        write(repo, 'src/old.test.ts', 'weakened\n');
        commitAll(repo, 'feat: implement');
      },
      kind: 'modified',
      path: 'src/old.test.ts',
    },
    {
      name: 'an existing snapshot edited in an implementation commit',
      before: (repo) => {
        write(repo, 'src/__snapshots__/impl.test.ts.snap', 'exports[`x`] = `2`;\n');
        commitAll(repo, 'feat: implement');
      },
      kind: 'modified',
      path: 'src/__snapshots__/impl.test.ts.snap',
    },
    {
      name: 'a locked test deleted in an implementation commit',
      before: (repo) => {
        git(repo, 'rm', '-q', 'e2e/smoke.spec.ts');
        commitAll(repo, 'feat: implement');
      },
      kind: 'deleted',
      path: 'e2e/smoke.spec.ts',
    },
    {
      name: 'a new test added in an implementation commit',
      before: (repo) => {
        write(repo, 'src/sneaky.test.ts', 'sneaky\n');
        commitAll(repo, 'feat: implement');
      },
      kind: 'added',
      path: 'src/sneaky.test.ts',
    },
    {
      name: 'a new .test-helpers.ts added in an implementation commit',
      before: (repo) => {
        write(repo, 'src/sneaky.test-helpers.ts', 'export const h = 1;\n');
        commitAll(repo, 'feat: implement');
      },
      kind: 'added',
      path: 'src/sneaky.test-helpers.ts',
    },
  ];

  it.each(rows)(
    '$name, then a revision → $kind, detail says before revision',
    ({ before, kind, path: repoPath }) => {
      const { repo, revision } = revise(before);
      const result = check(repo);
      expect(kinds(result)).toEqual([kind]);
      expect(hasBeforeRevision(result, kind, repoPath)).toBe(true);
      expect(result.lockSha).toBe(revision);
    },
    TIMEOUT,
  );

  it(
    'a new snapshot committed before the revision → ok, recorded in notes',
    () => {
      const snap = 'src/__snapshots__/reduce.test.ts.snap';
      const { repo } = revise((r) => {
        write(r, snap, 'snap\n');
        commitAll(r, 'feat: implement');
      });
      const result = check(repo);
      expectClean(result);
      expect(result.notes.some((note) => note.includes(snap))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'a test edited and put back before the revision → ok (guards existing behavior)',
    () => {
      const { repo } = revise((r) => {
        write(r, 'src/impl.test.ts', 'weakened\n');
        commitAll(r, 'feat: try');
        write(r, 'src/impl.test.ts', content('src/impl.test.ts'));
        commitAll(r, 'revert: put the test back');
      });
      expectClean(check(repo));
    },
    TIMEOUT,
  );

  it(
    'only non-test commits before the revision → ok (guards existing behavior)',
    () => {
      const { repo } = revise((r) => {
        write(r, 'src/impl.ts', 'export const x = 2;\n');
        commitAll(r, 'feat: implement');
      });
      expectClean(check(repo));
    },
    TIMEOUT,
  );

  it(
    'A3: a change before the revision and a change after it are both reported',
    () => {
      const { repo } = revise((r) => {
        write(r, 'src/impl.test.ts', 'weakened\n');
        commitAll(r, 'feat: implement');
      });
      write(repo, 'e2e/smoke.spec.ts', 'changed after the revision\n');
      const result = check(repo);
      expect(kinds(result)).toEqual(['modified']);
      expect(hasBeforeRevision(result, 'modified', 'src/impl.test.ts')).toBe(true);
      expect(
        result.problems.some(
          (p) =>
            p.kind === 'modified' &&
            p.detail.includes('e2e/smoke.spec.ts') &&
            !p.detail.includes('before revision'),
        ),
      ).toBe(true);
    },
    TIMEOUT,
  );
});

describe('addendum A2: late-revision', () => {
  const rows: Array<{ name: string; between: (repo: string) => void; other: string | null }> = [
    {
      name: 'a lock for 2.2 between the original and the revision',
      between: (repo) => lockCommit(repo, '2.2'),
      other: '2.2',
    },
    {
      name: 'a lock for 2.14 (a prefix-like id) between the original and the revision',
      between: (repo) => lockCommit(repo, '2.14'),
      other: '2.14',
    },
    {
      name: 'a Test-lock: 2.2 line in the body, not the trailer block',
      between: (repo) => commitAll(repo, 'chore: notes', 'Test-lock: 2.2', 'Prose after the line.'),
      other: null,
    },
    {
      name: 'only non-lock commits between the original and the revision',
      between: (repo) => {
        write(repo, 'src/impl.ts', 'export const x = 2;\n');
        commitAll(repo, 'feat: implement');
      },
      other: null,
    },
  ];

  it.each(rows)(
    '$name → late-revision for: $other',
    ({ between, other }) => {
      const repo = copyOf(lockedTemplate);
      between(repo);
      write(repo, 'src/impl.test.ts', 'impl test, revised\n');
      lockCommit(repo, TASK, 'Revision-reason: the spec changed');
      const result = check(repo);
      if (other === null) {
        expectClean(result);
      } else {
        expect(kinds(result)).toEqual(['late-revision']);
        const late = result.problems.filter((p) => p.kind === 'late-revision');
        expect(late).toHaveLength(1);
        expect(late[0]?.detail).toContain(other);
      }
    },
    TIMEOUT,
  );

  it(
    "another task's lock before the original lock → no late-revision (guards existing behavior)",
    () => {
      const repo = copyOf(baseTemplate);
      write(repo, 'src/zero.test.ts', 'zero\n');
      lockCommit(repo, '2.0');
      write(repo, 'src/impl.test.ts', 'original\n');
      lockCommit(repo, TASK);
      write(repo, 'src/impl.test.ts', 'revised\n');
      lockCommit(repo, TASK, 'Revision-reason: the spec changed');
      expectClean(check(repo));
    },
    TIMEOUT,
  );
});

describe('addendum D: lock commits can not be merges', () => {
  const SIDE = 'side';

  function currentBranch(repo: string): string {
    return git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  }

  /**
   * Creates branch `side` at `from`, runs `onSide` there (it commits), switches back to the branch
   * that was checked out before, and merges `side` with a real `git merge --no-ff`. Each message is
   * one paragraph (`-m`), so a `Test-lock:` trailer can be given as the last one. Returns the
   * merge commit's sha.
   */
  function mergeSide(
    repo: string,
    from: string,
    onSide: (repo: string) => void,
    ...messages: string[]
  ): string {
    const home = currentBranch(repo);
    git(repo, 'checkout', '-q', '-b', SIDE, from);
    onSide(repo);
    git(repo, 'checkout', '-q', home);
    git(repo, 'merge', '-q', '--no-ff', SIDE, ...messages.flatMap((m) => ['-m', m]));
    const sha = git(repo, 'rev-parse', 'HEAD');
    // The commit really is a merge: two parents.
    expect(git(repo, 'rev-list', '--parents', '-n', '1', sha).split(' ')).toHaveLength(3);
    return sha;
  }

  function mergeLocks(result: LockResult): LockResult['problems'] {
    return result.problems.filter((p) => p.kind === 'merge-lock');
  }

  const lockMessage = (taskId: string, ...extraTrailers: string[]): string[] => [
    `test: lock tests for ${taskId}`,
    [`Test-lock: ${taskId}`, ...extraTrailers].join('\n'),
  ];

  it(
    'D1: the original lock is a merge of a test-only side branch → exactly one merge-lock naming its short sha',
    () => {
      const repo = copyOf(baseTemplate);
      const merge = mergeSide(
        repo,
        baseSha,
        (r) => {
          write(r, 'src/impl.test.ts', 'impl test\n');
          commitAll(r, 'test: write tests on a side branch');
        },
        ...lockMessage(TASK),
      );
      const result = check(repo);
      expect(kinds(result)).toEqual(['merge-lock']);
      expect(result.ok).toBe(false);
      const found = mergeLocks(result);
      expect(found).toHaveLength(1);
      expect(found[0]?.detail).toContain(merge.slice(0, 7));
    },
    TIMEOUT,
  );

  it(
    'D1: the original lock is a merge whose side branch changed a non-test file → merge-lock reported',
    () => {
      const repo = copyOf(baseTemplate);
      const merge = mergeSide(
        repo,
        baseSha,
        (r) => {
          write(r, 'src/impl.test.ts', 'impl test\n');
          write(r, 'src/impl.ts', 'export const x = 2;\n');
          commitAll(r, 'feat: tests and implementation together');
        },
        ...lockMessage(TASK),
      );
      const result = check(repo);
      expect(result.ok).toBe(false);
      const found = mergeLocks(result);
      expect(found).toHaveLength(1);
      expect(found[0]?.detail).toContain(merge.slice(0, 7));
    },
    TIMEOUT,
  );

  const revisionRows: Array<{ name: string; onSide: (repo: string) => void }> = [
    {
      name: 'a side branch that revised a locked test',
      onSide: (r) => {
        write(r, 'src/impl.test.ts', 'impl test, revised\n');
        commitAll(r, 'test: revise on a side branch');
      },
    },
    {
      name: 'a side branch whose implementation commit weakened a locked test',
      onSide: (r) => {
        write(r, 'src/impl.ts', 'export const x = 2;\n');
        write(r, 'src/impl.test.ts', 'weakened\n');
        commitAll(r, 'feat: implement');
      },
    },
    {
      name: 'a side branch that added a new test',
      onSide: (r) => {
        write(r, 'src/extra.test.ts', 'extra\n');
        commitAll(r, 'test: add on a side branch');
      },
    },
  ];

  it.each(revisionRows)(
    'D1: the revision is a merge of $name → one merge-lock naming the revision, not the original',
    ({ onSide }) => {
      const repo = copyOf(lockedTemplate);
      const revision = mergeSide(
        repo,
        lockSha,
        onSide,
        ...lockMessage(TASK, 'Revision-reason: the spec changed'),
      );
      const result = check(repo);
      expect(result.ok).toBe(false);
      const found = mergeLocks(result);
      expect(found).toHaveLength(1);
      expect(found[0]?.detail).toContain(revision.slice(0, 7));
      expect(found[0]?.detail).not.toContain(lockSha.slice(0, 7));
    },
    TIMEOUT,
  );

  it(
    'D1: both the original and the revision are merges → one merge-lock for each',
    () => {
      const repo = copyOf(baseTemplate);
      const original = mergeSide(
        repo,
        baseSha,
        (r) => {
          write(r, 'src/impl.test.ts', 'impl test\n');
          commitAll(r, 'test: write tests on a side branch');
        },
        ...lockMessage(TASK),
      );
      git(repo, 'branch', '-q', '-D', SIDE);
      const revision = mergeSide(
        repo,
        original,
        (r) => {
          write(r, 'src/impl.test.ts', 'impl test, revised\n');
          commitAll(r, 'test: revise on a side branch');
        },
        ...lockMessage(TASK, 'Revision-reason: the spec changed'),
      );
      const result = check(repo);
      expect(kinds(result)).toContain('merge-lock');
      const found = mergeLocks(result);
      expect(found).toHaveLength(2);
      expect(found.some((p) => p.detail.includes(original.slice(0, 7)))).toBe(true);
      expect(found.some((p) => p.detail.includes(revision.slice(0, 7)))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "D1: a merge carrying another task's Test-lock is not this task's merge-lock",
    () => {
      const repo = copyOf(lockedTemplate);
      mergeSide(
        repo,
        lockSha,
        (r) => {
          write(r, 'src/other.test.ts', 'other\n');
          commitAll(r, 'test: other task on a side branch');
        },
        ...lockMessage('2.14'),
      );
      const result = check(repo, TASK);
      expect(kinds(result)).not.toContain('merge-lock');
      expect(result.lockSha).toBe(lockSha);
    },
    TIMEOUT,
  );

  const nonLockRows: Array<{
    name: string;
    onSide: (repo: string) => void;
    kind: Kind | null;
    path: string;
  }> = [
    {
      name: 'the base branch merged in with only non-test changes',
      onSide: (r) => {
        write(r, 'src/upstream.ts', 'export const u = 1;\n');
        commitAll(r, 'feat: upstream work');
      },
      kind: null,
      path: '',
    },
    {
      name: 'the base branch merged in, bringing a new test',
      onSide: (r) => {
        write(r, 'src/upstream.test.ts', 'upstream\n');
        commitAll(r, 'test: upstream test');
      },
      kind: 'added',
      path: 'src/upstream.test.ts',
    },
    {
      name: 'the base branch merged in, editing a test that predates the lock',
      onSide: (r) => {
        write(r, 'src/old.test.ts', 'changed upstream\n');
        commitAll(r, 'test: upstream edit');
      },
      kind: 'modified',
      path: 'src/old.test.ts',
    },
  ];

  it.each(nonLockRows)(
    'D2: after the lock, $name (a non-lock merge) → no merge-lock; existing rules give: $kind',
    ({ onSide, kind, path: repoPath }) => {
      const repo = copyOf(lockedTemplate);
      mergeSide(repo, baseSha, onSide, `Merge branch '${SIDE}'`);
      const result = check(repo);
      expect(result.lockSha).toBe(lockSha);
      if (kind === null) {
        expectClean(result);
      } else {
        expect(kinds(result)).toEqual([kind]);
        expectProblem(result, kind, repoPath);
      }
    },
    TIMEOUT,
  );

  it(
    'D2: a non-lock merge before a single-parent lock → ok (guards existing behavior)',
    () => {
      const repo = copyOf(baseTemplate);
      mergeSide(
        repo,
        baseSha,
        (r) => {
          write(r, 'src/prep.ts', 'export const p = 1;\n');
          commitAll(r, 'refactor: prepare');
        },
        `Merge branch '${SIDE}'`,
      );
      write(repo, 'src/impl.test.ts', 'impl test\n');
      const sha = lockCommit(repo, TASK);
      const result = check(repo);
      expectClean(result);
      expect(result.lockSha).toBe(sha);
    },
    TIMEOUT,
  );

  it(
    'D3: CLI, a merge lock is a lock violation → exit 1 and a LOCK merge-lock line with the short sha',
    () => {
      const repo = copyOf(baseTemplate);
      const merge = mergeSide(
        repo,
        baseSha,
        (r) => {
          write(r, 'src/impl.test.ts', 'impl test\n');
          commitAll(r, 'test: write tests on a side branch');
        },
        ...lockMessage(TASK),
      );
      const child = spawnSync(process.execPath, [SCRIPT, TASK, '--base', baseSha], {
        cwd: repo,
        env: gitEnv,
        encoding: 'utf8',
      });
      expect(child.status).toBe(1);
      const lines = `${child.stdout}\n${child.stderr}`.split(/\r?\n/);
      expect(
        lines.some(
          (line) => line.startsWith('LOCK merge-lock: ') && line.includes(merge.slice(0, 7)),
        ),
      ).toBe(true);
    },
    TIMEOUT,
  );
});

describe('CLI', () => {
  function run(
    cwd: string,
    args: string[],
    env: NodeJS.ProcessEnv = gitEnv,
  ): { status: number | null; out: string; err: string } {
    const child = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: 'utf8' });
    return { status: child.status, out: child.stdout, err: child.stderr };
  }

  /** Addendum C5–C8: a CLI error that is not a lock violation. */
  function expectCliError(res: { status: number | null; out: string; err: string }): string {
    expect(res.status).toBe(2);
    const lines = res.err.split(/\r?\n/).filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(1);
    expect(`${res.out}\n${res.err}`).not.toMatch(/^\s+at /m);
    expect(res.out).not.toMatch(/^LOCK /m);
    return lines[0] ?? '';
  }

  it.each([
    { name: 'an unknown ref name', ref: 'does-not-exist' },
    { name: 'an ancestor that does not exist', ref: 'HEAD~99' },
    { name: 'a full sha of no object', ref: '0'.repeat(40) },
  ])(
    'C5: --base $name → exit 2, one stderr line naming the ref, no stack trace',
    ({ ref }) => {
      const line = expectCliError(run(copyOf(lockedTemplate), [TASK, '--base', ref]));
      expect(line).toContain(ref);
      expect(line).toMatch(/resolv/i);
    },
    TIMEOUT,
  );

  it(
    'C6: no --base and no origin remote → exit 2, one stderr line saying to pass --base',
    () => {
      const line = expectCliError(run(copyOf(lockedTemplate), [TASK]));
      expect(line).toContain('--base');
    },
    TIMEOUT,
  );

  it(
    'C7: run outside any git repository → exit 2, one stderr line saying so, no stack trace',
    () => {
      const outside = fs.mkdtempSync(path.join(root, 'not-a-repo-'));
      const env = { ...gitEnv, GIT_CEILING_DIRECTORIES: path.dirname(root) };
      // The directory really is outside any repository for git.
      const probe = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: outside, env });
      expect(probe.status).not.toBe(0);
      const line = expectCliError(run(outside, [TASK, '--base', 'HEAD'], env));
      expect(line).toMatch(/git repositor/i);
    },
    TIMEOUT,
  );

  it(
    'C8: a late-revision is a lock violation → exit 1 and a LOCK late-revision line',
    () => {
      const repo = copyOf(lockedTemplate);
      lockCommit(repo, '2.2');
      write(repo, 'src/impl.test.ts', 'impl test, revised\n');
      lockCommit(repo, TASK, 'Revision-reason: the spec changed');
      const { status, out, err } = run(repo, [TASK, '--base', baseSha]);
      expect(status).toBe(1);
      expect(`${out}\n${err}`).toMatch(/^LOCK late-revision: .*2\.2/m);
    },
    TIMEOUT,
  );

  it(
    'exit 0 and a summary line when the lock holds',
    () => {
      const { status, out } = run(copyOf(lockedTemplate), [TASK, '--base', baseSha]);
      expect(status).toBe(0);
      const match =
        /^tests-locked: (\d+) file\(s\) unchanged since ([0-9a-f]{7,40}) \(task 2\.1\)$/m.exec(out);
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe(String(LOCKED_CHECKED));
      expect(lockSha.startsWith(match?.[2] ?? 'no-sha')).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'exit 1 and a LOCK modified line when a locked test changed',
    () => {
      const repo = copyOf(lockedTemplate);
      write(repo, 'src/impl.test.ts', 'weakened\n');
      const { status, out, err } = run(repo, [TASK, '--base', baseSha]);
      expect(status).toBe(1);
      expect(`${out}\n${err}`).toMatch(/^LOCK modified: .*src\/impl\.test\.ts/m);
    },
    TIMEOUT,
  );

  it(
    'exit 1 and a LOCK missing line when there is no lock commit',
    () => {
      const { status, out, err } = run(copyOf(baseTemplate), [TASK, '--base', baseSha]);
      expect(status).toBe(1);
      expect(`${out}\n${err}`).toMatch(/^LOCK missing: /m);
    },
    TIMEOUT,
  );

  it.each([
    { name: 'no arguments', args: [] },
    { name: '--base without a ref', args: [TASK, '--base'] },
  ])(
    'exit 2 and usage on stderr: $name',
    ({ args }) => {
      const { status, err } = run(copyOf(lockedTemplate), args);
      expect(status).toBe(2);
      expect(err).toMatch(/usage/i);
    },
    TIMEOUT,
  );
});
