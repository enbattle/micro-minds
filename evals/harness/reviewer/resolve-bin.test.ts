import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveOnPath } from './resolve-bin.ts';

function onDisk(...files: string[]): (candidate: string) => boolean {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (candidate) => set.has(candidate.toLowerCase());
}

describe('resolveOnPath on Windows', () => {
  const base = { platform: 'win32' as const, pathExt: '.COM;.EXE;.BAT;.CMD' };
  const dirs = ['C:\\Users\\user\\.local\\bin', 'C:\\Users\\user\\AppData\\Roaming\\npm'];
  const pathEnv = dirs.join(path.win32.delimiter);

  it('prefers .exe over .cmd in the same directory (PATHEXT order)', () => {
    const exe = path.win32.join(dirs[0] ?? '', 'claude.exe');
    const cmd = path.win32.join(dirs[0] ?? '', 'claude.cmd');
    expect(resolveOnPath('claude', { ...base, pathEnv, isFile: onDisk(cmd, exe) })).toEqual({
      path: exe,
      needsShell: false,
    });
  });

  it('respects PATH order over extension order', () => {
    const cmd = path.win32.join(dirs[0] ?? '', 'claude.cmd');
    const exe = path.win32.join(dirs[1] ?? '', 'claude.exe');
    expect(resolveOnPath('claude', { ...base, pathEnv, isFile: onDisk(cmd, exe) })).toEqual({
      path: cmd,
      needsShell: true,
    });
  });

  it('strips quotes around PATH entries and skips empty ones', () => {
    const exe = path.win32.join('C:\\Program Files\\Claude', 'claude.exe');
    const quoted = `;"C:\\Program Files\\Claude";`;
    expect(resolveOnPath('claude', { ...base, pathEnv: quoted, isFile: onDisk(exe) })?.path).toBe(
      exe,
    );
  });

  it('falls back to the default PATHEXT', () => {
    const exe = path.win32.join(dirs[0] ?? '', 'claude.exe');
    const options = { platform: 'win32' as const, pathEnv, pathExt: undefined };
    expect(resolveOnPath('claude', { ...options, isFile: onDisk(exe) })?.path).toBe(exe);
  });
});

describe('resolveOnPath on POSIX', () => {
  it('finds the bare name and never needs a shell', () => {
    const bin = '/home/user/.local/bin/claude';
    const result = resolveOnPath('claude', {
      platform: 'linux',
      pathEnv: '/usr/bin:/home/user/.local/bin',
      pathExt: '.EXE',
      isFile: onDisk(bin),
    });
    expect(result).toEqual({ path: bin, needsShell: false });
  });

  it('returns undefined when missing or PATH is unset', () => {
    const options = { platform: 'darwin' as const, pathExt: undefined, isFile: () => false };
    expect(resolveOnPath('claude', { ...options, pathEnv: '/usr/bin' })).toBeUndefined();
    expect(resolveOnPath('claude', { ...options, pathEnv: undefined })).toBeUndefined();
  });
});
