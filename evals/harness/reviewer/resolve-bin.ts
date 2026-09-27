import path from 'node:path';

export interface ResolveOptions {
  platform: NodeJS.Platform;
  /** The PATH value (`Path` on Windows is folded into `PATH` by Node's process.env). */
  pathEnv: string | undefined;
  /** PATHEXT on Windows, e.g. `.COM;.EXE;.BAT;.CMD`. Ignored elsewhere. */
  pathExt: string | undefined;
  isFile: (candidate: string) => boolean;
}

export interface ResolvedBinary {
  path: string;
  /**
   * `.cmd`/`.bat` shims can't be spawned without a shell on Windows (Node rejects them with
   * EINVAL since the CVE-2024-27980 fix), so the caller must use `shell: true` for these.
   */
  needsShell: boolean;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Finds `name` on PATH the way the OS would, without spawning `where`/`command -v`: the same
 * code runs on every platform, no shell is involved, and it's unit-testable. On Windows each
 * PATH entry is tried with every PATHEXT extension in order, so `claude.exe` (native installer)
 * wins over `claude.cmd` (npm shim) in the same directory, as it does in cmd.exe.
 */
export function resolveOnPath(name: string, options: ResolveOptions): ResolvedBinary | undefined {
  const isWindows = options.platform === 'win32';
  const p = isWindows ? path.win32 : path.posix;
  const dirs = (options.pathEnv ?? '')
    .split(p.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '');
  const extensions = isWindows
    ? (options.pathExt ?? DEFAULT_PATHEXT)
        .split(';')
        .map((ext) => ext.trim().toLowerCase())
        .filter((ext) => ext.startsWith('.'))
    : [''];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = p.join(dir, `${name}${ext}`);
      if (options.isFile(candidate)) {
        return { path: candidate, needsShell: isWindows && (ext === '.cmd' || ext === '.bat') };
      }
    }
  }
  return undefined;
}
