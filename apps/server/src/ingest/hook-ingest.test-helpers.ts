// Task 2.7: shared rig for the HookIngest tests. A real Fastify instance listens on 127.0.0.1
// (port 0) with `registerHookIngest` on it and a real EventStore in a temp dir. Sessions come from
// a stub with the SessionManager's `get` / `verifyHookToken` shape, or from a real SessionManager
// (hook-ingest.session.test.ts). The registry is the real default one, optionally wrapped so a
// test can see or break its normalize calls. No real provider CLI ever runs (C12).
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { AgentEvent, Provider } from '@micro-minds/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Level } from 'pino';
import { type LogSink, logSink } from '../logging/logger.test-helpers.ts';
import { createLogger } from '../logging/logger.ts';
import { hookEndpoint } from '../providers/hook-url.ts';
import { createDefaultRegistry } from '../providers/index.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { NormalizeContext } from '../providers/types.ts';
import type { Session } from '../sessions/session-manager.ts';
import { type EventStore, openEventStore } from '../store/event-store.ts';
import { makeTempDir, removeTempDir } from '../store/store.test-helpers.ts';
import { registerHookIngest } from './hook-ingest.ts';

export type IngestOptions = Parameters<typeof registerHookIngest>[1];

/** Generous for Windows CI. */
export const WAIT_MS = 10_000;

export function sessionIdOf(n: number): string {
  return `01K6G5W0000000000000${String(n).padStart(6, '0')}`;
}

export interface StubSession {
  id: string;
  provider: Provider;
  status: Session['status'];
  token: string;
}

export function stubSession(
  n: number,
  provider: Provider = 'fake',
  status: Session['status'] = 'running',
): StubSession {
  return { id: sessionIdOf(n), provider, status, token: `hook-token-${n}-Zq8Xw3Rt6Yp1` };
}

/**
 * The SessionManager's lookup shape over fixed sessions. Like the real one, `verifyHookToken`
 * accepts only the named session's own token, and only while it runs.
 */
export function stubSessions(entries: readonly StubSession[]) {
  const verifyCalls: Array<{ id: string; token: string }> = [];
  return {
    verifyCalls,
    get(id: string): Session | undefined {
      const found = entries.find((e) => e.id === id);
      if (found === undefined) return undefined;
      return {
        id: found.id,
        provider: found.provider,
        worktreePath: path.join('worktrees', found.id),
        branch: `micro-minds/${found.id}`,
        pid: 999_999_991,
        status: found.status,
      };
    },
    verifyHookToken(id: string, token: string): boolean {
      verifyCalls.push({ id, token });
      const found = entries.find((e) => e.id === id);
      return found !== undefined && found.status === 'running' && found.token === token;
    },
  };
}

export interface NormalizeCall {
  provider: Provider;
  raw: unknown;
  ctx: { sessionId: string; receivedAt: number };
}

export interface RigOptions {
  sessions: IngestOptions['sessions'];
  level?: Level;
  bodyLimit?: number;
  rateLimit?: { max: number; windowMs: number };
  /** Replaces the registry's normalize (it gets the real one to delegate to). */
  normalize?: (
    real: ProviderRegistry['normalize'],
    provider: Provider,
    raw: unknown,
    ctx: NormalizeContext,
  ) => AgentEvent[];
  /** Replaces the store's append (it gets the real one to delegate to). */
  append?: (real: (event: AgentEvent) => void, event: AgentEvent) => void;
  onEvent?: (event: AgentEvent) => void;
}

export interface Rig {
  url: string;
  app: FastifyInstance;
  store: EventStore;
  /** Every event handed to the subscriber, in order. */
  events: AgentEvent[];
  normalizeCalls: NormalizeCall[];
  logs: LogSink;
  close: () => Promise<void>;
}

export async function startRig(options: RigOptions): Promise<Rig> {
  const tmp = makeTempDir('mm-ingest-');
  const store = openEventStore({ file: path.join(tmp, 'micro-minds.db') });
  const logs = logSink();
  const events: AgentEvent[] = [];
  const normalizeCalls: NormalizeCall[] = [];
  const real = createDefaultRegistry();
  const registry: ProviderRegistry = {
    ...real,
    normalize: (provider, raw, ctx) => {
      normalizeCalls.push({
        provider,
        raw,
        ctx: { sessionId: ctx.sessionId, receivedAt: ctx.receivedAt },
      });
      return options.normalize === undefined
        ? real.normalize(provider, raw, ctx)
        : options.normalize(real.normalize, provider, raw, ctx);
    },
  };
  const realAppend = (event: AgentEvent): void => store.append(event);
  const app = Fastify({ logger: false });
  registerHookIngest(app, {
    sessions: options.sessions,
    registry,
    store: {
      append: (event: AgentEvent) =>
        options.append === undefined ? realAppend(event) : options.append(realAppend, event),
    },
    logger: createLogger({ level: options.level ?? 'trace', destination: logs }),
    onEvent: (event: AgentEvent) => {
      events.push(event);
      options.onEvent?.(event);
    },
    ...(options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit }),
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    url: address,
    app,
    store,
    events,
    normalizeCalls,
    logs,
    close: async () => {
      await app.close();
      store.close();
      removeTempDir(tmp);
    },
  };
}

export interface PostOptions {
  /** Our session id, put in the query as the hooks do; omitted → no `session` parameter. */
  session?: string;
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Sent as the whole Authorization header (overrides `token`). */
  authorization?: string;
  body: string;
}

export interface PostResult {
  status: number;
  body: string;
}

export async function postHook(url: string, options: PostOptions): Promise<PostResult> {
  const target =
    options.session === undefined ? `${url}/hooks` : hookEndpoint(url, options.session);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.authorization !== undefined) headers.Authorization = options.authorization;
  else if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(target, {
    method: 'POST',
    headers,
    body: options.body,
    signal: AbortSignal.timeout(WAIT_MS),
  });
  return { status: response.status, body: await response.text() };
}

export function isEmpty2xx(result: PostResult): boolean {
  return result.status >= 200 && result.status < 300 && result.body === '';
}

export async function waitFor(what: string, check: () => boolean, ms = WAIT_MS): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolves after `ms`: only for asserting that nothing more arrives. */
export function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Blocks the event loop, as a slow subscriber would. */
export function busyWait(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Spin.
  }
}

const POST_CLIENT = path.join(import.meta.dirname, 'post-client.test-helpers.ts');

/**
 * POSTs from a separate node process, which times how long the reply took. The server's process
 * may be blocked after the reply (a slow subscriber); the client's clock keeps running.
 */
export function postFromChild(
  url: string,
  sessionId: string,
  token: string,
  body: string,
): Promise<PostResult & { ms: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [POST_CLIENT, hookEndpoint(url, sessionId), token, body],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true },
    );
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      err += chunk;
    });
    child.on('error', reject);
    child.on('exit', () => {
      try {
        const parsed: unknown = JSON.parse(out);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'status' in parsed &&
          'body' in parsed &&
          'ms' in parsed &&
          typeof parsed.status === 'number' &&
          typeof parsed.body === 'string' &&
          typeof parsed.ms === 'number'
        ) {
          resolve({ status: parsed.status, body: parsed.body, ms: parsed.ms });
          return;
        }
        reject(new Error(`unexpected client output: ${out} ${err}`));
      } catch {
        reject(new Error(`the post client failed: ${out} ${err}`));
      }
    });
  });
}
