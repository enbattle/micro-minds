// Task 2.7, clauses C1–C5: `POST /hooks?session=<id>` (D29, PLAN §5.1, §9.6). The ingest runs on a
// real Fastify instance on 127.0.0.1 with a real EventStore; sessions come from a stub with the
// SessionManager's `get` / `verifyHookToken` shape (the real manager is used in
// hook-ingest.session.test.ts). Bodies are lines of the recorded fixtures.
//
// "Refused requests are never processed" is checked with a barrier: after the refused request, a
// valid one is sent and awaited until it is stored; the refused one arrived first, so had it been
// processed it would show by then.
import fs from 'node:fs';
import path from 'node:path';
import { type AgentEvent, ULID_PATTERN } from '@micro-minds/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../providers/index.ts';
import {
  busyWait,
  isEmpty2xx,
  type PostOptions,
  type PostResult,
  postFromChild,
  postHook,
  type Rig,
  type RigOptions,
  type StubSession,
  settle,
  startRig,
  stubSession,
  stubSessions,
  waitFor,
} from './hook-ingest.test-helpers.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../../../../fixtures');

function fixtureLines(provider: string, scenario: string): string[] {
  return fs
    .readFileSync(path.join(FIXTURES, provider, `${scenario}.jsonl`), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}

const BASIC = fixtureLines('fake', 'basic');
const FIRST = BASIC[0] ?? '{}';
const CLAUDE_QA = fixtureLines('claude', 'qa');

const S1 = stubSession(1, 'fake');
const S2 = stubSession(2, 'fake');
const ENDED = stubSession(3, 'fake', 'ended');
const CLAUDE = stubSession(4, 'claude');
const UNKNOWN_ID = '01K6G5W0000000000000999999';

const TIMEOUT_MS = 30_000;

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

async function start(
  options: Omit<RigOptions, 'sessions'> & { sessions?: readonly StubSession[] } = {},
): Promise<Rig> {
  const { sessions, ...rest } = options;
  rig = await startRig({ sessions: stubSessions(sessions ?? [S1, S2, ENDED, CLAUDE]), ...rest });
  return rig;
}

function post(r: Rig, options: PostOptions): Promise<PostResult> {
  return postHook(r.url, options);
}

/** A JSON fake-provider body of exactly `bytes` bytes (ASCII). */
function bodyOfSize(bytes: number): string {
  const head = '{"event":"prompt.submitted","text":"';
  const tail = '"}';
  return `${head}${'a'.repeat(bytes - head.length - tail.length)}${tail}`;
}

function kinds(events: readonly AgentEvent[]): string[] {
  return events.map((e) => e.kind);
}

/** Sends one valid request for S1 and waits until it is stored: everything before it is done. */
async function barrier(r: Rig): Promise<void> {
  const before = r.store.read(S1.id).length;
  const result = await post(r, { session: S1.id, token: S1.token, body: FIRST });
  expect(isEmpty2xx(result)).toBe(true);
  await waitFor('the barrier request is stored', () => r.store.read(S1.id).length > before);
}

function storedEverywhere(r: Rig): AgentEvent[] {
  return [S1, S2, ENDED, CLAUDE]
    .flatMap((s) => r.store.read(s.id))
    .concat(r.store.read(UNKNOWN_ID));
}

describe('HookIngest', { timeout: TIMEOUT_MS }, () => {
  describe('the reply (C1)', () => {
    it('a running session posting with its own token gets an empty 2xx', async () => {
      const r = await start();

      const result = await post(r, { session: S1.id, token: S1.token, body: FIRST });

      expect(isEmpty2xx(result)).toBe(true);
    });

    it('is sent before processing: a subscriber that blocks for 3 s does not delay it', async () => {
      let blocked = false;
      const r = await start({
        onEvent: () => {
          if (blocked) return;
          blocked = true;
          busyWait(3_000);
        },
      });

      const result = await postFromChild(r.url, S1.id, S1.token, FIRST);

      expect(isEmpty2xx(result)).toBe(true);
      expect(result.ms).toBeLessThan(1_500);
      await waitFor('the event is stored', () => r.store.read(S1.id).length === 1);
      expect(blocked).toBe(true);
    });
  });

  describe('the order of checks (C2)', () => {
    const LIMIT = 1_024;

    const REFUSALS: Array<{ name: string; request: PostOptions; status: number }> = [
      {
        name: 'an oversized body for an unknown session → 413',
        request: { session: UNKNOWN_ID, token: S1.token, body: bodyOfSize(LIMIT + 1) },
        status: 413,
      },
      {
        name: 'an oversized body without a token → 413',
        request: { session: S1.id, body: bodyOfSize(LIMIT * 2) },
        status: 413,
      },
      {
        name: 'an oversized body from a valid session and token → 413',
        request: { session: S1.id, token: S1.token, body: bodyOfSize(LIMIT + 1) },
        status: 413,
      },
      {
        name: 'an unknown session with no token → 404',
        request: { session: UNKNOWN_ID, body: FIRST },
        status: 404,
      },
      {
        name: "an unknown session with another session's token → 404",
        request: { session: UNKNOWN_ID, token: S1.token, body: FIRST },
        status: 404,
      },
      {
        name: 'an ended session with its own token → 404',
        request: { session: ENDED.id, token: ENDED.token, body: FIRST },
        status: 404,
      },
      {
        name: 'no session parameter → 404',
        request: { token: S1.token, body: FIRST },
        status: 404,
      },
      {
        name: 'an empty session parameter → 404',
        request: { session: '', token: S1.token, body: FIRST },
        status: 404,
      },
      {
        name: 'a running session with no Authorization header → 401',
        request: { session: S1.id, body: FIRST },
        status: 401,
      },
      {
        name: 'a running session with a wrong token → 401',
        request: { session: S1.id, token: 'not-the-token', body: FIRST },
        status: 401,
      },
      {
        name: "a running session with another running session's token → 401",
        request: { session: S1.id, token: S2.token, body: FIRST },
        status: 401,
      },
      {
        name: 'a running session with its token but not as a Bearer credential → 401',
        request: { session: S1.id, authorization: S1.token, body: FIRST },
        status: 401,
      },
      {
        name: 'a running session with an empty Bearer credential → 401',
        request: { session: S1.id, authorization: 'Bearer ', body: FIRST },
        status: 401,
      },
    ];

    it.each(REFUSALS)(
      '$name, and the request is never normalized, stored or emitted',
      async ({ request, status }) => {
        const r = await start({ bodyLimit: LIMIT });

        const result = await post(r, request);

        expect(result.status).toBe(status);
        await barrier(r);
        expect(r.normalizeCalls).toHaveLength(1);
        expect(r.events).toHaveLength(1);
        expect(storedEverywhere(r)).toHaveLength(1);
      },
    );

    it('a body exactly at the limit is accepted', async () => {
      const r = await start({ bodyLimit: LIMIT });

      const result = await post(r, { session: S1.id, token: S1.token, body: bodyOfSize(LIMIT) });

      expect(isEmpty2xx(result)).toBe(true);
      await waitFor('the event is stored', () => r.store.read(S1.id).length === 1);
    });

    it('refusals give no details: every 404 looks the same, every 401 looks the same, and none names the session or token', async () => {
      const r = await start();
      const notFound = await Promise.all([
        post(r, { session: UNKNOWN_ID, token: S1.token, body: FIRST }),
        post(r, { session: ENDED.id, token: ENDED.token, body: FIRST }),
        post(r, { token: S1.token, body: FIRST }),
      ]);
      const unauthorized = await Promise.all([
        post(r, { session: S1.id, body: FIRST }),
        post(r, { session: S1.id, token: 'not-the-token', body: FIRST }),
        post(r, { session: S1.id, token: S2.token, body: FIRST }),
      ]);

      expect(notFound.map((x) => x.status)).toEqual([404, 404, 404]);
      expect(unauthorized.map((x) => x.status)).toEqual([401, 401, 401]);
      expect(new Set(notFound.map((x) => x.body)).size).toBe(1);
      expect(new Set(unauthorized.map((x) => x.body)).size).toBe(1);
      for (const { body } of [...notFound, ...unauthorized]) {
        for (const secret of [S1.token, S2.token, ENDED.token, S1.id, ENDED.id, UNKNOWN_ID]) {
          expect(body).not.toContain(secret);
        }
      }
    });

    it("the token is checked against the named session's token only", async () => {
      const sessions = stubSessions([S1, S2]);
      rig = await startRig({ sessions });

      const result = await post(rig, { session: S1.id, token: S2.token, body: FIRST });

      expect(result.status).toBe(401);
      expect(sessions.verifyCalls.length).toBeGreaterThan(0);
      expect(sessions.verifyCalls.every((call) => call.id === S1.id)).toBe(true);
    });
  });

  describe('after the reply (C3)', () => {
    it("normalizes, stores and emits the fake scenario in arrival order, with the server's receipt time and fresh ULIDs", async () => {
      const r = await start();
      const before = Date.now();

      for (const body of BASIC) {
        expect(isEmpty2xx(await post(r, { session: S1.id, token: S1.token, body }))).toBe(true);
      }
      await waitFor('every event is stored', () => r.store.read(S1.id).length === BASIC.length);
      const after = Date.now();

      const stored = r.store.read(S1.id);
      expect(kinds(stored)).toEqual([
        'prompt.submitted',
        'tool.started',
        'tool.finished',
        'tool.started',
        'tool.finished',
        'turn.finished',
      ]);
      expect(r.events).toStrictEqual(stored);
      for (const event of stored) {
        expect(event).toMatchObject({ sessionId: S1.id, provider: 'fake', agentId: S1.id });
        expect(event.id).toMatch(ULID_PATTERN);
        expect(event.ts).toBeGreaterThanOrEqual(before);
        expect(event.ts).toBeLessThanOrEqual(after);
      }
      expect(new Set(stored.map((e) => e.id)).size).toBe(stored.length);
      const times = stored.map((e) => e.ts);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it("normalizes through the session's own provider (a Claude session gets the Claude adapter)", async () => {
      const r = await start();

      for (const body of CLAUDE_QA) {
        await post(r, { session: CLAUDE.id, token: CLAUDE.token, body });
      }
      await post(r, { session: S1.id, token: S1.token, body: CLAUDE_QA[0] ?? '{}' });
      await waitFor('every payload is processed', () => r.normalizeCalls.length === 4);

      expect(r.normalizeCalls.map((c) => c.provider)).toEqual([
        'claude',
        'claude',
        'claude',
        'fake',
      ]);
      expect(r.normalizeCalls.map((c) => c.raw)).toEqual(
        [...CLAUDE_QA, CLAUDE_QA[0] ?? '{}'].map((line): unknown => JSON.parse(line)),
      );
      expect(r.normalizeCalls.map((c) => c.ctx.sessionId)).toEqual([
        CLAUDE.id,
        CLAUDE.id,
        CLAUDE.id,
        S1.id,
      ]);
      const registry = createDefaultRegistry();
      let n = 0;
      const direct = CLAUDE_QA.flatMap((line) =>
        registry.normalize('claude', JSON.parse(line), {
          sessionId: CLAUDE.id,
          receivedAt: 1,
          newId: () => {
            n += 1;
            return `01K6G5X${String(n).padStart(19, '0')}`;
          },
        }),
      );
      await waitFor(
        'the Claude events are stored',
        () => r.store.read(CLAUDE.id).length === direct.length,
      );
      expect(kinds(r.store.read(CLAUDE.id))).toEqual(kinds(direct));
      expect(r.store.read(CLAUDE.id).every((e) => e.provider === 'claude')).toBe(true);
    });

    it('stores and emits every event one payload yields, in order, each with its own id', async () => {
      const r = await start({
        normalize: (_real, provider, _raw, ctx) =>
          (['tool.started', 'tool.finished'] as const).map(
            (kind): AgentEvent => ({
              v: 1,
              id: ctx.newId(),
              ts: ctx.receivedAt,
              sessionId: ctx.sessionId,
              provider,
              agentId: ctx.sessionId,
              kind,
              tool: { name: 'Read', category: 'read' },
            }),
          ),
      });

      await post(r, { session: S1.id, token: S1.token, body: FIRST });
      await waitFor('both events are stored', () => r.store.read(S1.id).length === 2);

      const stored = r.store.read(S1.id);
      expect(kinds(stored)).toEqual(['tool.started', 'tool.finished']);
      expect(r.events).toStrictEqual(stored);
      expect(stored[0]?.id).not.toBe(stored[1]?.id);
    });

    it.each([
      { name: 'text that is not JSON', body: 'this is {not json' },
      { name: 'truncated JSON', body: '{"event":"prompt.submitted","te' },
      { name: 'an empty body', body: '' },
    ])('a body of $name is still accepted and becomes one unknown event', async ({ body }) => {
      const r = await start();

      const result = await post(r, { session: S1.id, token: S1.token, body });

      expect(isEmpty2xx(result)).toBe(true);
      await waitFor('the event is stored', () => r.store.read(S1.id).length === 1);
      expect(r.store.read(S1.id)[0]).toMatchObject({
        kind: 'unknown',
        sessionId: S1.id,
        provider: 'fake',
        agentId: S1.id,
      });
      expect(r.events).toHaveLength(1);
    });

    const FAILURES: Array<{ name: string; options: Omit<RigOptions, 'sessions'> }> = [
      {
        name: 'normalizing throws',
        options: {
          normalize: () => {
            throw new Error('normalize failed on purpose');
          },
        },
      },
      {
        name: 'storing throws',
        options: {
          append: () => {
            throw new Error('append failed on purpose');
          },
        },
      },
      {
        name: 'a subscriber throws',
        options: {
          onEvent: () => {
            throw new Error('subscriber failed on purpose');
          },
        },
      },
    ];

    it.each(FAILURES)(
      'when $name: the reply is unchanged, the failure is logged with the sessionId, and the server keeps serving',
      async ({ options }) => {
        const r = await start(options);

        const first = await post(r, { session: S1.id, token: S1.token, body: FIRST });
        await waitFor('the failure is logged', () =>
          r.logs
            .records()
            .some(
              (line) =>
                typeof line.level === 'number' && line.level >= 40 && line.sessionId === S1.id,
            ),
        );
        const second = await post(r, { session: S1.id, token: S1.token, body: FIRST });

        expect(isEmpty2xx(first)).toBe(true);
        expect(isEmpty2xx(second)).toBe(true);
        await waitFor('the second request is processed', () => r.normalizeCalls.length === 2);
      },
    );
  });

  describe('rate limit (C4)', () => {
    it('refuses a session beyond its rate with 429 and stores nothing for it; other sessions are unaffected', async () => {
      const r = await start({ rateLimit: { max: 3, windowMs: 60_000 } });
      const statuses: number[] = [];

      for (const body of BASIC.slice(0, 5)) {
        statuses.push((await post(r, { session: S1.id, token: S1.token, body })).status);
      }
      const other = await post(r, { session: S2.id, token: S2.token, body: FIRST });

      expect(statuses.slice(0, 3).every((s) => s >= 200 && s < 300)).toBe(true);
      expect(statuses.slice(3)).toEqual([429, 429]);
      expect(isEmpty2xx(other)).toBe(true);
      await waitFor(
        'the accepted events are stored',
        () => r.store.read(S1.id).length === 3 && r.store.read(S2.id).length === 1,
      );
      await settle(200);
      expect(kinds(r.store.read(S1.id))).toEqual([
        'prompt.submitted',
        'tool.started',
        'tool.finished',
      ]);
      expect(r.normalizeCalls).toHaveLength(4);
      expect(r.events).toHaveLength(4);
    });
  });

  describe('logging (C5)', () => {
    const PAYLOAD_MARK = 'mm-payload-9Tq2Lx';

    it('no log line holds a hook token or an Authorization header value, accepted or refused', async () => {
      const r = await start({
        onEvent: () => {
          throw new Error('subscriber failed on purpose');
        },
      });

      await post(r, { session: S1.id, token: S1.token, body: FIRST });
      await post(r, { session: S1.id, token: S2.token, body: FIRST });
      await post(r, { session: S1.id, authorization: `Basic ${S2.token}`, body: FIRST });
      await post(r, { session: UNKNOWN_ID, token: S1.token, body: FIRST });
      await post(r, { session: ENDED.id, token: ENDED.token, body: FIRST });
      await barrier(r);

      for (const line of r.logs.lines) {
        for (const secret of [S1.token, S2.token, ENDED.token]) {
          expect(line).not.toContain(secret);
        }
      }
    });

    it("lines about a session's request carry its sessionId", async () => {
      const r = await start({
        onEvent: () => {
          throw new Error('subscriber failed on purpose');
        },
      });

      await post(r, { session: S1.id, token: S1.token, body: FIRST });
      await waitFor('something is logged', () => r.logs.lines.length > 0);
      await barrier(r);

      const records = r.logs.records();
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) expect(record.sessionId).toBe(S1.id);
    });

    it('payloads never appear at info and above', async () => {
      const r = await start({
        level: 'info',
        onEvent: () => {
          throw new Error('subscriber failed on purpose');
        },
      });

      await post(r, {
        session: S1.id,
        token: S1.token,
        body: JSON.stringify({ event: 'no.such.event', detail: PAYLOAD_MARK }),
      });
      await post(r, { session: S1.id, token: S1.token, body: `not json ${PAYLOAD_MARK}` });
      await waitFor('both are stored', () => r.store.read(S1.id).length === 2);
      await settle(50);

      for (const line of r.logs.lines) expect(line).not.toContain(PAYLOAD_MARK);
    });
  });
});
