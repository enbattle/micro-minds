// Task 2.5: shared fixtures for the WorktreeManager tests. Every repo, home directory and
// "outside" directory lives under one fresh `fs.mkdtemp` root per test; nothing touches the
// user's real `$MICROMINDS_HOME`, and no provider CLI is run.
//
// The helpers' own git calls are hardened (fsmonitor off, an empty hooks dir, no inherited GIT_*
// variables) so the hostile-repo tests only see markers written by the manager's git commands.
// `rawGit` is the unhardened control that proves a hostile repo really is hostile.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** ULID-shaped session ids (Crockford base32, 26 chars). `sessionId(3)` → `…0003`. */
export function sessionId(n: number): string {
  return `01K6G5W0000000000000${String(n).padStart(6, '0')}`;
}

/** A fresh temporary root for one test; remove it with `removeTempRoot`. */
export function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-wt-'));
}

export function removeTempRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** The process environment without GIT_* variables (a git hook running the tests may set them). */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

const IDENTITY = [
  '-c',
  'user.name=micro-minds test',
  '-c',
  'user.email=test@micro-minds.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.autocrlf=false',
];

/** A hooks dir that never exists, so the helpers' own git calls run no hook. */
const NO_HOOKS_DIR = path.join(os.tmpdir(), `mm-wt-no-hooks-${process.pid}-absent`);

function hooksOff(): string[] {
  return ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NO_HOOKS_DIR}`];
}

/** Runs git in `cwd` with hooks and fsmonitor disabled; returns trimmed stdout. Throws on failure. */
export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...hooksOff(), ...IDENTITY, ...args], {
    cwd,
    env: cleanEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

/** Runs git without any hardening (the control for the hostile-repo tests). */
export function rawGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...IDENTITY, ...args], {
    cwd,
    env: cleanEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

/** Creates `dir` (and parents), `git init`s it and makes one commit with `README.md`. */
export function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, ['add', '--', 'README.md']);
  git(dir, ['commit', '--quiet', '-m', 'initial']);
  return dir;
}

/** Real, native, case-folded (on Windows) form of a path, for comparisons. */
export function canonical(p: string): string {
  let resolved = path.resolve(p);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // The path doesn't exist (any more); compare its resolved form.
  }
  const normalized = path.normalize(resolved);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

/** True when `child` is strictly inside `parent` (after resolving real paths). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(canonical(parent), canonical(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Worktree paths registered in the repo's `git worktree list`, main worktree included. */
export function registeredWorktrees(repo: string): string[] {
  return git(repo, ['worktree', 'list', '--porcelain'])
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

export function isRegistered(repo: string, worktreePath: string): boolean {
  return registeredWorktrees(repo).some((p) => samePath(p, worktreePath));
}

export function branchExists(repo: string, branch: string): boolean {
  try {
    git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Branches under `micro-minds/` in the repo. */
export function microMindsBranches(repo: string): string[] {
  const out = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/micro-minds/']);
  return out === '' ? [] : out.split(/\r?\n/);
}

/** Every entry (files and dirs, recursively) under `dir`; [] when `dir` doesn't exist. */
export function entriesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String);
}

/** A directory outside every root with one file in it, to prove it survives. */
export function makeBystander(dir: string): { dir: string; file: string } {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'keep-me.txt');
  fs.writeFileSync(file, 'precious\n');
  return { dir, file };
}

/**
 * A directory link: a junction on Windows (no admin rights needed), a directory symlink elsewhere
 * (Node ignores the type argument off Windows).
 */
export function linkDir(target: string, link: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'junction');
}

/** A path git's `sh` can use: forward slashes (`C:/…` works in Git for Windows' shell). */
function shPath(p: string): string {
  return p.split(path.sep).join('/');
}

function writeHook(dir: string, name: string, marker: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "${name}" >> "${shPath(marker)}"\nexit 0\n`);
  fs.chmodSync(file, 0o755);
}

const HOOK_NAMES = ['post-checkout', 'reference-transaction', 'pre-commit', 'post-index-change'];

export type HostileVariant = 'repo-hooks-dir' | 'core-hooksPath';

/**
 * Makes `repo` hostile (clause C11): `core.fsmonitor` is a shell command that appends to
 * `marker`, and hooks that append to `marker` sit either in the repo's own hooks dir or in a
 * separate `core.hooksPath` dir. Call after `initRepo`.
 */
export function makeHostile(repo: string, marker: string, variant: HostileVariant): void {
  const hooksDir =
    variant === 'repo-hooks-dir'
      ? path.join(repo, '.git', 'hooks')
      : path.join(path.dirname(repo), `${path.basename(repo)}-evil-hooks`);
  for (const name of HOOK_NAMES) writeHook(hooksDir, name, marker);
  if (variant === 'core-hooksPath') git(repo, ['config', 'core.hooksPath', hooksDir]);
  git(repo, ['config', 'core.fsmonitor', `echo fsmonitor >> "${shPath(marker)}"; false`]);
}
