// Task 2.6: the binary lookup tests hand to the SessionManager and preflight: the real PATH (with
// the running node's directory first), so `node` resolves to the node running the tests.
import fs from 'node:fs';
import path from 'node:path';
import type { BinaryLookup } from '../providers/registry.ts';

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The real PATH, with `extraDirs` first and the running node's directory next. */
export function testLookup(extraDirs: readonly string[] = []): BinaryLookup {
  const separator = process.platform === 'win32' ? ';' : ':';
  const dirs = [...extraDirs, path.dirname(process.execPath), process.env.PATH ?? ''];
  const pathExt = process.env.PATHEXT;
  return {
    platform: process.platform,
    path: dirs.join(separator),
    ...(pathExt === undefined ? {} : { pathExt }),
    isFile,
  };
}
