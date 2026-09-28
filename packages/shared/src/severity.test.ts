// Task 2.1, clauses 6, 9 and 10: health per PLAN §6, driven through reduce() and clock.tick,
// with every threshold taken from the Thresholds object passed as reduce()'s third parameter.
import { describe, expect, it } from 'vitest';
import type { AgentEvent, Thresholds, ToolCategory } from './index.ts';
import { DEFAULT_THRESHOLDS } from './index.ts';
import { agentOf, ev, MIN, ROOT, run, SEC, SUB, T0, tick } from './shared.test-helpers.ts';

const started = ev('session.started', { ts: T0 });
const prompted = ev('prompt.submitted', { ts: T0 + 1 * SEC });

function toolStart(ts: number, name: string, category: ToolCategory = 'exec'): AgentEvent {
  return ev('tool.started', { ts, tool: { name, category } });
}

function toolFail(ts: number, name: string, category: ToolCategory = 'exec'): AgentEvent {
  return ev('tool.failed', { ts, tool: { name, category } });
}

/** A tool call that fails `at` ms after T0. */
function failedCall(at: number, name: string): AgentEvent[] {
  return [toolStart(T0 + at - 500, name), toolFail(T0 + at, name)];
}

function healthAfter(events: AgentEvent[], cfg: Thresholds = DEFAULT_THRESHOLDS): string {
  return agentOf(run([started, prompted, ...events], cfg), ROOT).health;
}

describe('Thresholds (PLAN §6)', () => {
  it('DEFAULT_THRESHOLDS holds the §6 values', () => {
    expect(DEFAULT_THRESHOLDS).toMatchObject({
      failureWindowMs: 5 * MIN,
      failuresForWarning: 3,
      stuckAfterMs: 10 * MIN,
      recoveryAfterMs: 5 * MIN,
    });
  });

  it.each<{
    name: string;
    events: AgentEvent[];
    cfg: Partial<Thresholds>;
    byDefault: string;
    withCfg: string;
  }>([
    {
      name: 'failuresForWarning: 2 turns two different failures into a warning',
      events: [...failedCall(10 * SEC, 'Bash'), ...failedCall(20 * SEC, 'Read')],
      cfg: { failuresForWarning: 2 },
      byDefault: 'notice',
      withCfg: 'warning',
    },
    {
      name: 'failureWindowMs: 1 min keeps three failures 90 s apart from counting together',
      events: [
        ...failedCall(10 * SEC, 'Bash'),
        ...failedCall(10 * SEC + 90 * SEC, 'Read'),
        ...failedCall(10 * SEC + 180 * SEC, 'Grep'),
      ],
      cfg: { failureWindowMs: 1 * MIN },
      byDefault: 'warning',
      withCfg: 'notice',
    },
    {
      name: 'stuckAfterMs: 2 min flags a quiet running agent at 3 min',
      events: [toolStart(T0 + 2 * SEC, 'Bash'), tick(T0 + 2 * SEC + 3 * MIN)],
      cfg: { stuckAfterMs: 2 * MIN },
      byDefault: 'ok',
      withCfg: 'warning',
    },
    {
      name: 'recoveryAfterMs: 1 min clears a notice 2 min after the failure',
      events: [...failedCall(10 * SEC, 'Bash'), tick(T0 + 10 * SEC + 2 * MIN)],
      cfg: { recoveryAfterMs: 1 * MIN },
      byDefault: 'notice',
      withCfg: 'ok',
    },
  ])('$name', ({ events, cfg, byDefault, withCfg }) => {
    expect(healthAfter(events)).toBe(byDefault);
    expect(healthAfter(events, { ...DEFAULT_THRESHOLDS, ...cfg })).toBe(withCfg);
  });
});

describe('health from tool failures (PLAN §6)', () => {
  it.each<{ name: string; events: AgentEvent[]; expected: string }>([
    { name: 'no failures → ok', events: [toolStart(T0 + 2 * SEC, 'Bash')], expected: 'ok' },
    {
      name: 'one tool.failed → notice, not warning or error',
      events: failedCall(10 * SEC, 'Bash'),
      expected: 'notice',
    },
    {
      name: 'two failures of different tools → notice',
      events: [...failedCall(10 * SEC, 'Bash'), ...failedCall(20 * SEC, 'Read')],
      expected: 'notice',
    },
    {
      name: 'three failures of different tools within 5 min → warning',
      events: [
        ...failedCall(10 * SEC, 'Bash'),
        ...failedCall(1 * MIN, 'Read'),
        ...failedCall(2 * MIN, 'Grep'),
      ],
      expected: 'warning',
    },
    {
      name: 'three failures with a success between them, still within 5 min → warning',
      events: [
        ...failedCall(10 * SEC, 'Bash'),
        toolStart(T0 + 30 * SEC, 'Edit', 'write'),
        ev('tool.finished', { ts: T0 + 31 * SEC, tool: { name: 'Edit', category: 'write' } }),
        ...failedCall(1 * MIN, 'Read'),
        ...failedCall(2 * MIN, 'Grep'),
      ],
      expected: 'warning',
    },
    {
      name: 'three failures of different tools 6 min apart → notice (outside the window)',
      events: [
        ...failedCall(10 * SEC, 'Bash'),
        ...failedCall(10 * SEC + 6 * MIN, 'Read'),
        ...failedCall(10 * SEC + 12 * MIN, 'Grep'),
      ],
      expected: 'notice',
    },
    {
      name: 'the same tool failing twice in a row → warning',
      events: [...failedCall(10 * SEC, 'Bash'), ...failedCall(20 * SEC, 'Bash')],
      expected: 'warning',
    },
    {
      name: 'tool.failed with errorClass other → notice',
      events: [
        toolStart(T0 + 2 * SEC, 'Bash'),
        ev('tool.failed', {
          ts: T0 + 3 * SEC,
          tool: { name: 'Bash', category: 'exec' },
          errorClass: 'other',
        }),
      ],
      expected: 'notice',
    },
  ])('$name', ({ events, expected }) => {
    expect(healthAfter(events)).toBe(expected);
  });
});

describe('health from errors (PLAN §6)', () => {
  it.each<{ name: string; event: AgentEvent }>([
    { name: 'turn.failed', event: ev('turn.failed', { ts: T0 + 5 * SEC }) },
    { name: 'session.crashed', event: ev('session.crashed', { ts: T0 + 5 * SEC }) },
    ...(['rate_limit', 'auth', 'budget'] as const).flatMap((errorClass) => [
      {
        name: `turn.failed with errorClass ${errorClass}`,
        event: ev('turn.failed', { ts: T0 + 5 * SEC, errorClass }),
      },
      {
        name: `tool.failed with errorClass ${errorClass}`,
        event: ev('tool.failed', {
          ts: T0 + 5 * SEC,
          tool: { name: 'WebFetch', category: 'web' },
          errorClass,
        }),
      },
    ]),
  ])('$name → error', ({ event }) => {
    expect(healthAfter([event])).toBe('error');
  });

  it('an error outranks an earlier warning', () => {
    expect(
      healthAfter([
        ...failedCall(10 * SEC, 'Bash'),
        ...failedCall(20 * SEC, 'Bash'),
        ev('turn.failed', { ts: T0 + 30 * SEC, errorClass: 'rate_limit' }),
      ]),
    ).toBe('error');
  });

  it('a subagent’s failure sets the subagent’s health, not the parent’s', () => {
    const world = run([
      started,
      prompted,
      ev('agent.spawned', { ts: T0 + 2 * SEC, agentId: SUB, parentAgentId: ROOT }),
      ev('tool.failed', {
        ts: T0 + 3 * SEC,
        agentId: SUB,
        parentAgentId: ROOT,
        tool: { name: 'Bash', category: 'exec' },
      }),
    ]);
    expect(agentOf(world, SUB).health).toBe('notice');
    expect(agentOf(world, ROOT).health).toBe('ok');
  });
});

describe('stuck: no events for more than 10 min while working (PLAN §6, on clock.tick)', () => {
  const last = T0 + 2 * SEC;
  const working: { name: string; lastEvent: AgentEvent }[] = [
    { name: 'thinking', lastEvent: ev('prompt.submitted', { ts: last }) },
    { name: 'running', lastEvent: toolStart(last, 'Bash', 'exec') },
    { name: 'delegating', lastEvent: toolStart(last, 'Agent', 'delegate') },
  ];

  it.each(working)('$name, quiet for 11 min → warning on the tick', ({ lastEvent }) => {
    expect(healthAfter([lastEvent, tick(last + 11 * MIN)])).toBe('warning');
  });

  it.each(working)('$name, quiet for 9 min → still ok', ({ lastEvent }) => {
    expect(healthAfter([lastEvent, tick(last + 9 * MIN)])).toBe('ok');
  });

  it.each(working)(
    '$name, with no clock.tick → still ok (staleness is only evaluated on a tick)',
    ({ lastEvent }) => {
      expect(healthAfter([lastEvent])).toBe('ok');
    },
  );

  it('ticks do not count as events: many ticks still end in warning', () => {
    const ticks = Array.from({ length: 12 }, (_, i) => tick(last + (i + 1) * MIN));
    expect(healthAfter([toolStart(last, 'Bash'), ...ticks])).toBe('warning');
  });

  it.each<{ name: string; lastEvent: AgentEvent }>([
    { name: 'idle after turn.finished', lastEvent: ev('turn.finished', { ts: last }) },
    { name: 'waiting_permission', lastEvent: ev('attention.permission', { ts: last }) },
    { name: 'waiting_input (question)', lastEvent: ev('attention.question', { ts: last }) },
    { name: 'waiting_input (idle notice)', lastEvent: ev('attention.idle', { ts: last }) },
    { name: 'offline after session.ended', lastEvent: ev('session.ended', { ts: last }) },
  ])('$name, quiet for 30 min → not stuck', ({ lastEvent }) => {
    expect(healthAfter([lastEvent, tick(last + 30 * MIN)])).toBe('ok');
  });
});

describe('recovery (PLAN §6, §4.3)', () => {
  it.each<{ name: string; events: AgentEvent[]; expected: string }>([
    {
      name: 'notice → ok on a tick 6 min after the failure',
      events: [...failedCall(10 * SEC, 'Bash'), tick(T0 + 10 * SEC + 6 * MIN)],
      expected: 'ok',
    },
    {
      name: 'notice stays on a tick 4 min after the failure',
      events: [...failedCall(10 * SEC, 'Bash'), tick(T0 + 10 * SEC + 4 * MIN)],
      expected: 'notice',
    },
    {
      name: 'warning (3 failures) → ok on a tick 6 min after the last failure',
      events: [
        ...failedCall(10 * SEC, 'Bash'),
        ...failedCall(1 * MIN, 'Read'),
        ...failedCall(2 * MIN, 'Grep'),
        tick(T0 + 2 * MIN + 6 * MIN),
      ],
      expected: 'ok',
    },
    {
      name: 'warning (3 failures) stays on a tick 2 min after the last failure (all three still in the window)',
      events: [
        ...failedCall(10 * SEC, 'Bash'),
        ...failedCall(1 * MIN, 'Read'),
        ...failedCall(2 * MIN, 'Grep'),
        tick(T0 + 2 * MIN + 2 * MIN),
      ],
      expected: 'warning',
    },
    {
      name: 'a newer failure restarts the recovery window',
      events: [
        ...failedCall(10 * SEC, 'Bash'),
        ...failedCall(10 * SEC + 4 * MIN, 'Read'),
        tick(T0 + 10 * SEC + 6 * MIN),
      ],
      expected: 'notice',
    },
    {
      name: 'a newer failure, then 5.5 min quiet → ok',
      events: [
        ...failedCall(10 * SEC, 'Bash'),
        ...failedCall(10 * SEC + 4 * MIN, 'Read'),
        tick(T0 + 10 * SEC + 9 * MIN + 30 * SEC),
      ],
      expected: 'ok',
    },
    {
      name: 'notice → ok on the next turn.finished',
      events: [...failedCall(10 * SEC, 'Bash'), ev('turn.finished', { ts: T0 + 20 * SEC })],
      expected: 'ok',
    },
    {
      name: 'warning (same tool twice) → ok on the next turn.finished',
      events: [
        ...failedCall(10 * SEC, 'Bash'),
        ...failedCall(20 * SEC, 'Bash'),
        ev('turn.finished', { ts: T0 + 30 * SEC }),
      ],
      expected: 'ok',
    },
    {
      name: 'warning (3 failures) → ok on the next turn.finished',
      events: [
        ...failedCall(10 * SEC, 'Bash'),
        ...failedCall(20 * SEC, 'Read'),
        ...failedCall(30 * SEC, 'Grep'),
        ev('turn.finished', { ts: T0 + 40 * SEC }),
      ],
      expected: 'ok',
    },
    {
      name: 'error from turn.failed (rate_limit) is not reset by the next turn.finished',
      events: [
        ev('turn.failed', { ts: T0 + 5 * SEC, errorClass: 'rate_limit' }),
        ev('prompt.submitted', { ts: T0 + 10 * SEC }),
        ev('turn.finished', { ts: T0 + 20 * SEC }),
      ],
      expected: 'error',
    },
  ])('$name', ({ events, expected }) => {
    expect(healthAfter(events)).toBe(expected);
  });

  it('after recovery a single new failure is a notice again, not a warning', () => {
    expect(
      healthAfter([
        ...failedCall(10 * SEC, 'Bash'),
        ...failedCall(1 * MIN, 'Read'),
        ...failedCall(2 * MIN, 'Grep'),
        tick(T0 + 8 * MIN),
        ...failedCall(8 * MIN + 10 * SEC, 'Edit'),
      ]),
    ).toBe('notice');
  });
});
