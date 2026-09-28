// Task 2.1, clauses 7, 9, 11 and 12 with two sessions in one world. An event's `sessionId` is our
// session id, stamped by the server from the authenticated route (PLAN §4.1, hard rule 4), while
// `agentId` comes from the provider payload. An event from one session must never change an agent
// of another session, whatever agent id it names.
import { describe, expect, it } from 'vitest';
import type { AgentEvent, EventKind, UsageDelta, WorldState } from './index.ts';
import { DEFAULT_THRESHOLDS, reduce } from './index.ts';
import type { EventInit } from './shared.test-helpers.ts';
import { agentOf, ev, ROOT, run, SEC, SESSION_ID, SUB, T0 } from './shared.test-helpers.ts';

/** A second session in the same world. Its root agent's id equals it (PLAN §4.1). */
const SESSION_B = '01K6A2B3C4D5E6F7G8H9J0K1M3';
const ROOT_B = SESSION_B;
/** Session B's own subagent. */
const SUB_B = 'b7e4d1c09a8f3265';
/** A subagent id that session B claims to spawn under session A's root. */
const INTRUDER = 'c1d2e3f4a5b6c7d8';

/** An event stamped with session B's id; it names B's root agent unless `agentId` says otherwise. */
function evB(kind: EventKind, init: EventInit): AgentEvent {
  return { ...ev(kind, init), sessionId: SESSION_B, agentId: init.agentId ?? ROOT_B };
}

function usage(model: string, n: number, costUsd: number): UsageDelta {
  return {
    model,
    source: 'otel',
    inputTokens: n,
    outputTokens: n * 2,
    cacheReadTokens: n * 3,
    cacheWriteTokens: n * 4,
    costUsd,
  };
}

const exec = { name: 'Bash', category: 'exec' } as const;

/**
 * Session A: root running a Bash tool, one subagent running, some usage recorded.
 * Session B: root thinking after a prompt.
 */
function twoSessions(): WorldState {
  return run([
    ev('session.started', { ts: T0 }),
    evB('session.started', { ts: T0 + 1 * SEC }),
    ev('prompt.submitted', { ts: T0 + 2 * SEC }),
    evB('prompt.submitted', { ts: T0 + 3 * SEC }),
    ev('tool.started', { ts: T0 + 4 * SEC, tool: { ...exec, useId: 'toolu_a1' } }),
    ev('agent.spawned', { ts: T0 + 5 * SEC, agentId: SUB, parentAgentId: ROOT, text: 'explorer' }),
    ev('tool.started', { ts: T0 + 6 * SEC, agentId: SUB, parentAgentId: ROOT, tool: exec }),
    ev('usage.recorded', { ts: T0 + 7 * SEC, usage: usage('claude-opus-5-5', 10, 0.25) }),
  ]);
}

function agentsOfSession(world: WorldState, sessionId: string): WorldState['agents'] {
  return Object.fromEntries(
    Object.entries(world.agents).filter(([, agent]) => agent.sessionId === sessionId),
  );
}

describe('the two-session setup', () => {
  it('holds both sessions side by side', () => {
    const world = twoSessions();
    expect(Object.keys(world.agents).sort()).toEqual([ROOT, ROOT_B, SUB].sort());
    expect(agentOf(world, ROOT).activity).toBe('running');
    expect(agentOf(world, SUB).activity).toBe('running');
    expect(agentOf(world, ROOT_B).activity).toBe('thinking');
    expect(agentOf(world, ROOT_B).sessionId).toBe(SESSION_B);
    expect(agentOf(world, ROOT).children).toEqual([SUB]);
    expect(agentOf(world, ROOT_B).children).toEqual([]);
  });
});

describe('an event from another session never changes this session’s agents', () => {
  const at = T0 + 10 * SEC;

  it.each<{ name: string; event: AgentEvent }>([
    {
      name: 'prompt.submitted naming A’s root',
      event: evB('prompt.submitted', { ts: at, agentId: ROOT }),
    },
    {
      name: 'tool.started naming A’s root',
      event: evB('tool.started', {
        ts: at,
        agentId: ROOT,
        tool: { name: 'Edit', category: 'write' },
      }),
    },
    {
      name: 'tool.finished naming A’s root',
      event: evB('tool.finished', { ts: at, agentId: ROOT, tool: exec }),
    },
    {
      name: 'tool.failed naming A’s subagent',
      event: evB('tool.failed', { ts: at, agentId: SUB, parentAgentId: ROOT, tool: exec }),
    },
    {
      name: 'tool.finished with a blocking errorClass naming A’s subagent',
      event: evB('tool.finished', {
        ts: at,
        agentId: SUB,
        parentAgentId: ROOT,
        tool: exec,
        errorClass: 'auth',
      }),
    },
    {
      name: 'attention.permission naming A’s root',
      event: evB('attention.permission', { ts: at, agentId: ROOT }),
    },
    {
      name: 'turn.finished naming A’s root',
      event: evB('turn.finished', { ts: at, agentId: ROOT }),
    },
    {
      name: 'turn.failed rate_limit naming A’s root',
      event: evB('turn.failed', { ts: at, agentId: ROOT, errorClass: 'rate_limit' }),
    },
    {
      name: 'turn.failed auth naming A’s subagent',
      event: evB('turn.failed', { ts: at, agentId: SUB, parentAgentId: ROOT, errorClass: 'auth' }),
    },
    {
      name: 'agent.spawned under A’s root',
      event: evB('agent.spawned', { ts: at, agentId: INTRUDER, parentAgentId: ROOT, text: 'x' }),
    },
    {
      name: 'agent.spawned under A’s subagent',
      event: evB('agent.spawned', { ts: at, agentId: INTRUDER, parentAgentId: SUB, text: 'x' }),
    },
    {
      name: 'agent.finished naming A’s subagent',
      event: evB('agent.finished', { ts: at, agentId: SUB, parentAgentId: ROOT }),
    },
    {
      name: 'session.ended naming A’s root',
      event: evB('session.ended', { ts: at, agentId: ROOT }),
    },
    {
      name: 'session.ended with a blocking errorClass naming A’s root',
      event: evB('session.ended', { ts: at, agentId: ROOT, errorClass: 'budget' }),
    },
    {
      name: 'session.crashed naming A’s root',
      event: evB('session.crashed', { ts: at, agentId: ROOT }),
    },
    {
      name: 'session.started naming A’s root',
      event: evB('session.started', { ts: at, agentId: ROOT }),
    },
    {
      name: 'usage.recorded naming A’s root',
      event: evB('usage.recorded', {
        ts: at,
        agentId: ROOT,
        usage: usage('claude-opus-5-5', 5, 0.5),
      }),
    },
    {
      name: 'usage.recorded naming A’s subagent',
      event: evB('usage.recorded', {
        ts: at,
        agentId: SUB,
        parentAgentId: ROOT,
        usage: usage('claude-haiku-4-5-20251001', 3, 0.125),
      }),
    },
  ])('session B $name leaves session A unchanged and adds no agent', ({ event }) => {
    const before = twoSessions();
    let after: WorldState = before;
    expect(() => {
      after = reduce(before, event, DEFAULT_THRESHOLDS);
    }).not.toThrow();
    expect(agentsOfSession(after, SESSION_ID)).toEqual(agentsOfSession(before, SESSION_ID));
    expect(Object.keys(after.agents).sort()).toEqual(Object.keys(before.agents).sort());
    expect(after.agents[INTRUDER]).toBeUndefined();
  });

  it('session A events naming B’s root leave session B unchanged', () => {
    const before = twoSessions();
    const events: AgentEvent[] = [
      ev('tool.started', { ts: T0 + 10 * SEC, agentId: ROOT_B, tool: exec }),
      ev('turn.failed', { ts: T0 + 11 * SEC, agentId: ROOT_B, errorClass: 'rate_limit' }),
      ev('agent.spawned', { ts: T0 + 12 * SEC, agentId: INTRUDER, parentAgentId: ROOT_B }),
      ev('usage.recorded', {
        ts: T0 + 13 * SEC,
        agentId: ROOT_B,
        usage: usage('claude-opus-5-5', 5, 0.5),
      }),
      ev('session.ended', { ts: T0 + 14 * SEC, agentId: ROOT_B }),
    ];
    const after = run(events, DEFAULT_THRESHOLDS, before);
    expect(agentsOfSession(after, SESSION_B)).toEqual(agentsOfSession(before, SESSION_B));
    expect(after.agents[INTRUDER]).toBeUndefined();
  });
});

describe('each session’s own events still work with two sessions in the world', () => {
  const at = T0 + 10 * SEC;

  it.each<{
    name: string;
    event: AgentEvent;
    check: (world: WorldState) => void;
  }>([
    {
      name: 'B tool.started exec → B root running',
      event: evB('tool.started', { ts: at, tool: exec }),
      check: (world) => expect(agentOf(world, ROOT_B).activity).toBe('running'),
    },
    {
      name: 'B tool.failed once → B root notice',
      event: evB('tool.failed', { ts: at, tool: exec }),
      check: (world) => {
        expect(agentOf(world, ROOT_B).activity).toBe('thinking');
        expect(agentOf(world, ROOT_B).health).toBe('notice');
      },
    },
    {
      name: 'B turn.failed rate_limit → B root error',
      event: evB('turn.failed', { ts: at, errorClass: 'rate_limit' }),
      check: (world) => expect(agentOf(world, ROOT_B).health).toBe('error'),
    },
    {
      name: 'B agent.spawned → child of B root',
      event: evB('agent.spawned', { ts: at, agentId: SUB_B, parentAgentId: ROOT_B, text: 'b' }),
      check: (world) => {
        const child = agentOf(world, SUB_B);
        expect(child.parentAgentId).toBe(ROOT_B);
        expect(child.sessionId).toBe(SESSION_B);
        expect(agentOf(world, ROOT_B).children).toEqual([SUB_B]);
      },
    },
    {
      name: 'B session.ended → B root offline',
      event: evB('session.ended', { ts: at }),
      check: (world) => expect(agentOf(world, ROOT_B).activity).toBe('offline'),
    },
    {
      name: 'B usage.recorded → B root usage totals',
      event: evB('usage.recorded', { ts: at, usage: usage('claude-opus-5-5', 5, 0.5) }),
      check: (world) =>
        expect(agentOf(world, ROOT_B).usage?.total).toEqual({
          inputTokens: 5,
          outputTokens: 10,
          cacheReadTokens: 15,
          cacheWriteTokens: 20,
          costUsd: 0.5,
        }),
    },
  ])('$name, and session A is untouched', ({ event, check }) => {
    const before = twoSessions();
    const after = reduce(before, event, DEFAULT_THRESHOLDS);
    check(after);
    expect(agentsOfSession(after, SESSION_ID)).toEqual(agentsOfSession(before, SESSION_ID));
  });

  it.each<{
    name: string;
    event: AgentEvent;
    check: (world: WorldState) => void;
  }>([
    {
      name: 'A subagent tool.failed → A subagent notice',
      event: ev('tool.failed', { ts: at, agentId: SUB, parentAgentId: ROOT, tool: exec }),
      check: (world) => expect(agentOf(world, SUB).health).toBe('notice'),
    },
    {
      name: 'A turn.failed auth → A root error',
      event: ev('turn.failed', { ts: at, errorClass: 'auth' }),
      check: (world) => expect(agentOf(world, ROOT).health).toBe('error'),
    },
    {
      name: 'A usage.recorded → adds to A root usage',
      event: ev('usage.recorded', { ts: at, usage: usage('claude-opus-5-5', 5, 0.5) }),
      check: (world) =>
        expect(agentOf(world, ROOT).usage?.total).toEqual({
          inputTokens: 15,
          outputTokens: 30,
          cacheReadTokens: 45,
          cacheWriteTokens: 60,
          costUsd: 0.75,
        }),
    },
    {
      name: 'A session.ended → A root and subagent offline',
      event: ev('session.ended', { ts: at }),
      check: (world) => {
        expect(agentOf(world, ROOT).activity).toBe('offline');
        expect(agentOf(world, SUB).activity).toBe('offline');
      },
    },
  ])('$name, and session B is untouched', ({ event, check }) => {
    const before = twoSessions();
    const after = reduce(before, event, DEFAULT_THRESHOLDS);
    check(after);
    expect(agentsOfSession(after, SESSION_B)).toEqual(agentsOfSession(before, SESSION_B));
  });
});
