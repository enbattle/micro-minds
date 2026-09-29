// Task 2.1, clause 17: replay provider-independent AgentEvent scenarios through reduce().
// The fixtures in fixtures/agent-events/ follow the hook sequences recorded in Phase 1
// (spikes/phase-1/SCENARIOS.md, docs/protocols/claude.md), as the Claude adapter will
// normalize them (PLAN §5.3), plus clock.tick scenarios derived from them.
import { describe, expect, it } from 'vitest';
import type { WorldState } from './index.ts';
import { agentOf, loadEventFixture, ROOT, run, SUB, T0, trace } from './shared.test-helpers.ts';

/** What to check after one event. `absent` = that agent id must not exist. */
type Check =
  | {
      agent: string;
      activity?: string | readonly string[];
      health?: string;
      /** 'none' = no attention. */
      attention?: string;
    }
  | { absent: string };

const G1 = 'a0d1e2f3a4b5c6d7';
const G2 = 'a1e2f3a4b5c6d7e8';
const G3 = 'a2f3a4b5c6d7e8f9';
/** session.started: "starting → idle" (PLAN §4.3). */
const STARTED = ['starting', 'idle'] as const;

function r(activity: string | readonly string[], health = 'ok', attention?: string): Check {
  return attention === undefined
    ? { agent: ROOT, activity, health }
    : { agent: ROOT, activity, health, attention };
}
function x(activity: string | undefined, health = 'ok'): Check {
  return activity === undefined ? { agent: SUB, health } : { agent: SUB, activity, health };
}

interface Scenario {
  name: string;
  fixture: string;
  checks: Check[];
  final: (world: WorldState) => void;
}

const scenarios: Scenario[] = [
  {
    name: '(a) Q&A',
    fixture: 'qa',
    checks: [r(STARTED), r('thinking'), r('idle'), r('offline')],
    final: (world) => {
      expect(Object.keys(world.agents)).toEqual([ROOT]);
    },
  },
  {
    name: '(b) read + edit, with usage',
    fixture: 'read-edit',
    checks: [
      r(STARTED),
      r('thinking'),
      r('reading'),
      r('reading'),
      r('thinking'),
      r('writing'),
      r('thinking'),
      r('thinking'),
      r('thinking'),
      r('idle'),
      r('offline'),
    ],
    final: (world) => {
      expect(agentOf(world, ROOT).usage).toEqual({
        total: {
          inputTokens: 2300,
          outputTokens: 250,
          cacheReadTokens: 31000,
          cacheWriteTokens: 400,
          costUsd: 0.875,
        },
        byModel: {
          'claude-opus-5-5': {
            inputTokens: 2000,
            outputTokens: 230,
            cacheReadTokens: 31000,
            cacheWriteTokens: 400,
            costUsd: 0.75,
          },
          'claude-haiku-4-5-20251001': {
            inputTokens: 300,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.125,
          },
        },
      });
    },
  },
  {
    name: '(c) failing shell command: notice, back to ok on turn.finished',
    fixture: 'failing-shell',
    checks: [
      r(STARTED),
      r('thinking'),
      r('running'),
      r('thinking', 'notice'),
      r('idle', 'ok'),
      r('offline', 'ok'),
    ],
    final: () => {},
  },
  {
    name: '(d) permission prompt, declined: hand raised, no Stop',
    fixture: 'permission-prompt',
    checks: [
      r(STARTED, 'ok', 'none'),
      r('thinking', 'ok', 'none'),
      r('writing', 'ok', 'none'),
      r('waiting_permission', 'ok', 'permission'),
      r('offline'),
    ],
    final: () => {},
  },
  {
    name: '(e) AskUserQuestion: ? bubble, never a raised hand',
    fixture: 'ask-user-question',
    checks: [
      r(STARTED),
      r('thinking', 'ok', 'none'),
      r('waiting_input', 'ok', 'question'),
      r('waiting_input', 'ok', 'question'),
      r('thinking'),
      r('idle'),
      r('offline'),
    ],
    final: () => {},
  },
  {
    name: '(f) background subagent, with SubagentStop from never-started agents',
    fixture: 'subagent',
    checks: [
      r(STARTED),
      r('thinking'),
      r('delegating'),
      x(undefined),
      r('thinking'),
      r('idle'),
      x('running'),
      { absent: G1 },
      x('thinking'),
      x('running'),
      { absent: G2 },
      x('thinking'),
      x(undefined),
      x('thinking'),
      r('thinking'),
      x('done'),
      r('idle'),
      r('thinking'),
      { absent: G3 },
      r('idle'),
      r('offline'),
    ],
    final: (world) => {
      expect(Object.keys(world.agents).sort()).toEqual([ROOT, SUB].sort());
      expect(agentOf(world, ROOT).children).toEqual([SUB]);
      expect(agentOf(world, SUB).parentAgentId).toBe(ROOT);
      expect(agentOf(world, ROOT).health).toBe('ok');
      expect(agentOf(world, SUB).health).toBe('ok');
    },
  },
  {
    name: '(g) Ctrl-C during a tool: no PostToolUse, then SessionEnd',
    fixture: 'ctrl-c',
    checks: [r(STARTED), r('thinking'), r('running'), r('offline', 'ok')],
    final: () => {},
  },
  {
    name: '(h) process killed: session.crashed is an error',
    fixture: 'process-killed',
    checks: [r(STARTED), r('thinking'), r('running'), { agent: ROOT, health: 'error' }],
    final: () => {},
  },
  {
    name: '(h) derived: a stuck tool goes to warning on clock.tick',
    fixture: 'stuck-tool',
    checks: [
      r(STARTED),
      r('thinking'),
      r('running'),
      r('running', 'ok'),
      r('running', 'ok'),
      r('running', 'warning'),
    ],
    final: (world) => {
      expect(agentOf(world, ROOT).lastEventAt).toBe(T0 + 5000);
    },
  },
  {
    name: '(i) compaction, then the idle notice',
    fixture: 'compaction',
    checks: [
      r(STARTED),
      r('thinking'),
      r('reading'),
      r('thinking'),
      r('reading'),
      r('thinking'),
      r('idle'),
      r('thinking'),
      r('idle', 'ok', 'none'),
      { agent: ROOT, health: 'ok' },
      { absent: G1 },
      r('waiting_input', 'ok', 'idle'),
      r('offline'),
    ],
    final: (world) => {
      expect(Object.keys(world.agents)).toEqual([ROOT]);
    },
  },
  {
    name: '(c) derived: a single failure decays back to ok after 5 min of clock.tick',
    fixture: 'failure-decay',
    checks: [
      r(STARTED),
      r('thinking'),
      r('running'),
      r('thinking', 'notice'),
      r('thinking', 'notice'),
      r('thinking', 'notice'),
      r('thinking', 'ok'),
    ],
    final: () => {},
  },
  {
    name: '(c) derived: three failures in the window → warning, then decay to ok',
    fixture: 'repeated-failures',
    checks: [
      r(STARTED),
      r('thinking'),
      r('running'),
      r('thinking', 'notice'),
      r('reading', 'notice'),
      r('thinking', 'notice'),
      r('reading', 'notice'),
      r('thinking', 'warning'),
      r('thinking', 'warning'),
      r('thinking', 'ok'),
    ],
    final: (world) => {
      expect(agentOf(world, ROOT).lastEventAt).toBe(T0 + 12000);
    },
  },
];

describe.each(scenarios)('replay $name', ({ fixture, checks, final }) => {
  it('has one check per event', () => {
    expect(loadEventFixture(fixture)).toHaveLength(checks.length);
  });

  it('reaches the expected activity, health and attention after each event', () => {
    const worlds = trace(loadEventFixture(fixture));
    checks.forEach((check, step) => {
      const world = worlds[step];
      expect(world, `world after event ${step}`).toBeDefined();
      if (world === undefined) return;
      if ('absent' in check) {
        expect(Object.keys(world.agents), `step ${step}`).not.toContain(check.absent);
        return;
      }
      const agent = world.agents[check.agent];
      expect(agent, `agent ${check.agent} at step ${step}`).toBeDefined();
      if (agent === undefined) return;
      if (check.activity !== undefined) {
        const allowed = typeof check.activity === 'string' ? [check.activity] : check.activity;
        expect(allowed, `activity at step ${step}`).toContain(agent.activity);
      }
      if (check.health !== undefined) {
        expect(agent.health, `health at step ${step}`).toBe(check.health);
      }
      if (check.attention !== undefined) {
        expect(agent.attention ?? 'none', `attention at step ${step}`).toBe(check.attention);
      }
    });
  });

  it('reaches the expected final state', () => {
    final(run(loadEventFixture(fixture)));
  });

  it('is deterministic: two replays give equal worlds', () => {
    expect(run(loadEventFixture(fixture))).toEqual(run(loadEventFixture(fixture)));
  });
});
