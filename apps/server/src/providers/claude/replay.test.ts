// Task 2.4, clause D5: every Claude hook fixture replayed through the registry's normalize, one
// line at a time, gives the event sequence docs/protocols/claude.md and its findings describe;
// the events, folded through shared reduce() after a synthetic session.started (the PTY spawn,
// ADR 0029), reach the end state the doc implies. Expected sequences are written out by hand.
import type {
  AgentEvent,
  AgentState,
  EventKind,
  ToolCategory,
  WorldState,
} from '@micro-minds/shared';
import { describe, expect, it } from 'vitest';
import { createProviderRegistry } from '../registry.ts';
import {
  claudeHookFixtureNames,
  loadClaudeFixture,
  ROOT,
  replay,
  SESSION_ID,
} from '../replay.test-helpers.ts';
import { claudeAdapter } from './adapter.ts';

const A1 = 'a0000000000000001';
const A2 = 'a0000000000000002';
const A3 = 'a0000000000000003';
const A4 = 'a0000000000000004';

interface Expected {
  kind: EventKind;
  /** Defaults to the root agent. */
  agent?: string;
  tool?: { name: string; category: ToolCategory; useId?: string };
  errorClass?: string;
}

const root = (kind: EventKind): Expected => ({ kind });
const sub = (kind: EventKind, agent: string): Expected => ({ kind, agent });
function tool(
  kind: EventKind,
  name: string,
  category: ToolCategory,
  useId: string | undefined,
  agent?: string,
): Expected {
  const t = useId === undefined ? { name, category } : { name, category, useId };
  return agent === undefined ? { kind, tool: t } : { kind, tool: t, agent };
}

function agentOf(world: WorldState, id: string): AgentState {
  const agent = world.agents[id];
  if (agent === undefined) throw new Error(`no agent ${id}`);
  return agent;
}

function worldAt(worlds: readonly WorldState[], i: number): WorldState {
  const world = worlds[i];
  if (world === undefined) throw new Error(`no world after line ${i}`);
  return world;
}

interface Scenario {
  fixture: string;
  /** Events per line; SessionStart lines yield none. */
  lineCounts: number[];
  expected: Expected[];
  /** Checks on the world after each line (worlds[i]) and at the end. */
  state: (worlds: readonly WorldState[], final: WorldState) => void;
}

const SCENARIOS: Scenario[] = [
  {
    fixture: 'qa',
    lineCounts: [1, 1, 1],
    expected: [root('prompt.submitted'), root('turn.finished'), root('session.ended')],
    state: (worlds, final) => {
      expect(agentOf(worldAt(worlds, 0), ROOT).activity).toBe('thinking');
      expect(agentOf(worldAt(worlds, 1), ROOT).activity).toBe('idle');
      expect(Object.keys(final.agents)).toEqual([ROOT]);
      expect(agentOf(final, ROOT).activity).toBe('offline');
      expect(agentOf(final, ROOT).health).toBe('ok');
    },
  },
  {
    fixture: 'qa-command-hook',
    // Finding 1: SessionStart yields nothing; session.started comes from the PTY.
    lineCounts: [0, 1, 1, 1],
    expected: [root('prompt.submitted'), root('turn.finished'), root('session.ended')],
    state: (_worlds, final) => {
      expect(Object.keys(final.agents)).toEqual([ROOT]);
      expect(agentOf(final, ROOT).activity).toBe('offline');
    },
  },
  {
    fixture: 'read-edit',
    lineCounts: [1, 1, 1, 1, 1, 1, 1],
    expected: [
      root('prompt.submitted'),
      tool('tool.started', 'Read', 'read', 'toolu_000001'),
      tool('tool.finished', 'Read', 'read', 'toolu_000001'),
      tool('tool.started', 'Edit', 'write', 'toolu_000002'),
      tool('tool.finished', 'Edit', 'write', 'toolu_000002'),
      root('turn.finished'),
      root('session.ended'),
    ],
    state: (worlds, final) => {
      expect(agentOf(worldAt(worlds, 1), ROOT).activity).toBe('reading');
      expect(agentOf(worldAt(worlds, 3), ROOT).activity).toBe('writing');
      expect(agentOf(worldAt(worlds, 5), ROOT).activity).toBe('idle');
      expect(agentOf(final, ROOT).activity).toBe('offline');
      expect(agentOf(final, ROOT).health).toBe('ok');
    },
  },
  {
    fixture: 'failing-shell',
    lineCounts: [1, 1, 1, 1, 1],
    expected: [
      root('prompt.submitted'),
      tool('tool.started', 'Bash', 'exec', 'toolu_000001'),
      tool('tool.failed', 'Bash', 'exec', 'toolu_000001'),
      root('turn.finished'),
      root('session.ended'),
    ],
    state: (worlds, final) => {
      expect(agentOf(worldAt(worlds, 1), ROOT).activity).toBe('running');
      // Finding 2: one tool failure is a notice; turn.finished resets it (PLAN §6).
      expect(agentOf(worldAt(worlds, 2), ROOT).health).toBe('notice');
      expect(agentOf(worldAt(worlds, 3), ROOT).health).toBe('ok');
      expect(agentOf(final, ROOT).activity).toBe('offline');
    },
  },
  {
    fixture: 'failing-shell-masked',
    lineCounts: [1, 1, 1, 1, 1],
    expected: [
      root('prompt.submitted'),
      tool('tool.started', 'Bash', 'exec', 'toolu_000001'),
      tool('tool.finished', 'Bash', 'exec', 'toolu_000001'),
      root('turn.finished'),
      root('session.ended'),
    ],
    state: (worlds, final) => {
      // The wrapper hides the failure: health never leaves ok.
      for (const world of worlds) expect(agentOf(world, ROOT).health).toBe('ok');
      expect(agentOf(final, ROOT).activity).toBe('offline');
    },
  },
  {
    fixture: 'permission-prompt',
    lineCounts: [1, 1, 1, 1],
    expected: [
      root('prompt.submitted'),
      tool('tool.started', 'Write', 'write', 'toolu_000001'),
      // Finding 4: no tool_use_id on PermissionRequest.
      tool('attention.permission', 'Write', 'write', undefined),
      root('session.ended'),
    ],
    state: (worlds, final) => {
      // Finding 3: the decline ends the turn silently; the hand stays raised until the session ends.
      const beforeEnd = agentOf(worldAt(worlds, 2), ROOT);
      expect(beforeEnd.attention).toBe('permission');
      expect(beforeEnd.activity).toBe('waiting_permission');
      expect(agentOf(final, ROOT).activity).toBe('offline');
      expect(agentOf(final, ROOT).attention).toBeUndefined();
    },
  },
  {
    fixture: 'ask-user-question',
    lineCounts: [1, 1, 1, 1, 1, 1],
    expected: [
      root('prompt.submitted'),
      root('attention.question'),
      // Finding 5: the dialog is a PermissionRequest(AskUserQuestion).
      root('attention.question'),
      tool('tool.finished', 'AskUserQuestion', 'ask', 'toolu_000001'),
      root('turn.finished'),
      root('session.ended'),
    ],
    state: (worlds, final) => {
      expect(agentOf(worldAt(worlds, 1), ROOT).attention).toBe('question');
      expect(agentOf(worldAt(worlds, 2), ROOT).attention).toBe('question');
      // A question is never a raised hand.
      for (const world of worlds) expect(agentOf(world, ROOT).attention).not.toBe('permission');
      expect(agentOf(worldAt(worlds, 1), ROOT).activity).toBe('waiting_input');
      expect(agentOf(final, ROOT).activity).toBe('offline');
    },
  },
  {
    fixture: 'subagent',
    lineCounts: Array.from({ length: 20 }, () => 1),
    expected: [
      root('prompt.submitted'),
      tool('tool.started', 'Agent', 'delegate', 'toolu_000001'),
      sub('agent.spawned', A1),
      tool('tool.finished', 'Agent', 'delegate', 'toolu_000001'),
      root('turn.finished'),
      tool('tool.started', 'Bash', 'exec', 'toolu_000002', A1),
      sub('agent.finished', A2),
      tool('tool.finished', 'Bash', 'exec', 'toolu_000002', A1),
      tool('tool.started', 'Bash', 'exec', 'toolu_000003', A1),
      sub('agent.finished', A3),
      tool('tool.finished', 'Bash', 'exec', 'toolu_000003', A1),
      tool('tool.started', 'SubagentHandback', 'other', 'toolu_000004', A1),
      tool('tool.finished', 'SubagentHandback', 'other', 'toolu_000004', A1),
      // Finding 6: the result comes back as a prompt no user typed.
      root('prompt.submitted'),
      sub('agent.finished', A1),
      root('turn.finished'),
      root('prompt.submitted'),
      sub('agent.finished', A4),
      root('turn.finished'),
      root('session.ended'),
    ],
    state: (worlds, final) => {
      // The Explore subagent appears on SubagentStart and runs after the main Stop.
      const spawned = worldAt(worlds, 2);
      expect(agentOf(spawned, A1).parentAgentId).toBe(ROOT);
      expect(agentOf(worldAt(worlds, 4), ROOT).activity).toBe('idle');
      expect(agentOf(worldAt(worlds, 5), A1).activity).toBe('running');
      expect(agentOf(worldAt(worlds, 14), A1).activity).toBe('done');
      // SubagentStop from never-started agents creates no agent, at any step.
      for (const world of worlds) {
        for (const ghost of [A2, A3, A4]) expect(Object.keys(world.agents)).not.toContain(ghost);
      }
      expect(Object.keys(final.agents).sort()).toEqual([ROOT, A1].sort());
      expect(agentOf(final, ROOT).children).toEqual([A1]);
      expect(agentOf(final, A1).activity).toBe('done');
      expect(agentOf(final, ROOT).activity).toBe('offline');
      expect(agentOf(final, ROOT).health).toBe('ok');
      expect(agentOf(final, A1).health).toBe('ok');
    },
  },
  {
    fixture: 'ctrl-c',
    lineCounts: [1, 1, 1],
    expected: [
      root('prompt.submitted'),
      tool('tool.started', 'Bash', 'exec', 'toolu_000001'),
      root('session.ended'),
    ],
    state: (worlds, final) => {
      // Finding 7: nothing after the interrupt; the tool is still "running" until SessionEnd.
      expect(agentOf(worldAt(worlds, 1), ROOT).activity).toBe('running');
      expect(agentOf(final, ROOT).activity).toBe('offline');
      expect(agentOf(final, ROOT).currentTool).toBeUndefined();
    },
  },
  {
    fixture: 'process-killed',
    lineCounts: [1, 1],
    expected: [root('prompt.submitted'), tool('tool.started', 'Bash', 'exec', 'toolu_000001')],
    state: (_worlds, final) => {
      // Finding 7: hooks alone leave the agent running; the PTY exit must end it (§5.5).
      expect(agentOf(final, ROOT).activity).toBe('running');
      expect(agentOf(final, ROOT).currentTool).toMatchObject({ name: 'Bash', category: 'exec' });
    },
  },
  {
    fixture: 'compaction',
    lineCounts: Array.from({ length: 12 }, () => 1),
    expected: [
      root('prompt.submitted'),
      tool('tool.started', 'Read', 'read', 'toolu_000001'),
      tool('tool.finished', 'Read', 'read', 'toolu_000001'),
      tool('tool.started', 'Read', 'read', 'toolu_000002'),
      tool('tool.finished', 'Read', 'read', 'toolu_000002'),
      root('turn.finished'),
      root('prompt.submitted'),
      root('turn.finished'),
      root('context.compacting'),
      // Finding 8: an unseen agent's SubagentStop after /compact.
      sub('agent.finished', A1),
      root('attention.idle'),
      root('session.ended'),
    ],
    state: (worlds, final) => {
      for (const world of worlds) expect(Object.keys(world.agents)).toEqual([ROOT]);
      const idle = agentOf(worldAt(worlds, 10), ROOT);
      expect(idle.attention).toBe('idle');
      expect(idle.activity).toBe('waiting_input');
      expect(agentOf(final, ROOT).activity).toBe('offline');
      expect(agentOf(final, ROOT).health).toBe('ok');
    },
  },
];

const registry = createProviderRegistry([claudeAdapter]);
const normalizeViaRegistry = (raw: unknown, ctx: Parameters<typeof registry.normalize>[2]) =>
  registry.normalize('claude', raw, ctx);

function describeEvent(e: AgentEvent): Expected {
  const out: Expected = { kind: e.kind };
  if (e.agentId !== ROOT) out.agent = e.agentId;
  if (e.tool !== undefined) {
    out.tool =
      e.tool.useId === undefined
        ? { name: e.tool.name, category: e.tool.category }
        : { name: e.tool.name, category: e.tool.category, useId: e.tool.useId };
  }
  if (e.errorClass !== undefined) out.errorClass = e.errorClass;
  return out;
}

describe('Claude hook fixture replay (D5)', () => {
  it('every hook fixture in fixtures/claude has an expected sequence here', () => {
    expect(SCENARIOS.map((s) => s.fixture).sort()).toEqual(claudeHookFixtureNames());
  });

  describe.each(SCENARIOS)('$fixture.jsonl', ({ fixture, lineCounts, expected, state }) => {
    const payloads = loadClaudeFixture(fixture);
    const result = replay('claude', payloads, normalizeViaRegistry);

    it('yields the expected number of events per line', () => {
      expect(result.perLine.map((events) => events.length)).toEqual(lineCounts);
    });

    it('yields the expected kinds, attribution, tools and errorClass, in order', () => {
      expect(result.events.map(describeEvent)).toEqual(expected);
    });

    it('every event is ours: our session, provider claude, root or a child of the root', () => {
      for (const event of result.events) {
        expect(event.sessionId).toBe(SESSION_ID);
        expect(event.provider).toBe('claude');
        expect(event.kind).not.toBe('unknown');
        if (event.agentId === ROOT) expect(event).not.toHaveProperty('parentAgentId');
        else expect(event.parentAgentId).toBe(ROOT);
      }
    });

    it('reaches the end state the protocol doc implies', () => {
      state(result.worlds, result.final);
    });

    it('is deterministic: two replays give equal events and worlds', () => {
      const again = replay('claude', loadClaudeFixture(fixture), normalizeViaRegistry);
      expect(again.events).toEqual(result.events);
      expect(again.final).toEqual(result.final);
    });
  });
});
