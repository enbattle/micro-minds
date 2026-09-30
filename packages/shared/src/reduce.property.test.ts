// Task 2.1, clauses 14–16: property-based tests for reduce() with fast-check.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentState, UsageTotals, WorldState } from './index.ts';
import {
  createWorld,
  DEFAULT_THRESHOLDS,
  EVENT_KINDS,
  EVENT_SCHEMA_VERSION,
  reduce,
  TOOL_CATEGORIES,
} from './index.ts';
import { GHOST, MIN, ROOT, run, SESSION_ID, SUB, T0 } from './shared.test-helpers.ts';

/** A fixed seed, so every run draws the same cases (ADR 0031). */
const PROPERTY_SEED = 20_260_929;
const AGENT_IDS = [ROOT, SUB, GHOST] as const;
const TOOL_NAMES = ['Bash', 'Read', 'Edit', 'Agent', 'WebFetch', 'mcp__x__y'] as const;
const MODELS = ['claude-opus-5-5', 'claude-haiku-4-5-20251001'] as const;

const usageArb = fc.record({
  model: fc.constantFrom(...MODELS),
  source: fc.constantFrom('otel' as const, 'statusline' as const),
  inputTokens: fc.nat({ max: 100_000 }),
  outputTokens: fc.nat({ max: 100_000 }),
  cacheReadTokens: fc.nat({ max: 100_000 }),
  cacheWriteTokens: fc.nat({ max: 100_000 }),
  costUsd: fc.nat({ max: 1_000 }).map((cents) => cents / 128),
});

/** Schema-valid events of every kind, for the three agent ids (root, subagent, never-spawned). */
const validEventArb: fc.Arbitrary<AgentEvent> = fc
  .record({
    n: fc.nat({ max: 999_999 }),
    ts: fc.integer({ min: T0, max: T0 + 120 * MIN }),
    kind: fc.constantFrom(...EVENT_KINDS),
    agentId: fc.constantFrom(...AGENT_IDS),
    withParent: fc.boolean(),
    tool: fc.option(
      fc.record({
        name: fc.constantFrom(...TOOL_NAMES),
        category: fc.constantFrom(...TOOL_CATEGORIES),
      }),
      { nil: undefined },
    ),
    errorClass: fc.option(
      fc.constantFrom('rate_limit', 'auth', 'budget', 'other') as fc.Arbitrary<
        'rate_limit' | 'auth' | 'budget' | 'other'
      >,
      { nil: undefined },
    ),
    usage: fc.option(usageArb, { nil: undefined }),
  })
  .map(({ n, ts, kind, agentId, withParent, tool, errorClass, usage }) => {
    const event: AgentEvent = {
      v: EVENT_SCHEMA_VERSION,
      id: `01K6P${String(n).padStart(21, '0')}`,
      ts,
      sessionId: SESSION_ID,
      provider: 'claude',
      agentId,
      kind,
      ...(withParent && agentId !== ROOT ? { parentAgentId: ROOT } : {}),
      ...(tool === undefined ? {} : { tool }),
      ...(errorClass === undefined ? {} : { errorClass }),
      ...(kind === 'usage.recorded' && usage !== undefined ? { usage } : {}),
    };
    return event;
  });

/** Events that break the schema: wrong types, missing fields, unknown kinds, junk values. */
const malformedEventArb: fc.Arbitrary<AgentEvent> = fc
  .oneof(
    fc.anything(),
    fc.record({
      v: fc.oneof(fc.constant(EVENT_SCHEMA_VERSION), fc.anything()),
      id: fc.oneof(fc.string(), fc.anything()),
      ts: fc.oneof(fc.integer(), fc.double(), fc.string(), fc.constant(null)),
      sessionId: fc.oneof(fc.constant(SESSION_ID), fc.anything()),
      provider: fc.oneof(fc.constant('claude'), fc.string()),
      agentId: fc.oneof(fc.constantFrom(...AGENT_IDS), fc.anything()),
      parentAgentId: fc.oneof(fc.constant(ROOT), fc.anything()),
      kind: fc.oneof(fc.constantFrom(...EVENT_KINDS), fc.string()),
      tool: fc.oneof(fc.record({ name: fc.anything(), category: fc.anything() }), fc.anything()),
      errorClass: fc.anything(),
      usage: fc.oneof(
        fc.record({
          model: fc.anything(),
          inputTokens: fc.anything(),
          outputTokens: fc.anything(),
          costUsd: fc.anything(),
        }),
        fc.anything(),
      ),
    }),
  )
  // Deliberately lie to the type system: reduce() must survive what the types rule out.
  .map((value) => value as unknown as AgentEvent);

/** Starts the sequence with a root agent and one spawned subagent so events have targets. */
const prelude: AgentEvent[] = [
  {
    v: EVENT_SCHEMA_VERSION,
    id: '01K6P00000000000000000000A',
    ts: T0,
    sessionId: SESSION_ID,
    provider: 'claude',
    agentId: ROOT,
    kind: 'session.started',
  },
  {
    v: EVENT_SCHEMA_VERSION,
    id: '01K6P00000000000000000000B',
    ts: T0 + 1,
    sessionId: SESSION_ID,
    provider: 'claude',
    agentId: SUB,
    parentAgentId: ROOT,
    kind: 'agent.spawned',
  },
];

const anyEventsArb = fc.array(fc.oneof(validEventArb, validEventArb, malformedEventArb), {
  maxLength: 60,
});
const validEventsArb = fc.array(validEventArb, { maxLength: 80 });

const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
] as const;

function assertNotDecreased(before: WorldState, after: WorldState): void {
  for (const [agentId, prev] of Object.entries<AgentState>(before.agents)) {
    const next = after.agents[agentId];
    if (prev.usage === undefined) continue;
    expect(next?.usage, `usage of ${agentId} disappeared`).toBeDefined();
    const pairs: [string, UsageTotals, UsageTotals | undefined][] = [
      ['total', prev.usage.total, next?.usage?.total],
      ...Object.entries(prev.usage.byModel).map(
        ([model, totals]): [string, UsageTotals, UsageTotals | undefined] => [
          model,
          totals,
          next?.usage?.byModel[model],
        ],
      ),
    ];
    for (const [label, was, now] of pairs) {
      expect(now, `${agentId} ${label} disappeared`).toBeDefined();
      for (const field of USAGE_FIELDS) {
        expect(
          now?.[field] ?? Number.NEGATIVE_INFINITY,
          `${agentId} ${label}.${field}`,
        ).toBeGreaterThanOrEqual(was[field]);
      }
    }
  }
}

describe('reduce() properties (fast-check)', () => {
  it('never throws on any event sequence, including malformed events and unknown kinds', () => {
    fc.assert(
      fc.property(anyEventsArb, (events) => {
        let world: WorldState = createWorld();
        for (const event of [...prelude, ...events]) {
          world = reduce(world, event, DEFAULT_THRESHOLDS);
        }
        expect(world).toBeDefined();
      }),
      { seed: PROPERTY_SEED, numRuns: 300 },
    );
  });

  it('never throws when started from an empty world with no prelude', () => {
    fc.assert(
      fc.property(anyEventsArb, (events) => {
        expect(() => run(events)).not.toThrow();
      }),
      { seed: PROPERTY_SEED, numRuns: 200 },
    );
  });

  it('usage totals, overall and per model, never decrease', () => {
    fc.assert(
      fc.property(validEventsArb, (events) => {
        let world: WorldState = run(prelude);
        for (const event of events) {
          const next = reduce(world, event, DEFAULT_THRESHOLDS);
          assertNotDecreased(world, next);
          world = next;
        }
      }),
      { seed: PROPERTY_SEED, numRuns: 300 },
    );
  });

  it('replaying the same events from the same initial state gives an equal state', () => {
    fc.assert(
      fc.property(anyEventsArb, anyEventsArb, (events, other) => {
        const first = run([...prelude, ...events]);
        run([...prelude, ...other]);
        const second = run([...prelude, ...events]);
        expect(second).toEqual(first);
      }),
      { seed: PROPERTY_SEED, numRuns: 200 },
    );
  });
});
