// Task 2.4, clauses D6, D8 and D9: the fake provider's adapter, its basic scenario, and a run of
// the fake CLI from the adapter's own launch spec (the "Done when" path of PLAN Phase 2).
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, AgentState, EventKind, WorldState } from '@micro-minds/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { describeConformance } from '../conformance.test-helpers.ts';
import { createProviderRegistry } from '../registry.ts';
import {
  allFakeLines,
  fixedContext,
  loadFakeFixture,
  ROOT,
  replay,
  SESSION_ID,
  T0,
} from '../replay.test-helpers.ts';
import type { LaunchContext } from '../types.ts';
import { fakeAdapter } from './adapter.ts';
import {
  CLI_PATH,
  type HookServer,
  type RunningCli,
  runCli,
  startHookServer,
  TEST_TIMEOUT_MS,
  waitFor,
} from './cli.test-helpers.ts';

const TOKEN = 'mmhook-fake-adapter-test-Bc5Df7Gh9Jk1';
const SESSION_DIR = path.resolve(path.sep, 'mm-test', 'sessions', SESSION_ID);
const WORKTREE = path.resolve(path.sep, 'mm-test', 'worktrees', 'repo', SESSION_ID);

function launchContext(serverUrl: string, firstPrompt?: string): LaunchContext {
  const base: LaunchContext = {
    sessionId: SESSION_ID,
    serverUrl,
    hookToken: TOKEN,
    sessionDir: SESSION_DIR,
    worktreePath: WORKTREE,
  };
  return firstPrompt === undefined ? base : { ...base, firstPrompt };
}

function single(raw: unknown): AgentEvent {
  const { ctx, issued } = fixedContext(T0 + 7);
  const events = fakeAdapter.normalize(raw, ctx);
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event === undefined) throw new Error('no event');
  expect(event.v).toBe(1);
  expect(issued).toContain(event.id);
  expect(event.ts).toBe(T0 + 7);
  expect(event.sessionId).toBe(SESSION_ID);
  expect(event.provider).toBe('fake');
  return event;
}

function agentOf(world: WorldState, id: string): AgentState {
  const agent = world.agents[id];
  if (agent === undefined) throw new Error(`no agent ${id}`);
  return agent;
}

describe('fakeAdapter identity (D6)', () => {
  it("is provider 'fake', runs `node --version`, and uses HTTP hooks", () => {
    expect(fakeAdapter.id).toBe('fake');
    expect(fakeAdapter.binary).toEqual({ command: 'node', versionArgs: ['--version'] });
    expect(fakeAdapter.hooks).toBe('http');
  });

  it('maps its small tool set', () => {
    expect({ ...fakeAdapter.toolCategories }).toEqual({
      Read: 'read',
      Write: 'write',
      Bash: 'exec',
      Agent: 'delegate',
      AskUserQuestion: 'ask',
    });
  });
});

describe('fakeAdapter.launch (D6)', () => {
  const url = 'http://127.0.0.1:4317';

  it('args[0] is the absolute path of fake/cli.ts, which exists', () => {
    const [first] = fakeAdapter.launch(launchContext(url)).args;
    expect(first).toBeDefined();
    const script = first ?? '';
    expect(path.isAbsolute(script)).toBe(true);
    expect(path.normalize(script)).toBe(path.normalize(CLI_PATH));
    expect(existsSync(script)).toBe(true);
  });

  it.each([
    { name: 'without a first prompt', prompt: undefined },
    { name: 'with a first prompt', prompt: 'say hello' },
    { name: 'with a prompt that looks like a flag', prompt: '--scenario' },
  ])(
    'args after the script: an optional --scenario pair, then `-- <prompt>` ($name)',
    ({ prompt }) => {
      const args = fakeAdapter.launch(launchContext(url, prompt)).args.slice(1);
      const tail = prompt === undefined ? [] : ['--', prompt];
      expect(args.slice(args.length - tail.length)).toEqual(tail);
      const head = args.slice(0, args.length - tail.length);
      if (head.length > 0) {
        expect(head).toHaveLength(2);
        expect(head[0]).toBe('--scenario');
        expect(head[1]).toMatch(/^[a-z0-9-]+$/);
      }
    },
  );

  it('writes no files', () => {
    expect(fakeAdapter.launch(launchContext(url, 'x')).files).toEqual([]);
  });

  it('env is exactly the four MICROMINDS_ variables, provider fake', () => {
    expect(fakeAdapter.launch(launchContext(url, 'x')).env).toEqual({
      MICROMINDS_URL: url,
      MICROMINDS_SESSION_ID: SESSION_ID,
      MICROMINDS_HOOK_TOKEN: TOKEN,
      MICROMINDS_PROVIDER: 'fake',
    });
  });
});

describe('fakeAdapter.normalize (D6)', () => {
  it.each([
    {
      name: 'prompt.submitted with text',
      raw: { event: 'prompt.submitted', text: 'say hello' },
      expected: { kind: 'prompt.submitted', text: 'say hello' },
    },
    {
      name: 'tool.started(Read) with useId and summary',
      raw: { event: 'tool.started', tool: 'Read', useId: 'tu-1', summary: 'README.md' },
      expected: {
        kind: 'tool.started',
        tool: { name: 'Read', category: 'read', useId: 'tu-1', summary: 'README.md' },
      },
    },
    {
      name: 'tool.finished(Write)',
      raw: { event: 'tool.finished', tool: 'Write', useId: 'tu-2' },
      expected: {
        kind: 'tool.finished',
        tool: { name: 'Write', category: 'write', useId: 'tu-2' },
      },
    },
    {
      name: 'tool.failed(Bash)',
      raw: { event: 'tool.failed', tool: 'Bash', useId: 'tu-3' },
      expected: { kind: 'tool.failed', tool: { name: 'Bash', category: 'exec', useId: 'tu-3' } },
    },
    {
      name: 'tool.started(Agent) is delegate',
      raw: { event: 'tool.started', tool: 'Agent', useId: 'tu-4' },
      expected: {
        kind: 'tool.started',
        tool: { name: 'Agent', category: 'delegate', useId: 'tu-4' },
      },
    },
    {
      name: 'tool.started(AskUserQuestion) is ask',
      raw: { event: 'tool.started', tool: 'AskUserQuestion', useId: 'tu-5' },
      expected: {
        kind: 'tool.started',
        tool: { name: 'AskUserQuestion', category: 'ask', useId: 'tu-5' },
      },
    },
    {
      name: 'an unmapped tool is other',
      raw: { event: 'tool.started', tool: 'Mystery', useId: 'tu-6' },
      expected: {
        kind: 'tool.started',
        tool: { name: 'Mystery', category: 'other', useId: 'tu-6' },
      },
    },
    {
      name: 'turn.failed keeps errorClass',
      raw: { event: 'turn.failed', errorClass: 'rate_limit' },
      expected: { kind: 'turn.failed', errorClass: 'rate_limit' },
    },
    {
      name: 'turn.failed with errorClass auth',
      raw: { event: 'turn.failed', errorClass: 'auth' },
      expected: { kind: 'turn.failed', errorClass: 'auth' },
    },
    ...(
      [
        'turn.finished',
        'attention.permission',
        'attention.question',
        'attention.idle',
        'context.compacting',
        'session.ended',
        'session.crashed',
      ] as const
    ).map((kind) => ({ name: kind, raw: { event: kind }, expected: { kind } })),
  ])('$name', ({ raw, expected }) => {
    const event = single(raw);
    expect(event).toMatchObject(expected);
    expect(event.agentId).toBe(ROOT);
    expect(event).not.toHaveProperty('parentAgentId');
    if (!('tool' in expected)) expect(event).not.toHaveProperty('tool');
  });

  it.each([
    { kind: 'agent.spawned', raw: { event: 'agent.spawned', agent: 'sub-1', text: 'Explore' } },
    {
      kind: 'tool.started',
      raw: { event: 'tool.started', tool: 'Bash', useId: 'tu', agent: 'sub-1' },
    },
    { kind: 'agent.finished', raw: { event: 'agent.finished', agent: 'sub-1' } },
  ] as const)('`agent` attributes $kind to that subagent, parent the root', ({ kind, raw }) => {
    const event = single(raw);
    expect(event.kind).toBe(kind);
    expect(event.agentId).toBe('sub-1');
    expect(event.parentAgentId).toBe(ROOT);
  });

  it.each([
    { name: 'clock.tick (time comes from the server)', raw: { event: 'clock.tick' } },
    { name: 'session.started (comes from the PTY)', raw: { event: 'session.started' } },
    { name: 'an unheard-of event', raw: { event: 'fake.unheard_of', detail: 'kept' } },
    { name: 'a numeric event', raw: { event: 5 } },
    { name: 'no event', raw: { tool: 'Read' } },
    { name: 'an empty object', raw: {} },
    { name: 'a Claude payload', raw: { hook_event_name: 'Stop', session_id: 'x' } },
    { name: 'a string', raw: 'prompt.submitted' },
    { name: 'a number', raw: 3 },
    { name: 'an array', raw: [{ event: 'turn.finished' }] },
  ])('$name → one unknown event keeping raw', ({ raw }) => {
    const event = single(raw);
    expect(event.kind).toBe('unknown');
    expect(event.agentId).toBe(ROOT);
    expect(event.raw).toEqual(raw);
  });

  it('null → one unknown event, no throw', () => {
    expect(single(null).kind).toBe('unknown');
  });
});

describe('fixtures/fake/basic.jsonl (D8)', () => {
  const registry = createProviderRegistry([fakeAdapter]);
  const result = replay('fake', loadFakeFixture('basic'), (raw, ctx) =>
    registry.normalize('fake', raw, ctx),
  );

  it('normalizes to prompt.submitted → tool.started → tool.finished → turn.finished (in order)', () => {
    const kinds = result.events.map((e) => e.kind);
    const wanted: EventKind[] = [
      'prompt.submitted',
      'tool.started',
      'tool.finished',
      'turn.finished',
    ];
    let at = 0;
    for (const kind of kinds) if (kind === wanted[at]) at += 1;
    expect(at, `kinds were ${kinds.join(', ')}`).toBe(wanted.length);
  });

  it('has no unknown event and only root-agent or child events of our session', () => {
    for (const event of result.events) {
      expect(event.kind).not.toBe('unknown');
      expect(event.sessionId).toBe(SESSION_ID);
      expect(event.provider).toBe('fake');
    }
  });

  it('leaves the root agent idle and healthy after the replay', () => {
    const rootAgent = agentOf(result.final, ROOT);
    expect(rootAgent.activity).toBe('idle');
    expect(rootAgent.health).toBe('ok');
    expect(rootAgent.currentTool).toBeUndefined();
  });

  it('the subagent scenario shows a subagent that appears and finishes', () => {
    const sub = replay('fake', loadFakeFixture('subagent'), (raw, ctx) =>
      registry.normalize('fake', raw, ctx),
    );
    expect(sub.events.every((e) => e.kind !== 'unknown')).toBe(true);
    expect(Object.keys(sub.final.agents).sort()).toEqual([ROOT, 'fake-sub-1'].sort());
    expect(agentOf(sub.final, 'fake-sub-1').parentAgentId).toBe(ROOT);
    expect(agentOf(sub.final, 'fake-sub-1').activity).toBe('done');
    expect(agentOf(sub.final, ROOT).activity).toBe('idle');
  });
});

describe('the fake CLI started from fakeAdapter.launch (D6 + D7)', {
  timeout: TEST_TIMEOUT_MS,
}, () => {
  let server: HookServer | undefined;
  let running: RunningCli | undefined;

  afterEach(async () => {
    running?.kill();
    await server?.close();
    server = undefined;
    running = undefined;
  });

  it('posts the scenario for the first prompt to our session with the token from env', async () => {
    server = await startHookServer();
    const s = server;
    const spec = fakeAdapter.launch(launchContext(`${s.url}/`, 'say hello'));
    running = runCli({ argv: spec.args, extraEnv: spec.env });
    const c = running;
    const scenarioArg = spec.args.indexOf('--scenario');
    const scenario = scenarioArg === -1 ? 'basic' : (spec.args[scenarioArg + 1] ?? 'basic');
    const expected = loadFakeFixture(scenario);
    await waitFor(`${expected.length} posts`, () => s.received.length >= expected.length, c);
    expect(s.received.map((r): unknown => JSON.parse(r.body))).toEqual(expected);
    for (const r of s.received) {
      expect(new URL(r.url, s.url).pathname).toBe('/hooks');
      expect(new URL(r.url, s.url).searchParams.get('session')).toBe(SESSION_ID);
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
    c.write('/exit');
    expect(await c.exit()).toBe(0);
  });
});

describeConformance('fake', () => fakeAdapter, { fixtures: allFakeLines() });
