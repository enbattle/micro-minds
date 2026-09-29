// Task 2.1, clauses 1–5: the event vocabulary, the AgentEvent parser, schema versions and the
// PLAN §8 WS frames. Parsers return an explicit result and never throw.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { EventKind, ToolCategory } from './index.ts';
import {
  createWorld,
  EVENT_KINDS,
  EVENT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  parseAgentEvent,
  parseClientFrame,
  parseServerFrame,
  TOOL_CATEGORIES,
} from './index.ts';
import { ev, loadEventFixture, ROOT, run, SESSION_ID, SUB, T0 } from './shared.test-helpers.ts';

const PLAN_TOOL_CATEGORIES = ['read', 'write', 'exec', 'delegate', 'ask', 'web', 'other'];

const PLAN_EVENT_KINDS = [
  'session.started',
  'session.ended',
  'session.crashed',
  'prompt.submitted',
  'turn.finished',
  'turn.failed',
  'tool.started',
  'tool.finished',
  'tool.failed',
  'attention.permission',
  'attention.question',
  'attention.idle',
  'agent.spawned',
  'agent.finished',
  'context.compacting',
  'usage.recorded',
  'clock.tick',
  'unknown',
];

describe('vocabulary (PLAN §4.1)', () => {
  it('TOOL_CATEGORIES is exactly the §4.1 ToolCategory list', () => {
    expect([...TOOL_CATEGORIES].sort()).toEqual([...PLAN_TOOL_CATEGORIES].sort());
    expect(new Set(TOOL_CATEGORIES).size).toBe(TOOL_CATEGORIES.length);
  });

  it('EVENT_KINDS is exactly the §4.1 EventKind list', () => {
    expect([...EVENT_KINDS].sort()).toEqual([...PLAN_EVENT_KINDS].sort());
    expect(new Set(EVENT_KINDS).size).toBe(EVENT_KINDS.length);
  });

  it('the ToolCategory and EventKind types match the lists', () => {
    expectTypeOf<ToolCategory>().toEqualTypeOf<
      'read' | 'write' | 'exec' | 'delegate' | 'ask' | 'web' | 'other'
    >();
    expectTypeOf<EventKind>().toEqualTypeOf<
      | 'session.started'
      | 'session.ended'
      | 'session.crashed'
      | 'prompt.submitted'
      | 'turn.finished'
      | 'turn.failed'
      | 'tool.started'
      | 'tool.finished'
      | 'tool.failed'
      | 'attention.permission'
      | 'attention.question'
      | 'attention.idle'
      | 'agent.spawned'
      | 'agent.finished'
      | 'context.compacting'
      | 'usage.recorded'
      | 'clock.tick'
      | 'unknown'
    >();
  });
});

/** A valid event as plain JSON (what the store or the wire would hand the parser). */
function validEventJson(): Record<string, unknown> {
  return {
    v: EVENT_SCHEMA_VERSION,
    id: '01K6D00000000000000000000A',
    ts: T0,
    sessionId: SESSION_ID,
    provider: 'claude',
    agentId: ROOT,
    kind: 'tool.started',
    tool: { name: 'Bash', category: 'exec', useId: 'toolu_01', summary: 'npm test' },
  };
}

function without(key: string): Record<string, unknown> {
  const copy = validEventJson();
  delete copy[key];
  return copy;
}

function withField(key: string, value: unknown): Record<string, unknown> {
  return { ...validEventJson(), [key]: value };
}

describe('parseAgentEvent: valid events are accepted', () => {
  it.each([
    { name: 'tool.started with a tool', input: validEventJson() },
    {
      name: 'minimal prompt.submitted',
      input: {
        v: EVENT_SCHEMA_VERSION,
        id: '01K6D00000000000000000000B',
        ts: T0,
        sessionId: SESSION_ID,
        provider: 'claude',
        agentId: ROOT,
        kind: 'prompt.submitted',
      },
    },
    {
      name: 'agent.spawned for a subagent with parentAgentId and text',
      input: {
        v: EVENT_SCHEMA_VERSION,
        id: '01K6D00000000000000000000C',
        ts: T0,
        sessionId: SESSION_ID,
        provider: 'claude',
        agentId: SUB,
        parentAgentId: ROOT,
        kind: 'agent.spawned',
        text: 'Explore',
      },
    },
    {
      name: 'turn.failed with an errorClass',
      input: {
        ...validEventJson(),
        kind: 'turn.failed',
        tool: undefined,
        errorClass: 'rate_limit',
      },
    },
    {
      name: 'usage.recorded with a usage delta',
      input: {
        v: EVENT_SCHEMA_VERSION,
        id: '01K6D00000000000000000000D',
        ts: T0,
        sessionId: SESSION_ID,
        provider: 'claude',
        agentId: ROOT,
        kind: 'usage.recorded',
        usage: {
          model: 'claude-opus-5-5',
          source: 'otel',
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.5,
        },
      },
    },
    {
      name: 'an event carrying a raw payload',
      input: { ...validEventJson(), raw: { hook_event_name: 'PreToolUse', nested: [1, 2] } },
    },
  ])('$name', ({ input }) => {
    const clean = JSON.parse(JSON.stringify(input)) as unknown;
    const result = parseAgentEvent(clean);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(clean);
    }
  });
});

describe('parseAgentEvent: invalid events are rejected explicitly, never thrown', () => {
  it.each([
    { name: 'missing id', input: without('id') },
    { name: 'missing ts', input: without('ts') },
    { name: 'missing sessionId', input: without('sessionId') },
    { name: 'missing provider', input: without('provider') },
    { name: 'missing agentId', input: without('agentId') },
    { name: 'missing kind', input: without('kind') },
    { name: 'missing v', input: without('v') },
    { name: 'ts is a string', input: withField('ts', '1790000000000') },
    { name: 'id is a number', input: withField('id', 42) },
    { name: 'sessionId is null', input: withField('sessionId', null) },
    { name: 'provider is not a known provider', input: withField('provider', 'openai') },
    { name: 'kind is a number', input: withField('kind', 7) },
    { name: 'tool has no name', input: withField('tool', { category: 'exec' }) },
    {
      name: 'tool.category is not a ToolCategory',
      input: withField('tool', { name: 'Bash', category: 'shell' }),
    },
    { name: 'errorClass is not a known class', input: withField('errorClass', 'timeout') },
    {
      name: 'usage has a string token count',
      input: {
        ...withField('kind', 'usage.recorded'),
        tool: undefined,
        usage: {
          model: 'm',
          source: 'otel',
          inputTokens: 'ten',
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
      },
    },
    { name: 'null', input: null },
    { name: 'a string', input: 'tool.started' },
    { name: 'a number', input: 42 },
    { name: 'an array', input: [validEventJson()] },
    { name: 'an empty object', input: {} },
  ])('$name → invalid', ({ input }) => {
    const clean: unknown = input === null ? null : JSON.parse(JSON.stringify(input));
    // A throw fails the test: parsers return a result instead.
    const result = parseAgentEvent(clean);
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('parseAgentEvent: unknown kinds become kind "unknown" (hard rule 7)', () => {
  it.each([
    { name: 'a future kind', kind: 'task.teleported' },
    { name: 'a provider hook name', kind: 'PreToolUse' },
    { name: 'an empty string', kind: '' },
  ])('$name parses as unknown with the original input kept as raw', ({ kind }) => {
    const base = validEventJson();
    const input = { ...base, kind };
    // A throw fails the test: parsers return a result instead.
    const result = parseAgentEvent(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('unknown');
      expect(result.value.raw).toEqual(input);
      expect(result.value).toMatchObject({
        id: base.id,
        ts: base.ts,
        sessionId: SESSION_ID,
        agentId: ROOT,
        provider: 'claude',
      });
    }
  });
});

describe('parseAgentEvent: schema version v', () => {
  it('every parsed event carries the current v', () => {
    const result = parseAgentEvent(validEventJson());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.v).toBe(EVENT_SCHEMA_VERSION);
    }
  });

  it('events built by the fixtures and helpers carry v', () => {
    for (const event of loadEventFixture('qa')) {
      expect(event.v).toBe(EVENT_SCHEMA_VERSION);
    }
    expect(ev('prompt.submitted', { ts: T0 }).v).toBe(EVENT_SCHEMA_VERSION);
  });

  it.each([
    { name: 'the next version', input: withField('v', EVENT_SCHEMA_VERSION + 1) },
    { name: 'a far future version', input: withField('v', 999) },
    { name: 'version 0', input: withField('v', 0) },
    {
      name: 'a future version whose other fields changed shape',
      input: { v: EVENT_SCHEMA_VERSION + 1, eventId: 'x', at: 'yesterday', what: { k: 1 } },
    },
    {
      name: 'a future version with a kind this version does not know',
      input: { ...validEventJson(), v: EVENT_SCHEMA_VERSION + 1, kind: 'task.teleported' },
    },
  ])('$name → unsupported_version, not thrown and not accepted', ({ input }) => {
    // A throw fails the test: parsers return a result instead.
    const result = parseAgentEvent(input);
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_version' });
  });
});

// ─── WS frames (PLAN §8) ──────────────────────────────────────────────────────────────────────

const V = PROTOCOL_VERSION;

function frameEvent(): Record<string, unknown> {
  const event = validEventJson();
  return event;
}

const validServerFrames: { name: string; frame: Record<string, unknown> }[] = [
  { name: 'snapshot of an empty world', frame: { t: 'snapshot', v: V, world: createWorld() } },
  {
    name: 'snapshot of a world with agents and usage',
    frame: {
      t: 'snapshot',
      v: V,
      world: JSON.parse(JSON.stringify(run(loadEventFixture('read-edit')))) as unknown,
    },
  },
  {
    name: 'snapshot of a world with a subagent',
    frame: {
      t: 'snapshot',
      v: V,
      world: JSON.parse(JSON.stringify(run(loadEventFixture('subagent')))) as unknown,
    },
  },
  { name: 'event', frame: { t: 'event', v: V, event: frameEvent() } },
  { name: 'pty.data', frame: { t: 'pty.data', v: V, sessionId: SESSION_ID, data: 'hello\r\n' } },
  { name: 'pty.exit', frame: { t: 'pty.exit', v: V, sessionId: SESSION_ID, code: 0 } },
  {
    name: 'pty.snapshot',
    frame: { t: 'pty.snapshot', v: V, sessionId: SESSION_ID, data: '\u001b[2J$ ' },
  },
  {
    name: 'usage.summary',
    frame: {
      t: 'usage.summary',
      v: V,
      today: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        costUsd: 0.25,
      },
    },
  },
  {
    name: 'error',
    frame: { t: 'error', v: V, code: 'protocol_mismatch', message: 'Reload the page' },
  },
];

const validClientFrames: { name: string; frame: Record<string, unknown> }[] = [
  {
    name: 'session.create, minimal',
    frame: { t: 'session.create', v: V, provider: 'claude', repoPath: 'C:\\repos\\demo' },
  },
  {
    name: 'session.create with name and initialPrompt',
    frame: {
      t: 'session.create',
      v: V,
      provider: 'fake',
      repoPath: '/home/me/demo',
      name: 'claude-1',
      initialPrompt: 'Fix the failing test',
    },
  },
  { name: 'session.stop', frame: { t: 'session.stop', v: V, sessionId: SESSION_ID } },
  { name: 'session.kill', frame: { t: 'session.kill', v: V, sessionId: SESSION_ID } },
  { name: 'session.resume', frame: { t: 'session.resume', v: V, sessionId: SESSION_ID } },
  {
    name: 'worktree.remove',
    frame: { t: 'worktree.remove', v: V, sessionId: SESSION_ID, confirm: true },
  },
  { name: 'app.quit', frame: { t: 'app.quit', v: V, confirm: true } },
  { name: 'pty.input', frame: { t: 'pty.input', v: V, sessionId: SESSION_ID, data: 'ls\r' } },
  {
    name: 'pty.resize',
    frame: { t: 'pty.resize', v: V, sessionId: SESSION_ID, cols: 120, rows: 40 },
  },
];

describe('parseServerFrame: every §8 server → client frame is accepted', () => {
  it.each(validServerFrames)('$name', ({ frame }) => {
    const result = parseServerFrame(frame);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.t).toBe(frame.t);
      expect(result.value.v).toBe(V);
    }
  });
});

describe('parseClientFrame: every §8 client → server frame is accepted', () => {
  it.each(validClientFrames)('$name', ({ frame }) => {
    const result = parseClientFrame(frame);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(frame);
    }
  });
});

describe('frames with an unknown t or invalid fields are rejected explicitly', () => {
  it.each([
    { name: 'unknown t', frame: { t: 'world.destroy', v: V } },
    { name: 'empty t', frame: { t: '', v: V } },
    { name: 'no t', frame: { v: V, sessionId: SESSION_ID } },
    { name: 'a client frame', frame: { t: 'pty.input', v: V, sessionId: SESSION_ID, data: 'x' } },
    {
      name: 'pty.exit with a string code',
      frame: { t: 'pty.exit', v: V, sessionId: SESSION_ID, code: '0' },
    },
    { name: 'pty.data without data', frame: { t: 'pty.data', v: V, sessionId: SESSION_ID } },
    { name: 'error without message', frame: { t: 'error', v: V, code: 'x' } },
    {
      name: 'event whose event is invalid',
      frame: { t: 'event', v: V, event: { ...frameEvent(), ts: 'now' } },
    },
    { name: 'snapshot without world', frame: { t: 'snapshot', v: V } },
    { name: 'missing v', frame: { t: 'pty.exit', sessionId: SESSION_ID, code: 0 } },
    { name: 'null', frame: null },
    { name: 'a string', frame: 'snapshot' },
    { name: 'an array', frame: [] },
  ])('server frame: $name → invalid', ({ frame }) => {
    // A throw fails the test: parsers return a result instead.
    const result = parseServerFrame(frame);
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it.each([
    { name: 'unknown t', frame: { t: 'session.teleport', v: V, sessionId: SESSION_ID } },
    { name: 'no t', frame: { v: V, sessionId: SESSION_ID } },
    { name: 'a server frame', frame: { t: 'pty.exit', v: V, sessionId: SESSION_ID, code: 0 } },
    {
      name: 'pty.resize with string cols',
      frame: { t: 'pty.resize', v: V, sessionId: SESSION_ID, cols: '120', rows: 40 },
    },
    {
      name: 'pty.resize without rows',
      frame: { t: 'pty.resize', v: V, sessionId: SESSION_ID, cols: 120 },
    },
    {
      name: 'worktree.remove with confirm false',
      frame: { t: 'worktree.remove', v: V, sessionId: SESSION_ID, confirm: false },
    },
    {
      name: 'worktree.remove without confirm',
      frame: { t: 'worktree.remove', v: V, sessionId: SESSION_ID },
    },
    { name: 'app.quit without confirm', frame: { t: 'app.quit', v: V } },
    { name: 'app.quit with confirm false', frame: { t: 'app.quit', v: V, confirm: false } },
    {
      name: 'session.create with an unknown provider',
      frame: { t: 'session.create', v: V, provider: 'openai', repoPath: '/r' },
    },
    {
      name: 'session.create without repoPath',
      frame: { t: 'session.create', v: V, provider: 'claude' },
    },
    {
      name: 'pty.input with numeric data',
      frame: { t: 'pty.input', v: V, sessionId: SESSION_ID, data: 13 },
    },
    { name: 'session.stop without sessionId', frame: { t: 'session.stop', v: V } },
    { name: 'missing v', frame: { t: 'session.stop', sessionId: SESSION_ID } },
    { name: 'undefined', frame: undefined },
    { name: 'a number', frame: 7 },
  ])('client frame: $name → invalid', ({ frame }) => {
    // A throw fails the test: parsers return a result instead.
    const result = parseClientFrame(frame);
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('frames with an unknown v are rejected as unsupported_version', () => {
  it.each([
    { name: 'next version', v: PROTOCOL_VERSION + 1 },
    { name: 'far future version', v: 999 },
    { name: 'version 0', v: 0 },
  ])('server snapshot, $name', ({ v }) => {
    // A throw fails the test: parsers return a result instead.
    const result = parseServerFrame({ t: 'snapshot', v, world: { someNewShape: true } });
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_version' });
  });

  it.each([
    { name: 'next version', v: PROTOCOL_VERSION + 1 },
    { name: 'far future version', v: 999 },
    { name: 'version 0', v: 0 },
  ])('client pty.input, $name', ({ v }) => {
    // A throw fails the test: parsers return a result instead.
    const result = parseClientFrame({ t: 'pty.input', v, sessionId: SESSION_ID, data: 'x' });
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_version' });
  });

  it('a valid-looking frame with the current v is not reported as a version problem', () => {
    const ok = parseClientFrame({ t: 'pty.input', v: V, sessionId: SESSION_ID, data: 'x' });
    expect(ok.ok).toBe(true);
  });
});
