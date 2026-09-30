// Task 2.3, clause C4: the conformance suite (clause C3) run against a correct example adapter,
// and shown to catch broken ones. Each broken adapter differs from the example in one way, and
// the check that owns that rule must report it.
import path from 'node:path';
import type { AgentEvent } from '@micro-minds/shared';
import { describe, expect, it } from 'vitest';
import {
  CONFORMANCE_CHECKS,
  type ConformanceCheckName,
  conformanceViolations,
  describeConformance,
  runConformanceCheck,
} from './conformance.test-helpers.ts';
import { EXAMPLE_FIXTURES, exampleAdapter, withOverrides } from './example-adapter.test-helpers.ts';
import type { LaunchContext, LaunchSpec, NormalizeContext, ProviderAdapter } from './types.ts';

const options = { fixtures: EXAMPLE_FIXTURES };

describeConformance('example fake adapter', exampleAdapter, options);

/** The example's events for `raw`, each passed through `edit`. */
function editEvents(
  edit: (event: AgentEvent, ctx: NormalizeContext) => AgentEvent,
): ProviderAdapter['normalize'] {
  const example = exampleAdapter();
  return (raw, ctx) => example.normalize(raw, ctx).map((event) => edit(event, ctx));
}

/** The example's launch spec, passed through `edit`. */
function editLaunch(
  edit: (spec: LaunchSpec, ctx: LaunchContext) => LaunchSpec,
): ProviderAdapter['launch'] {
  const example = exampleAdapter();
  return (ctx) => edit(example.launch(ctx), ctx);
}

function broken(overrides: Partial<ProviderAdapter>): ProviderAdapter {
  return withOverrides(exampleAdapter(), overrides);
}

let nondeterministicCounter = 0;

const BROKEN: readonly {
  name: string;
  check: ConformanceCheckName;
  make: () => ProviderAdapter;
}[] = [
  // identity
  {
    name: 'a binary command with a path',
    check: 'identity',
    make: () => broken({ binary: { command: 'bin/micro-minds-fake', versionArgs: [] } }),
  },
  {
    name: 'a toolCategories value that is not a ToolCategory',
    check: 'identity',
    make: () =>
      broken({
        toolCategories: { Read: 'reading' } as unknown as ProviderAdapter['toolCategories'],
      }),
  },
  // total
  {
    name: 'a normalize that throws on non-object input only',
    check: 'total',
    make: () => {
      const example = exampleAdapter();
      return broken({
        normalize: (raw, ctx) => {
          if (typeof raw !== 'object' || raw === null) throw new TypeError('not an object');
          return example.normalize(raw, ctx);
        },
      });
    },
  },
  {
    name: 'a normalize that returns a non-array',
    check: 'total',
    make: () => broken({ normalize: () => ({}) as unknown as AgentEvent[] }),
  },
  // events
  {
    name: 'an adapter that stamps its own ts',
    check: 'events',
    make: () => broken({ normalize: editEvents((e) => ({ ...e, ts: 1_600_000_000_000 })) }),
  },
  {
    name: 'an adapter that invents an event kind',
    check: 'events',
    make: () =>
      broken({
        normalize: editEvents((e) => ({ ...e, kind: 'tool.stuck' }) as unknown as AgentEvent),
      }),
  },
  // facts-only
  {
    name: 'an adapter that sets a health field',
    check: 'facts-only',
    make: () =>
      broken({
        normalize: editEvents((e) => ({ ...e, health: 'error' }) as unknown as AgentEvent),
      }),
  },
  {
    name: 'an adapter that sets a severity field',
    check: 'facts-only',
    make: () =>
      broken({
        normalize: editEvents((e) => ({ ...e, severity: 'warn' }) as unknown as AgentEvent),
      }),
  },
  // unknown-input
  {
    name: "an adapter that maps unrecognized payloads to a known kind instead of 'unknown'",
    check: 'unknown-input',
    make: () =>
      broken({
        normalize: editEvents((e) =>
          e.kind === 'unknown' ? { ...e, kind: 'prompt.submitted' } : e,
        ),
      }),
  },
  {
    name: 'an adapter that drops every unrecognized payload',
    check: 'unknown-input',
    make: () => {
      const example = exampleAdapter();
      return broken({
        normalize: (raw, ctx) => example.normalize(raw, ctx).filter((e) => e.kind !== 'unknown'),
      });
    },
  },
  // tool-categories
  {
    name: 'an adapter whose events contradict its category map',
    check: 'tool-categories',
    make: () =>
      broken({
        normalize: editEvents((e) =>
          e.tool?.name === 'Read' ? { ...e, tool: { ...e.tool, category: 'exec' } } : e,
        ),
      }),
  },
  {
    name: "an adapter that guesses a category for an unmapped tool instead of 'other'",
    check: 'tool-categories',
    make: () =>
      broken({
        normalize: editEvents((e) =>
          e.tool?.name === 'Mystery' ? { ...e, tool: { ...e.tool, category: 'web' } } : e,
        ),
      }),
  },
  // deterministic
  {
    name: 'an adapter whose output depends on hidden state',
    check: 'deterministic',
    make: () =>
      broken({
        normalize: editEvents((e) => {
          nondeterministicCounter += 1;
          return { ...e, text: `call ${nondeterministicCounter}` };
        }),
      }),
  },
  // launch
  {
    name: 'a launch that puts the token in a file',
    check: 'launch',
    make: () =>
      broken({
        launch: editLaunch((spec, ctx) => ({
          ...spec,
          files: [{ name: 'settings.json', content: JSON.stringify({ token: ctx.hookToken }) }],
        })),
      }),
  },
  {
    name: 'a launch that puts the token in args',
    check: 'launch',
    make: () =>
      broken({
        launch: editLaunch((spec, ctx) => ({
          ...spec,
          args: [...spec.args, `--token=${ctx.hookToken}`],
        })),
      }),
  },
  {
    name: 'a launch that splits the prompt on spaces',
    check: 'launch',
    make: () =>
      broken({
        launch: editLaunch((spec, ctx) => ({
          ...spec,
          args: spec.args.flatMap((a) => (a === ctx.firstPrompt ? a.split(' ') : [a])),
        })),
      }),
  },
  {
    name: "a launch with a file name containing '..'",
    check: 'launch',
    make: () =>
      broken({
        launch: editLaunch((spec) => ({
          ...spec,
          files: [{ name: '../settings.json', content: '{}' }],
        })),
      }),
  },
  {
    name: 'a launch that points settings into the worktree',
    check: 'launch',
    make: () =>
      broken({
        launch: editLaunch((spec, ctx) => ({
          ...spec,
          args: ['--settings', path.join(ctx.worktreePath, '.claude', 'settings.local.json')],
        })),
      }),
  },
];

describe('the conformance suite itself', () => {
  it('has one check per rule, each with a unique name', () => {
    const names = CONFORMANCE_CHECKS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(
      [
        'deterministic',
        'events',
        'facts-only',
        'identity',
        'launch',
        'tool-categories',
        'total',
        'unknown-input',
      ].sort(),
    );
  });

  it('finds no violation in the correct example adapter', () => {
    expect(conformanceViolations(exampleAdapter(), options)).toEqual([]);
  });

  it.each(BROKEN)('$name → flagged by the $check check', ({ make, check }) => {
    expect(runConformanceCheck(check, make(), options)).not.toEqual([]);
    expect(conformanceViolations(make(), options).some((m) => m.startsWith(`${check}: `))).toBe(
      true,
    );
  });

  it.each(BROKEN)('checks never throw, even for $name', ({ make }) => {
    for (const { name } of CONFORMANCE_CHECKS) {
      expect(() => runConformanceCheck(name, make(), options)).not.toThrow();
    }
  });
});
