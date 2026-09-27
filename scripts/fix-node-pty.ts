// postinstall: restore the executable bit on node-pty's macOS `spawn-helper` prebuilds.
//
// node-pty 1.1.0 publishes `prebuilds/darwin-{arm64,x64}/spawn-helper` with mode 0644, so on
// macOS every PTY spawn fails with "posix_spawnp failed". Found by CI on macos-latest; verified
// with `tar -tvzf node-pty-1.1.0.tgz`. Remove this script once an upstream release fixes it.
//
// Safe everywhere: a no-op on Windows and when node-pty or the helpers aren't installed. It never
// fails the install; problems are reported on stderr only.

import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const EXECUTABLE = 0o755;

function nodePtyDir(): string | null {
  // node-pty is a dependency of apps/server, so resolve it from there (works with hoisting).
  const serverManifest = path.resolve(import.meta.dirname, '../apps/server/package.json');
  try {
    const require = createRequire(serverManifest);
    return path.dirname(require.resolve('node-pty/package.json'));
  } catch {
    return null;
  }
}

function main(): void {
  if (process.platform === 'win32') return;
  const dir = nodePtyDir();
  if (dir === null) return;

  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    const helper = path.join(dir, 'prebuilds', arch, 'spawn-helper');
    if (!existsSync(helper)) continue;
    try {
      if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, EXECUTABLE);
    } catch (error) {
      console.error(`fix-node-pty: could not chmod ${helper}: ${String(error)}`);
    }
  }
}

main();
