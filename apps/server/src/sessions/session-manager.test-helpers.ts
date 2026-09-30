// Task 2.6: shared fixtures for the SessionManager tests. Every repo, `$MICROMINDS_HOME` and
// report lives under one fresh temp root per test. The CLIs are the fake provider's CLI or the
// probe (probe-cli.test-helpers.ts), never a real provider CLI (clause C14).
//
// Two kinds of PTY:
// - real node-pty, for what only a real process shows (cwd, env, argv, exit codes, tree kills);
// - `fakePtys()`, an in-memory IPty passed as the manager's `spawn` seam, for what must be exact
//   (every byte written to the PTY, resize calls, output batching, a spawn that throws). Its pid
//   (FAKE_PID) never exists on any OS, so a stray tree kill aimed at it hits nothing.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from '@micro-minds/shared';
import xtermHeadless from '@xterm/headless';
import type { IDisposable, IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';
import { type LogSink, logSink } from '../logging/logger.test-helpers.ts';
import { createLogger } from '../logging/logger.ts';
import { fakeAdapter } from '../providers/fake/adapter.ts';
import { baseEnv } from '../providers/fake/cli.test-helpers.ts';
import type { BinaryLookup, ProviderRegistry } from '../providers/registry.ts';
import type { LaunchContext, LaunchSpec, ProviderAdapter } from '../providers/types.ts';
import { initRepo, makeTempRoot } from '../worktrees/worktree-manager.test-helpers.ts';
import { createWorktreeManager, type WorktreeManager } from '../worktrees/worktree-manager.ts';
import { isFile, testLookup } from './lookup.test-helpers.ts';
import { createSessionManager, SessionError } from './session-manager.ts';

export { testLookup };

const { Terminal } = xtermHeadless;

export const PROBE_PATH = path.join(import.meta.dirname, 'probe-cli.test-helpers.ts');

/** Generous for Windows: node start-up in ConPTY plus git worktree creation. */
export const WAIT_MS = 20_000;
export const TEST_TIMEOUT_MS = 60_000;

/** A pid no OS hands out (above every pid_max, and not a multiple of 4 for Windows). */
export const FAKE_PID = 999_999_991;

// ---------------------------------------------------------------------------------------------
// Waiting

export async function waitUntil(
  what: string,
  check: () => boolean | Promise<boolean>,
  ms: number = WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for: ${what}`);
    await sleep(20);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True while a process with this pid exists (EPERM means it exists but isn't ours). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------------------------
// Adapters

export interface ProbeOptions {
  /** Where the probe writes `<sessionId>.json` and its companions. */
  reportDir: string;
  /** Extra probe arguments, e.g. `--spawn-child`. */
  extraArgs?: readonly string[];
  files?: LaunchSpec['files'];
  /** The bare command the registry resolves (default `node`). */
  command?: string;
  /** Replaces the whole argv (after the resolved binary). */
  args?: (ctx: LaunchContext, reportPath: string) => string[];
  /** Sees every launch context the manager builds. */
  onLaunch?: (ctx: LaunchContext) => void;
  throwOnLaunch?: boolean;
}

export function reportPathFor(reportDir: string, sessionId: string): string {
  return path.join(reportDir, `${sessionId}.json`);
}

/**
 * A `fake` provider adapter that runs the probe with `node` (or `command`). Its launch env is the
 * fake provider's: MICROMINDS_URL, MICROMINDS_SESSION_ID, MICROMINDS_HOOK_TOKEN, MICROMINDS_PROVIDER.
 */
export function probeAdapter(options: ProbeOptions): ProviderAdapter {
  return {
    ...fakeAdapter,
    binary: { command: options.command ?? 'node', versionArgs: ['--version'] },
    launch(ctx: LaunchContext): LaunchSpec {
      options.onLaunch?.(ctx);
      if (options.throwOnLaunch === true) throw new Error('launch failed on purpose');
      const reportPath = reportPathFor(options.reportDir, ctx.sessionId);
      const args = options.args?.(ctx, reportPath) ?? [
        PROBE_PATH,
        reportPath,
        ...(options.extraArgs ?? []),
        ...(ctx.firstPrompt === undefined ? [] : ['--', ctx.firstPrompt]),
      ];
      return {
        args,
        env: {
          MICROMINDS_URL: ctx.serverUrl,
          MICROMINDS_SESSION_ID: ctx.sessionId,
          MICROMINDS_HOOK_TOKEN: ctx.hookToken,
          MICROMINDS_PROVIDER: 'fake',
        },
        files: [...(options.files ?? [])],
      };
    },
  };
}

export interface ProbeReport {
  pid: number;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  columns: number | null;
  rows: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toProbeReport(value: unknown): ProbeReport {
  if (!isRecord(value)) throw new Error('probe report is not an object');
  const { pid, argv, cwd, env, columns, rows } = value;
  if (typeof pid !== 'number' || typeof cwd !== 'string') throw new Error('bad probe report');
  if (!Array.isArray(argv) || !argv.every((a): a is string => typeof a === 'string')) {
    throw new Error('bad probe argv');
  }
  const envOut: Record<string, string> = {};
  if (isRecord(env)) {
    for (const [key, v] of Object.entries(env)) if (typeof v === 'string') envOut[key] = v;
  }
  return {
    pid,
    argv,
    cwd,
    env: envOut,
    columns: typeof columns === 'number' ? columns : null,
    rows: typeof rows === 'number' ? rows : null,
  };
}

export function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Waits for the probe's report for a session and returns it. */
export async function probeReport(reportDir: string, sessionId: string): Promise<ProbeReport> {
  const file = reportPathFor(reportDir, sessionId);
  await waitUntil(`the probe report ${file}`, () => fs.existsSync(file));
  return toProbeReport(readJsonFile(file));
}

/** Waits for the probe's child report and returns the child's pid. */
export async function probeChildPid(reportDir: string, sessionId: string): Promise<number> {
  const file = `${reportPathFor(reportDir, sessionId)}.child.json`;
  await waitUntil(`the probe child report ${file}`, () => fs.existsSync(file));
  const value = readJsonFile(file);
  if (!isRecord(value) || typeof value.pid !== 'number') throw new Error('bad child report');
  return value.pid;
}

/** Everything the probe has received on stdin so far ('' when nothing). */
export function probeInput(reportDir: string, sessionId: string): string {
  const file = `${reportPathFor(reportDir, sessionId)}.input`;
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// ---------------------------------------------------------------------------------------------
// The fake PTY (the manager's `spawn` seam)

type ForkOptions = IPtyForkOptions | IWindowsPtyForkOptions;

export interface FakePty extends IPty {
  readonly file: string;
  readonly args: string[] | string;
  readonly options: ForkOptions;
  /** Every write, in order. */
  readonly writes: string[];
  /** Every resize call, as [cols, rows]. */
  readonly resizes: Array<[number, number]>;
  readonly kills: Array<string | undefined>;
  readonly exited: boolean;
  emitData(data: string): void;
  emitExit(exitCode: number, signal?: number): void;
}

export interface FakePtyOptions {
  /** Exit with this code when a write holds Ctrl-C (0x03), like a CLI that stops on Ctrl-C. */
  exitOnCtrlC?: number;
  /** Throw from spawn instead of returning a PTY. */
  throwOnSpawn?: boolean;
}

export interface FakePtys {
  spawn: (file: string, args: string[] | string, options: ForkOptions) => IPty;
  readonly ptys: FakePty[];
  /** The only PTY spawned so far (fails when there isn't exactly one). */
  only(): FakePty;
}

function emitter<T>(): {
  event: (listener: (e: T) => unknown) => IDisposable;
  fire: (e: T) => void;
} {
  const listeners = new Set<(e: T) => unknown>();
  return {
    event: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire: (e) => {
      for (const listener of [...listeners]) listener(e);
    },
  };
}

export function fakePtys(fakeOptions: FakePtyOptions = {}): FakePtys {
  const ptys: FakePty[] = [];
  const spawn = (file: string, args: string[] | string, options: ForkOptions): IPty => {
    if (fakeOptions.throwOnSpawn === true) throw new Error('spawn failed on purpose');
    const data = emitter<string>();
    const exit = emitter<{ exitCode: number; signal?: number }>();
    const writes: string[] = [];
    const resizes: Array<[number, number]> = [];
    const kills: Array<string | undefined> = [];
    let cols = options.cols ?? 80;
    let rows = options.rows ?? 24;
    let exited = false;
    const emitExit = (exitCode: number, signal?: number): void => {
      if (exited) return;
      exited = true;
      exit.fire(signal === undefined ? { exitCode } : { exitCode, signal });
    };
    const pty: FakePty = {
      file,
      args,
      options,
      writes,
      resizes,
      kills,
      get exited() {
        return exited;
      },
      pid: FAKE_PID,
      get cols() {
        return cols;
      },
      get rows() {
        return rows;
      },
      process: path.basename(file),
      handleFlowControl: false,
      onData: data.event,
      onExit: exit.event,
      resize(c: number, r: number) {
        resizes.push([c, r]);
        cols = c;
        rows = r;
      },
      clear() {},
      write(chunk: string | Buffer) {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        writes.push(text);
        if (fakeOptions.exitOnCtrlC !== undefined && text.includes('\x03')) {
          setTimeout(() => emitExit(fakeOptions.exitOnCtrlC ?? 0), 10);
        }
      },
      kill(signal?: string) {
        kills.push(signal);
        setTimeout(() => emitExit(1), 10);
      },
      pause() {},
      resume() {},
      emitData: (chunk) => {
        if (!exited) data.fire(chunk);
      },
      emitExit,
    };
    ptys.push(pty);
    return pty;
  };
  return {
    spawn,
    ptys,
    only: () => {
      const [first, ...rest] = ptys;
      if (first === undefined || rest.length > 0) {
        throw new Error(`expected exactly one PTY, got ${ptys.length}`);
      }
      return first;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The harness

export type SessionManager = ReturnType<typeof createSessionManager>;
export type ManagerConfig = Parameters<typeof createSessionManager>[0];

export interface HarnessOptions {
  /** Builds the registry; `reportDir` is where probe adapters write their reports. */
  registry: (reportDir: string) => ProviderRegistry;
  fake?: FakePtys;
  serverUrl?: string;
  env?: Record<string, string>;
  lookup?: BinaryLookup;
  stopGraceMs?: number;
  scrollback?: number;
}

export interface Harness {
  tmp: string;
  home: string;
  repo: string;
  reportDir: string;
  worktreesRoot: string;
  sessionsRoot: string;
  events: AgentEvent[];
  logs: LogSink;
  manager: SessionManager;
  /** How many times the manager asked the WorktreeManager to create a worktree. */
  worktreeCreates: () => number;
}

/** A default server URL nothing listens on; hooks fail open against it. */
export const UNUSED_SERVER_URL = 'http://127.0.0.1:9';

export function makeHarness(options: HarnessOptions): Harness {
  const tmp = makeTempRoot();
  const home = path.join(tmp, 'home');
  const repo = initRepo(path.join(tmp, 'repos', 'app'));
  const reportDir = path.join(tmp, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const events: AgentEvent[] = [];
  const logs = logSink();
  const real = createWorktreeManager({ home });
  let creates = 0;
  const worktrees: WorktreeManager = {
    ...real,
    create: (input) => {
      creates += 1;
      return real.create(input);
    },
  };
  const manager = createSessionManager({
    home,
    serverUrl: options.serverUrl ?? UNUSED_SERVER_URL,
    registry: options.registry(reportDir),
    worktrees,
    lookup: options.lookup ?? testLookup(),
    env: options.env ?? baseEnv(),
    logger: createLogger({ level: 'trace', destination: logs }),
    onEvent: (event: AgentEvent) => {
      events.push(event);
    },
    ...(options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }),
    ...(options.scrollback === undefined ? {} : { scrollback: options.scrollback }),
    ...(options.fake === undefined ? {} : { spawn: options.fake.spawn }),
  });
  return {
    tmp,
    home,
    repo,
    reportDir,
    worktreesRoot: path.join(home, 'worktrees'),
    sessionsRoot: path.join(home, 'sessions'),
    events,
    logs,
    manager,
    worktreeCreates: () => creates,
  };
}

/** Kills every session still running (real PTYs), then waits for them to end. */
export async function killAll(manager: SessionManager): Promise<void> {
  const running = manager.list().filter((s) => s.status === 'running');
  for (const session of running) {
    try {
      await manager.kill(session.id);
    } catch {
      // Already gone.
    }
  }
  await waitUntil('every session ended', () =>
    manager.list().every((s) => s.status !== 'running'),
  ).catch(() => {});
}

/** Ends every fake PTY that hasn't exited, as a CLI exiting by itself would. */
export function exitAllFakes(fake: FakePtys | undefined): void {
  for (const pty of fake?.ptys ?? []) if (!pty.exited) pty.emitExit(0);
}

/** Resolves with the error the call throws or rejects with; fails when it doesn't. */
export async function refusal(call: () => unknown): Promise<SessionError> {
  try {
    await call();
  } catch (error: unknown) {
    if (error instanceof SessionError) return error;
    throw new Error(`expected a SessionError, got: ${String(error)}`);
  }
  throw new Error('expected the call to be refused with a SessionError');
}

/** Every event of one kind for one session, in emission order. */
export function eventsOf(
  events: readonly AgentEvent[],
  sessionId: string,
  kind: string,
): AgentEvent[] {
  return events.filter((e) => e.sessionId === sessionId && e.kind === kind);
}

// ---------------------------------------------------------------------------------------------
// Terminal snapshots

export type ReplayTerminal = InstanceType<typeof Terminal>;

/** A fresh headless terminal with `data` (a serialized snapshot) written into it. */
export async function replay(data: string, cols: number, rows: number): Promise<ReplayTerminal> {
  const terminal = new Terminal({ cols, rows, scrollback: 100_000, allowProposedApi: true });
  await new Promise<void>((resolve) => terminal.write(data, resolve));
  return terminal;
}

/** The text of every line of the active buffer (scrollback included), right-trimmed. */
export function bufferLines(terminal: ReplayTerminal): string[] {
  const buffer = terminal.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buffer.length; i += 1)
    out.push(buffer.getLine(i)?.translateToString(true) ?? '');
  return out;
}

/** Polls the manager's snapshot until `accept` holds, then returns it. */
export async function snapshotWhen(
  manager: SessionManager,
  sessionId: string,
  accept: (snapshot: string) => boolean,
): Promise<string> {
  let last = '';
  await waitUntil('a snapshot with the expected content', async () => {
    last = await manager.snapshot(sessionId);
    return accept(last);
  });
  return last;
}

/** Every regular file under `dir`, recursively ([] when `dir` doesn't exist). */
export function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true })
    .map((entry) => path.join(dir, String(entry)))
    .filter((p) => isFile(p));
}
