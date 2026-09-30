// HookIngest (PLAN §5.1, §9.6, D13, D29): `POST /hooks?session=<sessionId>`, where every provider
// CLI's hooks post. The CLI waits for the reply on every event, so only the cheap checks run
// before it, in D29's order:
//   1. the body-size limit (413; Fastify enforces it while reading the body),
//   2. the session: unknown, ended or missing → 404, no details,
//   3. the hook token, compared in constant time against that session's own token only → 401,
//   4. a per-session rate limit → 429,
// then an empty 204 at once. After the reply the body is parsed (anything that isn't JSON is kept
// as a string, which the adapter turns into `unknown`), normalized through the registry for the
// session's provider, appended to the store and handed to the subscriber, in arrival order.
// Nothing after the reply can change it or crash the server: failures are logged.
import type { AgentEvent, Provider } from '@micro-minds/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { newUlid } from '../ids.ts';
import type { Logger } from '../logging/logger.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { Session } from '../sessions/session-manager.ts';

export const DEFAULT_HOOK_BODY_LIMIT = 2 * 1024 * 1024;
export const DEFAULT_HOOK_RATE_LIMIT = { max: 1_000, windowMs: 10_000 } as const;

export interface HookIngestOptions {
  sessions: {
    get(id: string): Pick<Session, 'provider' | 'status'> | undefined;
    verifyHookToken(id: string, token: string): boolean;
  };
  registry: ProviderRegistry;
  store: { append(event: AgentEvent): void };
  logger: Logger;
  onEvent: (event: AgentEvent) => void;
  /** Bytes; a larger body gets 413. */
  bodyLimit?: number;
  /** Per session: at most `max` accepted requests per `windowMs`. */
  rateLimit?: { max: number; windowMs: number };
}

const BEARER = /^Bearer (\S+)$/;

export function registerHookIngest(app: FastifyInstance, options: HookIngestOptions): void {
  const bodyLimit = options.bodyLimit ?? DEFAULT_HOOK_BODY_LIMIT;
  const rateLimit = options.rateLimit ?? DEFAULT_HOOK_RATE_LIMIT;
  const windows = new Map<string, { start: number; count: number }>();

  function withinRate(sessionId: string, now: number): boolean {
    const window = windows.get(sessionId);
    if (window === undefined || now - window.start >= rateLimit.windowMs) {
      windows.set(sessionId, { start: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= rateLimit.max;
  }

  function process(sessionId: string, provider: Provider, body: string, receivedAt: number): void {
    const log = options.logger.child({ sessionId });
    let raw: unknown = body;
    try {
      raw = JSON.parse(body);
    } catch {
      // Not JSON: the string itself goes to the adapter, which makes it `unknown` (hard rule 7).
    }
    log.debug({ payload: raw }, 'hook received');
    let events: AgentEvent[];
    try {
      events = options.registry.normalize(provider, raw, {
        sessionId,
        receivedAt,
        newId: () => newUlid(receivedAt),
      });
    } catch (error: unknown) {
      log.error({ err: error }, 'normalizing a hook payload failed');
      return;
    }
    for (const event of events) {
      try {
        options.store.append(event);
      } catch (error: unknown) {
        log.error({ err: error, eventId: event.id }, 'storing an event failed');
      }
      try {
        options.onEvent(event);
      } catch (error: unknown) {
        log.warn({ err: error, eventId: event.id }, 'an event subscriber failed');
      }
    }
  }

  // Its own scope, so its body parser (the raw string, so non-JSON bodies are still accepted)
  // doesn't apply to other routes.
  void app.register((scope, _options, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string', bodyLimit }, (_request, body, done) => {
      done(null, body);
    });

    scope.post('/hooks', { bodyLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
      const receivedAt = Date.now();
      const sessionId = sessionOf(request.query);
      const session = sessionId === undefined ? undefined : options.sessions.get(sessionId);
      if (sessionId === undefined || session === undefined || session.status !== 'running') {
        return reply.code(404).send();
      }
      const token = BEARER.exec(headerOf(request.headers.authorization))?.[1];
      if (token === undefined || !options.sessions.verifyHookToken(sessionId, token)) {
        options.logger.child({ sessionId }).warn('hook refused: bad or missing token');
        return reply.code(401).send();
      }
      if (!withinRate(sessionId, receivedAt)) {
        options.logger.child({ sessionId }).warn('hook refused: rate limit');
        return reply.code(429).send();
      }
      const body = typeof request.body === 'string' ? request.body : '';
      const { provider } = session;
      await reply.code(204).send();
      setImmediate(() => {
        try {
          process(sessionId, provider, body, receivedAt);
        } catch (error: unknown) {
          options.logger.child({ sessionId }).error({ err: error }, 'processing a hook failed');
        }
      });
      return reply;
    });
    done();
  });
}

function sessionOf(query: unknown): string | undefined {
  if (typeof query !== 'object' || query === null || !('session' in query)) return undefined;
  const value = query.session;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function headerOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
