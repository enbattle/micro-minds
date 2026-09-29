// Task 2.1, clauses 7, 8, 11, 12 and 13: activity per PLAN §4.3, the attention channel,
// subagents, usage totals and purity of reduce().
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, UsageDelta, WorldState } from './index.ts';
import { createWorld, DEFAULT_THRESHOLDS, reduce } from './index.ts';
import {
  agentOf,
  ev,
  GHOST,
  loadEventFixture,
  MIN,
  ROOT,
  run,
  SEC,
  SUB,
  T0,
  tick,
} from './shared.test-helpers.ts';

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

const started = ev('session.started', { ts: T0 });
const prompted = ev('prompt.submitted', { ts: T0 + 1 * SEC });
const execStarted = ev('tool.started', {
  ts: T0 + 2 * SEC,
  tool: { name: 'Bash', category: 'exec', useId: 'toolu_01' },
});
const spawned = ev('agent.spawned', { ts: T0 + 3 * SEC, agentId: SUB, parentAgentId: ROOT });

describe('activity per PLAN §4.3', () => {
  it('session.started creates the root agent as starting → idle', () => {
    const world = run([started]);
    const root = agentOf(world, ROOT);
    expect(['starting', 'idle']).toContain(root.activity);
    expect(root.sessionId).toBe(ROOT);
    expect(root.provider).toBe('claude');
    expect(root.health).toBe('ok');
  });

  it.each<{ name: string; events: AgentEvent[]; agentId: string; expected: string }>([
    {
      name: 'prompt.submitted → thinking',
      events: [started, prompted],
      agentId: ROOT,
      expected: 'thinking',
    },
    ...(['read', 'web'] as const).map((category) => ({
      name: `tool.started ${category} → reading`,
      events: [
        started,
        prompted,
        ev('tool.started', { ts: T0 + 2 * SEC, tool: { name: 'X', category } }),
      ],
      agentId: ROOT,
      expected: 'reading',
    })),
    {
      name: 'tool.started write → writing',
      events: [
        started,
        prompted,
        ev('tool.started', { ts: T0 + 2 * SEC, tool: { name: 'Edit', category: 'write' } }),
      ],
      agentId: ROOT,
      expected: 'writing',
    },
    {
      name: 'tool.started exec → running',
      events: [started, prompted, execStarted],
      agentId: ROOT,
      expected: 'running',
    },
    {
      name: 'tool.started delegate → delegating',
      events: [
        started,
        prompted,
        ev('tool.started', { ts: T0 + 2 * SEC, tool: { name: 'Agent', category: 'delegate' } }),
      ],
      agentId: ROOT,
      expected: 'delegating',
    },
    {
      name: 'tool.finished → thinking',
      events: [
        started,
        prompted,
        execStarted,
        ev('tool.finished', { ts: T0 + 4 * SEC, tool: { name: 'Bash', category: 'exec' } }),
      ],
      agentId: ROOT,
      expected: 'thinking',
    },
    {
      name: 'tool.failed → thinking',
      events: [
        started,
        prompted,
        execStarted,
        ev('tool.failed', { ts: T0 + 4 * SEC, tool: { name: 'Bash', category: 'exec' } }),
      ],
      agentId: ROOT,
      expected: 'thinking',
    },
    {
      name: 'attention.permission → waiting_permission',
      events: [started, prompted, execStarted, ev('attention.permission', { ts: T0 + 3 * SEC })],
      agentId: ROOT,
      expected: 'waiting_permission',
    },
    {
      name: 'attention.question → waiting_input',
      events: [started, prompted, ev('attention.question', { ts: T0 + 3 * SEC })],
      agentId: ROOT,
      expected: 'waiting_input',
    },
    {
      name: 'attention.idle → waiting_input',
      events: [started, prompted, ev('attention.idle', { ts: T0 + 3 * SEC })],
      agentId: ROOT,
      expected: 'waiting_input',
    },
    {
      name: 'turn.finished → idle',
      events: [started, prompted, ev('turn.finished', { ts: T0 + 3 * SEC })],
      agentId: ROOT,
      expected: 'idle',
    },
    {
      name: 'agent.finished → child done',
      events: [
        started,
        prompted,
        spawned,
        ev('agent.finished', { ts: T0 + 9 * SEC, agentId: SUB, parentAgentId: ROOT }),
      ],
      agentId: SUB,
      expected: 'done',
    },
    {
      name: 'session.ended → offline',
      events: [started, prompted, ev('session.ended', { ts: T0 + 3 * SEC })],
      agentId: ROOT,
      expected: 'offline',
    },
    {
      name: 'clock.tick leaves running unchanged',
      events: [started, prompted, execStarted, tick(T0 + 1 * MIN)],
      agentId: ROOT,
      expected: 'running',
    },
    {
      name: 'clock.tick leaves idle unchanged',
      events: [started, prompted, ev('turn.finished', { ts: T0 + 3 * SEC }), tick(T0 + 30 * MIN)],
      agentId: ROOT,
      expected: 'idle',
    },
    {
      name: 'usage.recorded leaves running unchanged',
      events: [
        started,
        prompted,
        execStarted,
        ev('usage.recorded', { ts: T0 + 3 * SEC, usage: usage('claude-opus-5-5', 1, 0.25) }),
      ],
      agentId: ROOT,
      expected: 'running',
    },
  ])('$name', ({ events, agentId, expected }) => {
    expect(agentOf(run(events), agentId).activity).toBe(expected);
  });

  it('a subagent’s own events drive the subagent, not its parent', () => {
    const world = run([
      started,
      prompted,
      spawned,
      ev('tool.started', {
        ts: T0 + 4 * SEC,
        agentId: SUB,
        parentAgentId: ROOT,
        tool: { name: 'Bash', category: 'exec' },
      }),
    ]);
    expect(agentOf(world, SUB).activity).toBe('running');
    expect(agentOf(world, ROOT).activity).toBe('thinking');
  });
});

describe('attention is a separate channel (PLAN §4.3, §6)', () => {
  const permission = ev('attention.permission', { ts: T0 + 3 * SEC });
  const question = ev('attention.question', { ts: T0 + 3 * SEC });
  const idle = ev('attention.idle', { ts: T0 + 3 * SEC });

  it.each([
    { name: 'attention.permission sets permission', event: permission, expected: 'permission' },
    { name: 'attention.question sets question', event: question, expected: 'question' },
    { name: 'attention.idle sets idle', event: idle, expected: 'idle' },
  ])('$name', ({ event, expected }) => {
    expect(agentOf(run([started, prompted, event]), ROOT).attention).toBe(expected);
  });

  it.each([
    { name: 'permission', event: permission },
    { name: 'question', event: question },
    { name: 'idle', event: idle },
  ])('prompt.submitted clears $name attention', ({ event }) => {
    const world = run([started, prompted, event, ev('prompt.submitted', { ts: T0 + 10 * SEC })]);
    expect(agentOf(world, ROOT).attention).toBeUndefined();
  });

  it.each([
    { name: 'tool.finished', kind: 'tool.finished' as const },
    { name: 'tool.failed', kind: 'tool.failed' as const },
  ])('$name clears a permission attention', ({ kind }) => {
    const world = run([
      started,
      prompted,
      execStarted,
      permission,
      ev(kind, { ts: T0 + 10 * SEC, tool: { name: 'Bash', category: 'exec' } }),
    ]);
    expect(agentOf(world, ROOT).attention).toBeUndefined();
  });

  it('attention does not change health', () => {
    const world = run([started, prompted, execStarted, permission]);
    expect(agentOf(world, ROOT).health).toBe('ok');
  });

  it('attention keeps an existing health problem as it is', () => {
    const world = run([
      started,
      prompted,
      execStarted,
      ev('tool.failed', { ts: T0 + 3 * SEC, tool: { name: 'Bash', category: 'exec' } }),
      ev('attention.permission', { ts: T0 + 4 * SEC }),
    ]);
    const root = agentOf(world, ROOT);
    expect(root.health).toBe('notice');
    expect(root.attention).toBe('permission');
  });
});

describe('subagents (PLAN §4.2; docs/protocols/claude.md finding 6)', () => {
  it('agent.spawned creates the child with its parentAgentId and adds it to the parent’s children', () => {
    const world = run([started, prompted, spawned]);
    const child = agentOf(world, SUB);
    expect(child.parentAgentId).toBe(ROOT);
    expect(child.sessionId).toBe(ROOT);
    expect(child.provider).toBe('claude');
    expect(agentOf(world, ROOT).children).toEqual([SUB]);
    expect(child.children).toEqual([]);
  });

  it('agent.finished moves the child to done and keeps it linked to the parent', () => {
    const world = run([
      started,
      prompted,
      spawned,
      ev('agent.finished', { ts: T0 + 9 * SEC, agentId: SUB, parentAgentId: ROOT }),
    ]);
    expect(agentOf(world, SUB).activity).toBe('done');
    expect(agentOf(world, SUB).parentAgentId).toBe(ROOT);
  });

  it.each<{ name: string; event: AgentEvent }>([
    {
      name: 'agent.finished',
      event: ev('agent.finished', { ts: T0 + 5 * SEC, agentId: GHOST, parentAgentId: ROOT }),
    },
    {
      name: 'tool.started',
      event: ev('tool.started', {
        ts: T0 + 5 * SEC,
        agentId: GHOST,
        parentAgentId: ROOT,
        tool: { name: 'Bash', category: 'exec' },
      }),
    },
    {
      name: 'tool.failed',
      event: ev('tool.failed', {
        ts: T0 + 5 * SEC,
        agentId: GHOST,
        parentAgentId: ROOT,
        tool: { name: 'Bash', category: 'exec' },
      }),
    },
    {
      name: 'attention.permission',
      event: ev('attention.permission', { ts: T0 + 5 * SEC, agentId: GHOST, parentAgentId: ROOT }),
    },
    {
      name: 'usage.recorded',
      event: ev('usage.recorded', {
        ts: T0 + 5 * SEC,
        agentId: GHOST,
        parentAgentId: ROOT,
        usage: usage('claude-opus-5-5', 1, 0.25),
      }),
    },
    {
      name: 'agent.finished whose parent is unknown too',
      event: ev('agent.finished', { ts: T0 + 5 * SEC, agentId: GHOST, parentAgentId: 'nobody' }),
    },
  ])('$name for a never-spawned agent creates no agent and does not throw', ({ event }) => {
    const before = run([started, prompted, spawned]);
    let after: WorldState = before;
    expect(() => {
      after = reduce(before, event, DEFAULT_THRESHOLDS);
    }).not.toThrow();
    expect(Object.keys(after.agents).sort()).toEqual([ROOT, SUB].sort());
    expect(agentOf(after, ROOT).children).toEqual([SUB]);
    expect(agentOf(after, ROOT).activity).toBe('thinking');
    expect(agentOf(after, SUB).activity).toBe(agentOf(before, SUB).activity);
  });

  it('a ghost agent.finished on an empty world creates nothing and does not throw', () => {
    let after: WorldState = createWorld();
    expect(() => {
      after = run([ev('agent.finished', { ts: T0, agentId: GHOST, parentAgentId: ROOT })]);
    }).not.toThrow();
    expect(Object.keys(after.agents)).toEqual([]);
  });
});

describe('usage.recorded (PLAN §4.2, §5.7)', () => {
  const zeroish = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };

  it('adds one delta to the total and to its model', () => {
    const world = run([
      started,
      ev('usage.recorded', { ts: T0 + SEC, usage: usage('claude-opus-5-5', 10, 0.25) }),
    ]);
    const expected = {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      costUsd: 0.25,
    };
    expect(agentOf(world, ROOT).usage).toEqual({
      total: expected,
      byModel: { 'claude-opus-5-5': expected },
    });
  });

  it('sums deltas overall and per model', () => {
    const world = run([
      started,
      ev('usage.recorded', { ts: T0 + 1 * SEC, usage: usage('claude-opus-5-5', 10, 0.25) }),
      ev('usage.recorded', {
        ts: T0 + 2 * SEC,
        usage: usage('claude-haiku-4-5-20251001', 1, 0.125),
      }),
      ev('usage.recorded', { ts: T0 + 3 * SEC, usage: usage('claude-opus-5-5', 5, 0.5) }),
    ]);
    expect(agentOf(world, ROOT).usage).toEqual({
      total: {
        inputTokens: 16,
        outputTokens: 32,
        cacheReadTokens: 48,
        cacheWriteTokens: 64,
        costUsd: 0.875,
      },
      byModel: {
        'claude-opus-5-5': {
          inputTokens: 15,
          outputTokens: 30,
          cacheReadTokens: 45,
          cacheWriteTokens: 60,
          costUsd: 0.75,
        },
        'claude-haiku-4-5-20251001': {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          costUsd: 0.125,
        },
      },
    });
  });

  it('a zero delta leaves the totals at zero', () => {
    const world = run([
      started,
      ev('usage.recorded', { ts: T0 + SEC, usage: { ...usage('m', 0, 0), ...zeroish } }),
    ]);
    expect(agentOf(world, ROOT).usage?.total).toEqual(zeroish);
  });

  it.each<{ name: string; setup: AgentEvent[] }>([
    { name: 'a running agent', setup: [started, prompted, execStarted] },
    {
      name: 'an idle agent',
      setup: [started, prompted, ev('turn.finished', { ts: T0 + 3 * SEC })],
    },
    {
      name: 'a waiting agent with notice health and a raised hand',
      setup: [
        started,
        prompted,
        execStarted,
        ev('tool.failed', { ts: T0 + 3 * SEC, tool: { name: 'Bash', category: 'exec' } }),
        ev('attention.permission', { ts: T0 + 4 * SEC }),
      ],
    },
    {
      name: 'an agent in error',
      setup: [started, prompted, ev('turn.failed', { ts: T0 + 3 * SEC, errorClass: 'rate_limit' })],
    },
    {
      name: 'a stuck agent in warning',
      setup: [started, prompted, execStarted, tick(T0 + 2 * SEC + 11 * MIN)],
    },
  ])('never changes activity, health or attention of $name', ({ setup }) => {
    const before = agentOf(run(setup), ROOT);
    const after = agentOf(
      run([
        ...setup,
        ev('usage.recorded', {
          ts: T0 + 2 * SEC + 11 * MIN + 1,
          usage: usage('claude-opus-5-5', 7, 0.5),
        }),
      ]),
      ROOT,
    );
    expect({
      activity: after.activity,
      health: after.health,
      attention: after.attention,
    }).toEqual({ activity: before.activity, health: before.health, attention: before.attention });
  });
});

describe('reduce() is pure (D15, hard rule 9)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // A failure that decays back to ok, then the agent goes quiet long enough to look stuck.
  const scenario = (): AgentEvent[] => [
    ...loadEventFixture('failure-decay'),
    tick(T0 + 7 * SEC + 12 * MIN),
  ];

  it('reads no clock and no randomness', () => {
    const expected = run(scenario());
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('reduce() read Date.now()');
    });
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('reduce() read Math.random()');
    });
    expect(run(scenario())).toEqual(expected);
  });

  it('gives the same result whatever the wall clock says', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const early = run(scenario());
    vi.setSystemTime(new Date(T0 + 365 * 24 * 60 * MIN));
    const late = run(scenario());
    expect(late).toEqual(early);
  });

  it('never mutates its input state or event', () => {
    const deepFreeze = <T>(value: T): T => {
      if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) {
          deepFreeze((value as Record<string, unknown>)[key]);
        }
      }
      return value;
    };
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    let world = createWorld();
    for (const event of [
      ...loadEventFixture('subagent'),
      ...loadEventFixture('repeated-failures'),
    ]) {
      const frozenWorld = deepFreeze(clone(world));
      const snapshot = clone(frozenWorld);
      const frozenEvent = deepFreeze(clone(event));
      expect(() => {
        world = reduce(frozenWorld, frozenEvent, DEFAULT_THRESHOLDS);
      }).not.toThrow();
      expect(frozenWorld).toEqual(snapshot);
    }
  });

  it('the same state and event always give the same result', () => {
    const state = run([started, prompted, execStarted]);
    const event = tick(T0 + 20 * MIN);
    expect(reduce(state, event, DEFAULT_THRESHOLDS)).toEqual(
      reduce(state, event, DEFAULT_THRESHOLDS),
    );
  });
});
