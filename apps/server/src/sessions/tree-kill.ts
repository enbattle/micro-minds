// Kills a session's whole process tree (PLAN §5.5 step 5, `WIN-process-tree`): the CLI and
// everything it started. Only ever called for an explicit user stop or kill (hard rule 11).
import { execFile } from 'node:child_process';

/** Resolves when the kill has been attempted; never rejects (the tree may already be gone). */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (platform === 'win32') {
    // taskkill /T walks the parent-pid tree from the root, so it must run while the root lives.
    return new Promise((resolve) => {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () =>
        resolve(),
      );
    });
  }
  // node-pty starts the CLI as a session and process-group leader (setsid), so the negative pid
  // signals the whole group.
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // Already gone, or not ours.
    }
  }
  return Promise.resolve();
}
