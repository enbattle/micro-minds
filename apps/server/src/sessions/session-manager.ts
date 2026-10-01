// SessionManager (PLAN §5.5, D13, D16, D21, D29): one PTY per agent session, in its own worktree.
//
// - create: the provider's binary (through the registry; a `.cmd` shim runs its real target,
//   binary.ts), a worktree, a fresh hook token, the adapter's launch files in
//   `$MICROMINDS_HOME/sessions/<id>/`, then the PTY with the inherited env plus the launch env.
//   The token only ever travels in the PTY env (D13); `verifyHookToken` checks it in constant
//   time against that session's token only.
// - Output feeds a headless xterm (the server-side scrollback, D16) and subscribers, batched
//   in ~16 ms windows. The headless xterm's replies to terminal queries are never read, so only
//   the browser's terminal answers the CLI.
// - The manager writes to a PTY only for user input and for the stop sequence (hard rule 12).
// - Stop: Ctrl-C, a grace period, then a tree kill. Kill: the tree kill at once. Worktrees are
//   always kept (hard rule 11); the launch files are deleted when the CLI exits.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type AgentEvent,
  EVENT_SCHEMA_VERSION,
  type EventKind,
  type Provider,
} from '@micro-minds/shared';
import xtermSerialize from '@xterm/addon-serialize';
import xtermHeadless from '@xterm/headless';
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';
import * as nodePty from 'node-pty';
import { newUlid } from '../ids.ts';
import type { Logger } from '../logging/logger.ts';
import type { BinaryLookup, ProviderRegistry } from '../providers/registry.ts';
import type { LaunchContext, LaunchSpec } from '../providers/types.ts';
import type { WorktreeManager } from '../worktrees/worktree-manager.ts';
import { launchTarget } from './binary.ts';
import { killTree } from './tree-kill.ts';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;

export const SESSION_ERROR_CODES = [
  'unknown_provider',
  'binary_not_found',
  'unsupported_binary',
  'invalid_size',
  'unknown_session',
  'not_running',
  'launch_failed',
  'spawn_failed',
] as const;

export type SessionErrorCode = (typeof SESSION_ERROR_CODES)[number];

export class SessionError extends Error {
  readonly code: SessionErrorCode;

  constructor(code: SessionErrorCode, message: string) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

export type SessionStatus = 'running' | 'ended';
export type EndReason = 'exit' | 'user_stop' | 'user_kill';

export interface Session {
  id: string;
  provider: Provider;
  worktreePath: string;
  branch: string;
  pid: number;
  status: SessionStatus;
  exitCode?: number;
  endReason?: EndReason;
}

export type PtySpawn = (
  file: string,
  args: string[] | string,
  options: IPtyForkOptions | IWindowsPtyForkOptions,
) => IPty;

export interface SessionManagerConfig {
  /** `$MICROMINDS_HOME`. */
  home: string;
  /** The loopback base URL hooks post to. */
  serverUrl: string;
  registry: ProviderRegistry;
  worktrees: WorktreeManager;
  /** PATH lookup for provider binaries (from config; never `process.env` here). */
  lookup: BinaryLookup;
  /** The environment CLIs inherit (from config). */
  env: Readonly<Record<string, string>>;
  logger: Logger;
  onEvent: (event: AgentEvent) => void;
  /** How long `stop` waits after Ctrl-C before killing the tree. */
  stopGraceMs?: number;
  /** Lines of headless-xterm scrollback per session. */
  scrollback?: number;
  /** node-pty's spawn, replaceable in tests. */
  spawn?: PtySpawn;
}

export interface CreateSessionInput {
  provider: Provider;
  repoPath: string;
  firstPrompt?: string;
  cols: number;
  rows: number;
}

export type OutputListener = (data: string) => void;

export const DEFAULT_STOP_GRACE_MS = 5_000;
export const DEFAULT_SCROLLBACK = 5_000;
/** The output batching window (PLAN §8). */
export const OUTPUT_BATCH_MS = 16;
export const MAX_COLS = 1_000;
export const MAX_ROWS = 500;
/** Claude Code exits on a second Ctrl-C within about a second. */
const SECOND_CTRL_C_MS = 300;
/** How long to wait for the exit event after a tree kill. */
const EXIT_WAIT_MS = 5_000;
/** How long the tree kill gets to end the PTY before the PTY's own kill is used. */
const KILL_SETTLE_MS = 1_000;

interface Live {
  session: Session;
  pty: IPty;
  terminal: InstanceType<typeof Terminal>;
  serializer: InstanceType<typeof SerializeAddon>;
  listeners: Set<OutputListener>;
  pending: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** SHA-256 of the hook token: compared in constant time, and the token itself isn't kept. */
  tokenHash: Buffer;
  files: string[];
  log: Logger;
  requestedEnd: EndReason | undefined;
  exited: Promise<void>;
}

function validSize(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 1 &&
    rows >= 1 &&
    cols <= MAX_COLS &&
    rows <= MAX_ROWS
  );
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** A plain file name: no separators, no `.`/`..`, so a launch file lands in the session dir. */
function isPlainFileName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    path.basename(name) === name &&
    path.win32.basename(name) === name &&
    !name.includes('\0')
  );
}

export function createSessionManager(config: SessionManagerConfig) {
  const sessions = new Map<string, Live>();
  const spawn: PtySpawn = config.spawn ?? nodePty.spawn;
  const stopGraceMs = config.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const scrollback = config.scrollback ?? DEFAULT_SCROLLBACK;
  const sessionsRoot = path.resolve(config.home, 'sessions');
  // Compared against for an unknown session, so a miss costs the same as a wrong token.
  const decoyHash = hashToken(randomBytes(32).toString('base64url'));

  function emit(session: Session, kind: EventKind): void {
    const event: AgentEvent = {
      v: EVENT_SCHEMA_VERSION,
      id: newUlid(),
      ts: Date.now(),
      sessionId: session.id,
      provider: session.provider,
      agentId: session.id,
      kind,
    };
    try {
      config.onEvent(event);
    } catch (error: unknown) {
      config.logger.error({ sessionId: session.id, err: error }, 'event listener failed');
    }
  }

  function live(id: string): Live {
    const found = sessions.get(id);
    if (found === undefined) throw new SessionError('unknown_session', `Unknown session: ${id}`);
    return found;
  }

  function running(id: string): Live {
    const found = live(id);
    if (found.session.status !== 'running') {
      throw new SessionError('not_running', `Session ${id} is not running`);
    }
    return found;
  }

  function flush(entry: Live): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    const data = entry.pending;
    entry.pending = '';
    if (data === '') return;
    for (const listener of [...entry.listeners]) {
      try {
        listener(data);
      } catch (error: unknown) {
        entry.log.warn({ err: error }, 'output listener failed');
      }
    }
  }

  async function removeFiles(files: readonly string[], log: Logger): Promise<void> {
    for (const file of files) {
      try {
        await fs.rm(file, { force: true });
      } catch (error: unknown) {
        log.warn({ err: error, file }, 'could not delete a launch file');
      }
    }
  }

  async function writeFiles(dir: string, spec: LaunchSpec): Promise<string[]> {
    const written: string[] = [];
    if (spec.files.length === 0) return written;
    await fs.mkdir(dir, { recursive: true });
    for (const file of spec.files) {
      if (!isPlainFileName(file.name)) {
        throw new SessionError(
          'launch_failed',
          `Launch file name is not a plain name: ${file.name}`,
        );
      }
      const target = path.join(dir, file.name);
      await fs.writeFile(target, file.content, { encoding: 'utf8', mode: 0o600 });
      written.push(target);
    }
    return written;
  }

  async function create(input: CreateSessionInput): Promise<Session> {
    const { provider, repoPath, firstPrompt, cols, rows } = input;
    if (!validSize(cols, rows)) {
      throw new SessionError('invalid_size', `Invalid terminal size ${cols}×${rows}`);
    }
    const adapter = config.registry.get(provider);
    if (adapter === undefined) {
      throw new SessionError('unknown_provider', `Unknown provider: ${provider}`);
    }
    const resolved = config.registry.resolveBinary(provider, config.lookup);
    if (!resolved.ok) {
      throw new SessionError(
        'binary_not_found',
        `${adapter.binary.command} (provider ${provider}) was not found on PATH`,
      );
    }
    const target = launchTarget(resolved, config.lookup);
    if (!target.ok) throw new SessionError('unsupported_binary', target.reason);

    const id = newUlid();
    const log = config.logger.child({ sessionId: id });
    log.info({ provider, binary: target.file }, 'creating session');
    const worktree = await config.worktrees.create({ repoPath, sessionId: id });
    log.info({ worktreePath: worktree.path, branch: worktree.branch }, 'worktree created');

    const hookToken = randomBytes(32).toString('base64url');
    const sessionDir = path.join(sessionsRoot, id);
    const ctx: LaunchContext = {
      sessionId: id,
      serverUrl: config.serverUrl,
      hookToken,
      sessionDir,
      worktreePath: worktree.path,
      ...(firstPrompt === undefined ? {} : { firstPrompt }),
    };
    let spec: LaunchSpec;
    try {
      spec = adapter.launch(ctx);
    } catch (error: unknown) {
      log.error({ err: error }, 'the adapter could not build the launch; the worktree is kept');
      throw new SessionError('launch_failed', `Provider ${provider} could not build its launch`);
    }

    let files: string[] = [];
    let pty: IPty;
    try {
      files = await writeFiles(sessionDir, spec);
      pty = spawn(target.file, [...target.prefixArgs, ...spec.args], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: worktree.path,
        env: { ...config.env, ...spec.env },
      });
    } catch (error: unknown) {
      await removeFiles(files, log);
      log.error({ err: error }, 'the CLI could not be started; the worktree is kept');
      if (error instanceof SessionError) throw error;
      throw new SessionError('spawn_failed', `Could not start ${target.file}`);
    }

    const terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    // terminal.onData (its replies to DSR, DA and other queries) is deliberately never
    // subscribed: only the browser's terminal answers the CLI (ADR 0016).

    const session: Session = {
      id,
      provider,
      worktreePath: worktree.path,
      branch: worktree.branch,
      pid: pty.pid,
      status: 'running',
    };
    let resolveExit: () => void = () => {};
    const entry: Live = {
      session,
      pty,
      terminal,
      serializer,
      listeners: new Set(),
      pending: '',
      timer: undefined,
      tokenHash: hashToken(hookToken),
      files,
      log,
      requestedEnd: undefined,
      exited: new Promise((resolve) => {
        resolveExit = resolve;
      }),
    };
    sessions.set(id, entry);

    pty.onData((data) => {
      terminal.write(data);
      entry.pending += data;
      entry.timer ??= setTimeout(() => flush(entry), OUTPUT_BATCH_MS);
    });
    pty.onExit(({ exitCode }) => {
      flush(entry);
      session.status = 'ended';
      session.exitCode = exitCode;
      session.endReason = entry.requestedEnd ?? 'exit';
      log.info({ exitCode, endReason: session.endReason }, 'session ended');
      // A non-zero exit of its own is a crash (PLAN §5.4); a user stop or kill never is.
      emit(
        session,
        session.endReason === 'exit' && exitCode !== 0 ? 'session.crashed' : 'session.ended',
      );
      void removeFiles(entry.files, log);
      resolveExit();
    });

    log.info({ pid: pty.pid, cols, rows }, 'session started');
    emit(session, 'session.started');
    return { ...session };
  }

  async function waitForExit(entry: Live, ms: number): Promise<boolean> {
    if (entry.session.status !== 'running') return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const done = await Promise.race([entry.exited.then(() => true as const), timeout]);
    clearTimeout(timer);
    return done;
  }

  async function terminate(entry: Live): Promise<void> {
    entry.log.info({ pid: entry.session.pid }, 'killing the process tree');
    await killTree(entry.session.pid);
    // The PTY's own kill only as a fallback: on Windows it enumerates the console's processes,
    // which fails noisily once the tree kill has already ended them.
    if (await waitForExit(entry, KILL_SETTLE_MS)) return;
    try {
      entry.pty.kill();
    } catch {
      // Already gone.
    }
    await waitForExit(entry, EXIT_WAIT_MS);
  }

  return {
    create,

    get(id: string): Session | undefined {
      const found = sessions.get(id);
      return found === undefined ? undefined : { ...found.session };
    },

    list(): Session[] {
      return [...sessions.values()].map((entry) => ({ ...entry.session }));
    },

    async write(id: string, data: string): Promise<void> {
      running(id).pty.write(data);
    },

    async resize(id: string, cols: number, rows: number): Promise<void> {
      const entry = running(id);
      if (!validSize(cols, rows)) {
        throw new SessionError('invalid_size', `Invalid terminal size ${cols}×${rows}`);
      }
      entry.pty.resize(cols, rows);
      entry.terminal.resize(cols, rows);
      entry.log.debug({ cols, rows }, 'resized');
    },

    /** The serialized headless xterm: what a reconnecting browser repaints from. */
    async snapshot(id: string): Promise<string> {
      const entry = live(id);
      await new Promise<void>((resolve) => entry.terminal.write('', resolve));
      return entry.serializer.serialize();
    },

    onOutput(id: string, listener: OutputListener): () => void {
      const entry = live(id);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },

    /** Constant time, and only against this session's own token (D13). Never throws. */
    verifyHookToken(id: string, token: string): boolean {
      const entry = sessions.get(id);
      const presented = hashToken(typeof token === 'string' ? token : '');
      const expected = entry?.tokenHash ?? decoyHash;
      const equal = timingSafeEqual(presented, expected);
      return equal && entry !== undefined && entry.session.status === 'running';
    },

    /** Graceful: Ctrl-C, the grace period, then the tree kill (D21). Resolves once it ended. */
    async stop(id: string): Promise<void> {
      const entry = live(id);
      if (entry.session.status !== 'running') return;
      entry.requestedEnd ??= 'user_stop';
      entry.log.info({ graceMs: stopGraceMs }, 'stopping');
      entry.pty.write('\x03');
      if (await waitForExit(entry, Math.min(SECOND_CTRL_C_MS, stopGraceMs))) return;
      entry.pty.write('\x03');
      if (await waitForExit(entry, Math.max(0, stopGraceMs - SECOND_CTRL_C_MS))) return;
      await terminate(entry);
    },

    /** The tree kill at once. Resolves once it ended (or the wait ran out). */
    async kill(id: string): Promise<void> {
      const entry = live(id);
      if (entry.session.status !== 'running') return;
      entry.requestedEnd ??= 'user_kill';
      await terminate(entry);
    },
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;
