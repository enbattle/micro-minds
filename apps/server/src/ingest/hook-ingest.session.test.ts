// Task 2.7, clauses C2 and C10: the ingest wired to a real SessionManager. The fake provider's CLI
// runs in a real PTY and posts its scenario to /hooks on a Fastify server listening on
// 127.0.0.1; the store and the subscriber must see the scenario in order. Token scope is checked
// with real hook tokens (issued by the manager, captured from the launch context) on in-memory
// PTYs. Every repo and `$MICROMINDS_HOME` is a temp dir; no real provider CLI runs (C12).
import type { AgentEvent } from '@micro-minds/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../providers/index.ts';
import { createProviderRegistry } from '../providers/registry.ts';
import {
  exitAllFakes,
  type FakePtys,
  fakePtys,
  type Harness,
  type HarnessOptions,
  killAll,
  makeHarness,
  probeAdapter,
  TEST_TIMEOUT_MS,
  waitUntil,
} from '../sessions/session-manager.test-helpers.ts';
import { removeTempRoot } from '../worktrees/worktree-manager.test-helpers.ts';
import { isEmpty2xx, postHook, type Rig, startRig } from './hook-ingest.test-helpers.ts';

let h: Harness | undefined;
let fake: FakePtys | undefined;
let rig: Rig | undefined;

afterEach(async () => {
  exitAllFakes(fake);
  if (h !== undefined) await killAll(h.manager);
  await rig?.close();
  if (h !== undefined) removeTempRoot(h.tmp);
  h = undefined;
  fake = undefined;
  rig = undefined;
});

/** A rig whose sessions are the harness's SessionManager (built once the server's URL is known). */
async function wired(
  options: Omit<HarnessOptions, 'serverUrl'>,
): Promise<{ h: Harness; rig: Rig }> {
  let harness: Harness | undefined;
  rig = await startRig({
    sessions: {
      get: (id: string) => harness?.manager.get(id),
      verifyHookToken: (id: string, token: string) =>
        harness?.manager.verifyHookToken(id, token) ?? false,
    },
  });
  fake = options.fake;
  harness = makeHarness({ ...options, serverUrl: rig.url });
  h = harness;
  return { h: harness, rig };
}

function kinds(events: readonly AgentEvent[]): string[] {
  return events.map((e) => e.kind);
}

describe('HookIngest with the SessionManager', { timeout: TEST_TIMEOUT_MS }, () => {
  it('the fake CLI posts its scenario to /hooks and its events are stored and emitted in order (C10)', async () => {
    const { h: harness, rig: r } = await wired({ registry: () => createDefaultRegistry() });

    const session = await harness.manager.create({
      provider: 'fake',
      repoPath: harness.repo,
      firstPrompt: 'say hello',
      cols: 80,
      rows: 24,
    });
    await waitUntil('the scenario is stored', () => r.store.read(session.id).length >= 6);

    const stored = r.store.read(session.id);
    expect(kinds(stored)).toEqual([
      'prompt.submitted',
      'tool.started',
      'tool.finished',
      'tool.started',
      'tool.finished',
      'turn.finished',
    ]);
    expect(stored.every((e) => e.sessionId === session.id && e.provider === 'fake')).toBe(true);
    expect(r.events.filter((e) => e.sessionId === session.id)).toStrictEqual(stored);

    await harness.manager.write(session.id, '/exit\r');
    await waitUntil('the session ended', () => harness.manager.get(session.id)?.status === 'ended');
  });

  it("session A's token never posts for session B; an ended session's own token gets 404 (C2)", async () => {
    const tokens = new Map<string, string>();
    const { h: harness, rig: r } = await wired({
      fake: fakePtys(),
      registry: (reportDir) =>
        createProviderRegistry([
          probeAdapter({ reportDir, onLaunch: (ctx) => tokens.set(ctx.sessionId, ctx.hookToken) }),
        ]),
    });
    const input = { provider: 'fake' as const, repoPath: harness.repo, cols: 80, rows: 24 };
    const a = await harness.manager.create(input);
    const b = await harness.manager.create(input);
    const tokenA = tokens.get(a.id) ?? '';
    const tokenB = tokens.get(b.id) ?? '';
    expect(tokenA).not.toBe('');
    expect(tokenB).not.toBe('');
    const body = '{"event":"prompt.submitted","text":"hi"}';

    const crossed = await postHook(r.url, { session: b.id, token: tokenA, body });
    const ownA = await postHook(r.url, { session: a.id, token: tokenA, body });
    const ownB = await postHook(r.url, { session: b.id, token: tokenB, body });

    expect(crossed.status).toBe(401);
    expect(isEmpty2xx(ownA)).toBe(true);
    expect(isEmpty2xx(ownB)).toBe(true);
    await waitUntil(
      'both own posts are stored',
      () => r.store.read(a.id).length === 1 && r.store.read(b.id).length === 1,
    );

    fake?.ptys[1]?.emitExit(0);
    await waitUntil('B ended', () => harness.manager.get(b.id)?.status === 'ended');
    const afterEnd = await postHook(r.url, { session: b.id, token: tokenB, body });

    expect(afterEnd.status).toBe(404);
    await postHook(r.url, { session: a.id, token: tokenA, body });
    await waitUntil('the barrier post is stored', () => r.store.read(a.id).length === 2);
    expect(r.store.read(b.id)).toHaveLength(1);
  });
});
