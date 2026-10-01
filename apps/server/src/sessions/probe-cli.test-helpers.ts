// Task 2.6 test stand-in: a tiny CLI the SessionManager tests run in a real PTY instead of a
// provider CLI (never a real one, clause C14). It reports what it was started with, logs every
// byte it receives, and can start a child process that outlives a root-only kill.
//
//   node probe-cli.test-helpers.ts <reportPath> [--spawn-child] [other args…]
//   node probe-cli.test-helpers.ts --child <childReportPath>
//
// Main mode writes `<reportPath>` (JSON: pid, argv after this script, cwd, the MICROMINDS_* and
// MM_TEST_* env vars, the terminal size) and `<reportPath>.size.json` on every resize, puts stdin
// in raw mode (so Ctrl-C arrives as the byte 0x03, on Windows too), appends every input chunk to
// `<reportPath>.input`, ignores SIGINT, and exits with code N on the input `exit N` + Enter.
// `<reportPath>` is written last, once raw mode is on: its existence means "ready for input".
// With `--spawn-child` it first starts a child (`--child`) that ignores SIGHUP and SIGINT, writes
// `{ pid }` to `<reportPath>.child.json` and stays alive until it is killed.
//
// Arguments are found after this script's own path in argv, so it also works when an npm-style
// `.cmd` shim target imports it (`node cli.js <this script> <reportPath> …`).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function ownArgs(): string[] {
  const self = pathKey(SELF);
  const index = process.argv.findIndex((arg, i) => i > 0 && pathKey(arg) === self);
  return process.argv.slice(index === -1 ? 2 : index + 1);
}

/** Writes JSON atomically, so a polling test never reads half a file. */
function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function runChild(reportPath: string): void {
  process.on('SIGHUP', () => {});
  process.on('SIGINT', () => {});
  writeJson(reportPath, { pid: process.pid });
  setInterval(() => {}, 60_000);
}

function size(): { columns: number | null; rows: number | null } {
  return { columns: process.stdout.columns ?? null, rows: process.stdout.rows ?? null };
}

function runMain(reportPath: string, args: string[]): void {
  process.on('SIGINT', () => {});
  if (args.includes('--spawn-child')) {
    // On Windows, libuv puts non-detached children in a kill-on-close job object, so they would
    // die with the root anyway and a root-only kill would look like a tree kill. Detached, the
    // child survives the root and only a real tree kill (taskkill /T or equivalent) ends it.
    // On POSIX the child stays in the root's process group and survives the root's SIGHUP.
    spawn(process.execPath, [SELF, '--child', `${reportPath}.child.json`], {
      stdio: 'ignore',
      windowsHide: true,
      detached: process.platform === 'win32',
    });
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && /^(MICROMINDS_|MM_TEST_)/i.test(key)) env[key] = value;
  }
  process.stdout.on('resize', () => writeJson(`${reportPath}.size.json`, size()));

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  let received = '';
  process.stdin.on('data', (chunk: string) => {
    fs.appendFileSync(`${reportPath}.input`, chunk);
    received += chunk;
    // Enter is `\r` in raw mode; `\n` too, in case a tty still translates it (ICRNL).
    const match = /exit (\d+)[\r\n]/.exec(received);
    if (match !== null) process.exit(Number(match[1]));
  });
  process.stdin.on('end', () => process.exit(0));
  // The report is the readiness signal: it is written only after raw mode is on and the input
  // listener is attached, so input a test sends once the report exists is read raw (a canonical
  // tty would turn `\r` into `\n` and Ctrl-C into SIGINT instead of the byte 0x03).
  writeJson(reportPath, { pid: process.pid, argv: args, cwd: process.cwd(), env, ...size() });
  process.stdout.write('probe ready\r\n');
}

const args = ownArgs();
if (args[0] === '--child' && args[1] !== undefined) {
  runChild(args[1]);
} else if (args[0] !== undefined) {
  runMain(args[0], args);
} else {
  process.exit(64);
}
