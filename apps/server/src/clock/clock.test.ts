// Task 2.7, clause C9: the Clock (D15, ADR 0015). While started it emits one `clock.tick` per
// running session at a configurable interval. Time (`now`) and timers (`timers.setInterval` /
// `timers.clearInterval`) are injected, so these tests fire the interval by hand and never sleep.
import {
  type AgentEvent,
  EVENT_SCHEMA_VERSION,
  parseAgentEvent,
  ULID_PATTERN,
} from '@micro-minds/shared';
import { describe, expect, it } from 'vitest';
import type { Session } from '../sessions/session-manager.ts';
import { createClock } from './clock.ts';

const T0 = 1_760_000_000_000;

function session(n: number, provider: Session['provider'], status: Session['status']): Session {
  return {
    id: `01K6G5W0000000000000${String(n).padStart(6, '0')}`,
    provider,
    worktreePath: `/tmp/worktrees/${n}`,
    branch: `micro-minds/${n}`,
    pid: 999_999_991,
    status,
  };
}

interface FakeTimers {
  timers: {
    setInterval: (callback: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  /** The intervals currently registered, by handle. */
  active: Map<number, { callback: () => void; ms: number }>;
  /** Fires every registered interval once, as if its period had elapsed. */
  fire: () => void;
}

function fakeTimers(): FakeTimers {
  const active = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  return {
    timers: {
      setInterval: (callback, ms) => {
        const handle = next;
        next += 1;
        active.set(handle, { callback, ms });
        return handle;
      },
      clearInterval: (handle) => {
        if (typeof handle === 'number') active.delete(handle);
      },
    },
    active,
    fire: () => {
      for (const { callback } of [...active.values()]) callback();
    },
  };
}

function rig(sessions: Session[], intervalMs = 5_000) {
  let now = T0;
  const events: AgentEvent[] = [];
  const fake = fakeTimers();
  const clock = createClock({
    intervalMs,
    sessions: { list: () => sessions.map((s) => ({ ...s })) },
    onEvent: (event) => {
      events.push(event);
    },
    now: () => now,
    timers: fake.timers,
  });
  return {
    clock,
    events,
    fake,
    advance: (ms: number) => {
      now += ms;
      fake.fire();
    },
  };
}

const RUNNING_A = session(1, 'claude', 'running');
const RUNNING_B = session(2, 'fake', 'running');
const ENDED = session(3, 'claude', 'ended');

describe('Clock (C9)', () => {
  it('does nothing until started', () => {
    const { events, fake } = rig([RUNNING_A]);

    fake.fire();

    expect(fake.active.size).toBe(0);
    expect(events).toEqual([]);
  });

  it('once started, schedules itself at the configured interval', () => {
    const { clock, fake } = rig([RUNNING_A], 7_500);

    clock.start();

    expect([...fake.active.values()].map((t) => t.ms)).toEqual([7_500]);
    clock.stop();
  });

  it('each interval emits one tick per running session, with its id, provider, root agent and the server time', () => {
    const { clock, events, advance } = rig([RUNNING_A, ENDED, RUNNING_B]);
    clock.start();

    advance(5_000);

    expect(events).toHaveLength(2);
    const bySession = new Map(events.map((e) => [e.sessionId, e]));
    for (const s of [RUNNING_A, RUNNING_B]) {
      const tick = bySession.get(s.id);
      expect(tick).toMatchObject({
        v: EVENT_SCHEMA_VERSION,
        kind: 'clock.tick',
        sessionId: s.id,
        provider: s.provider,
        agentId: s.id,
        ts: T0 + 5_000,
      });
      expect(tick?.id).toMatch(ULID_PATTERN);
      expect(parseAgentEvent(tick).ok).toBe(true);
    }
    expect(bySession.has(ENDED.id)).toBe(false);
    clock.stop();
  });

  it('every tick has a fresh id, and later ticks carry the later time', () => {
    const { clock, events, advance } = rig([RUNNING_A, RUNNING_B]);
    clock.start();

    advance(5_000);
    advance(5_000);
    advance(5_000);

    expect(events).toHaveLength(6);
    expect(new Set(events.map((e) => e.id)).size).toBe(6);
    expect(events.filter((e) => e.sessionId === RUNNING_A.id).map((e) => e.ts)).toEqual([
      T0 + 5_000,
      T0 + 10_000,
      T0 + 15_000,
    ]);
    clock.stop();
  });

  it('emits nothing when no session is running', () => {
    const { clock, events, advance } = rig([ENDED]);
    clock.start();

    advance(5_000);

    expect(events).toEqual([]);
    clock.stop();
  });

  it('sees sessions as they come and go between ticks', () => {
    const sessions: Session[] = [RUNNING_A];
    const { clock, events, advance } = rig(sessions);
    clock.start();

    advance(5_000);
    sessions.push(RUNNING_B);
    sessions[0] = { ...RUNNING_A, status: 'ended' };
    advance(5_000);

    expect(events.map((e) => [e.sessionId, e.ts])).toEqual([
      [RUNNING_A.id, T0 + 5_000],
      [RUNNING_B.id, T0 + 10_000],
    ]);
    clock.stop();
  });

  it('emits no ticks after stop, and clears its interval', () => {
    const { clock, events, advance, fake } = rig([RUNNING_A]);
    clock.start();
    advance(5_000);

    clock.stop();
    advance(5_000);

    expect(events).toHaveLength(1);
    expect(fake.active.size).toBe(0);
  });
});
