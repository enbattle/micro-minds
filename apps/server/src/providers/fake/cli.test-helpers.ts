// Task 2.4, clause D7: helpers to run the fake CLI as a real child process (`node cli.ts`, argv
// array, no shell) against a loopback HTTP server the test owns (127.0.0.1, port 0).
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

/** The fake CLI under test, next to this file. */
export const CLI_PATH = path.join(import.meta.dirname, 'cli.ts');

/** Generous for Windows: node start-up plus a few loopback round trips. */
export const WAIT_MS = 20_000;
export const TEST_TIMEOUT_MS = 60_000;

export interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** How the server answers request number `n` (0-based): a status code, or never. */
export type Responder = (n: number) => number | 'hang';

export interface HookServer {
  url: string;
  port: number;
  received: Received[];
  close: () => Promise<void>;
}

export async function startHookServer(respond: Responder = () => 200): Promise<HookServer> {
  const received: Received[] = [];
  const hanging: ServerResponse[] = [];
  let count = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const answer = respond(count);
      count += 1;
      if (answer === 'hang') {
        hanging.push(res);
        return;
      }
      res.statusCode = answer;
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of hanging) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A loopback port with nothing listening on it (bound, then released). */
export async function closedPort(): Promise<number> {
  const server = await startHookServer();
  const { port } = server;
  await server.close();
  return port;
}

/** The parent's env without any MICROMINDS_ variable, so only what a test sets reaches the CLI. */
export function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith('MICROMINDS_')) env[key] = value;
  }
  return env;
}

export interface CliEnv {
  MICROMINDS_URL?: string;
  MICROMINDS_SESSION_ID?: string;
  MICROMINDS_HOOK_TOKEN?: string;
}

export interface RunningCli {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  /** stdout split into lines, CR removed. */
  lines: () => string[];
  exited: () => boolean;
  /** Resolves with the exit code (null on a signal) or rejects after `ms`. */
  exit: (ms?: number) => Promise<number | null>;
  write: (line: string) => void;
  end: () => void;
  kill: () => void;
}

export function runCli(options: {
  args?: readonly string[];
  env?: CliEnv;
  cwd?: string;
  /** Run a different script (e.g. from the adapter's launch spec). */
  argv?: readonly string[];
  extraEnv?: Record<string, string>;
}): RunningCli {
  const env = { ...baseEnv(), ...(options.env ?? {}), ...(options.extraEnv ?? {}) };
  const argv = options.argv ?? [CLI_PATH, ...(options.args ?? [])];
  const child = spawn(process.execPath, [...argv], {
    env,
    cwd: options.cwd ?? process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  let out = '';
  let err = '';
  let exitCode: number | null | undefined;
  const exitWaiters: Array<(code: number | null) => void> = [];
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    err += chunk;
  });
  // A write after the child is gone must not crash the test process.
  child.stdin?.on('error', () => {});
  child.on('exit', (code) => {
    exitCode = code;
    for (const waiter of exitWaiters) waiter(code);
  });
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    lines: () => out.split('\n').map((l) => l.replace(/\r$/, '')),
    exited: () => exitCode !== undefined,
    exit: (ms = WAIT_MS) =>
      new Promise<number | null>((resolve, reject) => {
        if (exitCode !== undefined) {
          resolve(exitCode);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error(`the fake CLI did not exit within ${ms} ms; stderr: ${err}`)),
          ms,
        );
        exitWaiters.push((code) => {
          clearTimeout(timer);
          resolve(code);
        });
      }),
    write: (line) => {
      child.stdin?.write(`${line}\n`);
    },
    end: () => {
      child.stdin?.end();
    },
    kill: () => {
      if (exitCode === undefined) child.kill();
    },
  };
}

/**
 * Polls until `check` holds. Fails early, with the CLI's stderr, if the CLI exits first, and after
 * `ms` otherwise.
 */
export async function waitFor(
  what: string,
  check: () => boolean,
  cli?: RunningCli,
  ms: number = WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (cli?.exited() === true) {
      if (check()) return;
      throw new Error(`the fake CLI exited before: ${what}; stderr: ${cli.stderr()}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${ms} ms waiting for: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Resolves after `ms`: only for asserting that nothing more arrives. */
export function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
