// The one way the server runs git (PLAN task 2.5, threat model "Worktree manager"). A repo the
// user points us at may be hostile: its config can name an fsmonitor command or a hooks
// directory, and plain `git status` or `git worktree add` would run them. So every command:
// - runs from an argv array with no shell, so paths are never parsed as shell syntax;
// - turns fsmonitor off and points the hooks path at the null device, where no hook can exist
//   (command-line `-c` beats the repo's own config);
// - drops inherited GIT_* variables (config/git-env.ts).
// Callers put `--` before path arguments.
import { execFile } from 'node:child_process';
import os from 'node:os';
import { gitEnv } from '../config/git-env.ts';

export const GIT_HARDENING: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${os.devNull}`,
];

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; stderr: string; spawnError: boolean };

/** Runs hardened git in `cwd`. Never throws: failures come back as `ok: false`. */
export function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        [...GIT_HARDENING, ...args],
        {
          cwd,
          env: gitEnv(),
          encoding: 'utf8',
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ ok: true, stdout });
            return;
          }
          // A numeric code is git's exit status; anything else (ENOENT for a missing cwd or git
          // binary, a timeout signal) means git never ran to completion.
          resolve({ ok: false, stderr: stderr.trim(), spawnError: typeof error.code !== 'number' });
        },
      );
    } catch (error: unknown) {
      resolve({ ok: false, stderr: String(error), spawnError: true });
    }
  });
}
