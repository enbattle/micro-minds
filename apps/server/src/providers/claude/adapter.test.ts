// Task 2.4, clauses D2, D3, D4 and D9: the Claude Code adapter. Mapping per
// docs/protocols/claude.md ("Event mapping", "Tool categories", findings 1–8). Payloads come from
// fixtures/claude/ where a recording exists; the few synthetic payloads follow the doc's field
// lists for hooks never recorded (StopFailure, elicitation_dialog, other tools' inputs).
import path from 'node:path';
import type { AgentEvent } from '@micro-minds/shared';
import { describe, expect, it } from 'vitest';
import { describeConformance } from '../conformance.test-helpers.ts';
import { hookEndpoint } from '../hook-url.ts';
import {
  allClaudeHookLines,
  claudeHookFixtureNames,
  fixedContext,
  loadClaudeFixture,
  ROOT,
  SESSION_ID,
  T0,
  transcriptPaths,
  withoutTranscripts,
} from '../replay.test-helpers.ts';
import type { LaunchContext } from '../types.ts';
import { claudeAdapter } from './adapter.ts';

const TOKEN = 'mmhook-claude-test-Zq8Wv3Nn5Pp7Rr9Tt1';
const SERVER_URL = 'http://127.0.0.1:4317';
const SESSION_DIR = path.resolve(path.sep, 'mm-test', 'sessions', SESSION_ID);
const WORKTREE = path.resolve(path.sep, 'mm-test', 'worktrees', 'repo', SESSION_ID);
const SUB = 'a0000000000000009';

function launchContext(overrides: Partial<LaunchContext> = {}): LaunchContext {
  return {
    sessionId: SESSION_ID,
    serverUrl: SERVER_URL,
    hookToken: TOKEN,
    sessionDir: SESSION_DIR,
    worktreePath: WORKTREE,
    ...overrides,
  };
}

/** A Claude hook payload with the common fields every recording has. */
function hook(name: unknown, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: '00000000-0000-4000-8000-000000000001',
    transcript_path: 'C:\\Users\\user\\.claude\\projects\\sample-repo\\t-0001.jsonl',
    cwd: 'C:\\Users\\user\\projects\\sample-repo',
    prompt_id: '00000000-0000-4000-8000-000000000002',
    permission_mode: 'auto',
    hook_event_name: name,
    ...fields,
  };
}

function normalize(raw: unknown, receivedAt: number = T0): AgentEvent[] {
  return claudeAdapter.normalize(raw, fixedContext(receivedAt).ctx);
}

/** The single event a payload must yield. */
function single(raw: unknown): AgentEvent {
  const events = normalize(raw);
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event === undefined) throw new Error('no event');
  return event;
}

/** Line `index` of a Claude fixture. */
function fixtureLine(name: string, index: number): unknown {
  const line = loadClaudeFixture(name)[index];
  if (line === undefined) throw new Error(`${name}.jsonl has no line ${index}`);
  return line;
}

const THIRTEEN_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'PreCompact',
] as const;

describe('claudeAdapter identity (D2)', () => {
  it("is provider 'claude', runs `claude --version`, and uses native HTTP hooks", () => {
    expect(claudeAdapter.id).toBe('claude');
    expect(claudeAdapter.binary).toEqual({ command: 'claude', versionArgs: ['--version'] });
    expect(claudeAdapter.hooks).toBe('http');
  });

  it('maps exactly the tools of the protocol table, nothing else', () => {
    expect({ ...claudeAdapter.toolCategories }).toEqual({
      Read: 'read',
      Glob: 'read',
      Grep: 'read',
      Edit: 'write',
      Write: 'write',
      NotebookEdit: 'write',
      Bash: 'exec',
      PowerShell: 'exec',
      Agent: 'delegate',
      Task: 'delegate',
      AskUserQuestion: 'ask',
      WebFetch: 'web',
      WebSearch: 'web',
    });
  });

  it.each([
    'SubagentHandback',
    'mcp__github__search_issues',
    'TodoWrite',
    'constructor',
    '__proto__',
  ])('%s is unmapped (→ other)', (tool) => {
    expect(Object.hasOwn(claudeAdapter.toolCategories, tool)).toBe(false);
  });
});

describe('claudeAdapter.launch (D3)', () => {
  const settingsPath = path.join(SESSION_DIR, 'settings.json');

  function settingsOf(ctx: LaunchContext): unknown {
    const spec = claudeAdapter.launch(ctx);
    expect(spec.files).toHaveLength(1);
    const [file] = spec.files;
    if (file === undefined) throw new Error('no settings file');
    expect(file.name).toBe('settings.json');
    return JSON.parse(file.content);
  }

  function expectedSettings(ctx: LaunchContext): unknown {
    const entry = [
      {
        hooks: [
          {
            type: 'http',
            url: hookEndpoint(ctx.serverUrl, ctx.sessionId),
            headers: { Authorization: 'Bearer $MICROMINDS_HOOK_TOKEN' },
            allowedEnvVars: ['MICROMINDS_HOOK_TOKEN'],
            timeout: 1,
          },
        ],
      },
    ];
    return { hooks: Object.fromEntries(THIRTEEN_EVENTS.map((name) => [name, entry])) };
  }

  it.each([
    { name: 'plain server URL', serverUrl: 'http://127.0.0.1:4317' },
    { name: 'server URL with a trailing slash', serverUrl: 'http://127.0.0.1:4317/' },
    { name: 'another port', serverUrl: 'http://127.0.0.1:61234' },
  ])('settings.json holds exactly the 13 HTTP hooks and nothing else ($name)', ({ serverUrl }) => {
    const ctx = launchContext({ serverUrl });
    expect(settingsOf(ctx)).toEqual(expectedSettings(ctx));
  });

  it('every hook posts to hookEndpoint(serverUrl, sessionId)', () => {
    const settings = settingsOf(launchContext({ serverUrl: 'http://127.0.0.1:4317/' }));
    const text = JSON.stringify(settings);
    expect(text).toContain(`http://127.0.0.1:4317/hooks?session=${SESSION_ID}`);
    expect(text).not.toContain('4317//hooks');
  });

  it('settings.json has no top-level key besides hooks (no permissions, no env)', () => {
    const settings = settingsOf(launchContext());
    expect(typeof settings === 'object' && settings !== null && Object.keys(settings)).toEqual([
      'hooks',
    ]);
  });

  it('the settings file never holds the hook token', () => {
    const spec = claudeAdapter.launch(launchContext({ firstPrompt: 'hi' }));
    for (const file of spec.files) {
      expect(file.content).not.toContain(TOKEN);
      expect(file.name).not.toContain(TOKEN);
    }
    for (const arg of spec.args) expect(arg).not.toContain(TOKEN);
  });

  it.each([
    { name: 'without a first prompt', firstPrompt: undefined, tail: [] as string[] },
    { name: 'with a first prompt', firstPrompt: 'fix the test', tail: ['--', 'fix the test'] },
    {
      name: 'with a prompt that looks like a flag',
      firstPrompt: '--dangerously-skip-permissions',
      tail: ['--', '--dangerously-skip-permissions'],
    },
    {
      name: 'with a multi-line prompt',
      firstPrompt: 'line one\nline "two"',
      tail: ['--', 'line one\nline "two"'],
    },
  ])('args: --settings <sessionDir/settings.json> $name', ({ firstPrompt, tail }) => {
    const ctx =
      firstPrompt === undefined ? launchContext() : launchContext({ firstPrompt: firstPrompt });
    expect(claudeAdapter.launch(ctx).args).toEqual(['--settings', settingsPath, ...tail]);
  });

  it('env is exactly the four MICROMINDS_ variables', () => {
    expect(claudeAdapter.launch(launchContext({ firstPrompt: 'x' })).env).toEqual({
      MICROMINDS_URL: SERVER_URL,
      MICROMINDS_SESSION_ID: SESSION_ID,
      MICROMINDS_HOOK_TOKEN: TOKEN,
      MICROMINDS_PROVIDER: 'claude',
    });
  });
});

describe('claudeAdapter.normalize: common fields (D4)', () => {
  const lines = allClaudeHookLines().map((payload, i) => ({ i, payload }));

  it('the hook fixtures are present', () => {
    expect(claudeHookFixtureNames().length).toBeGreaterThanOrEqual(11);
    expect(lines.length).toBeGreaterThan(50);
  });

  it.each(lines)(
    'hook fixture line #$i: v 1, fresh id, receivedAt, our session, claude, raw without transcripts',
    ({ payload }) => {
      const { ctx, issued } = fixedContext(T0 + 42);
      const events = claudeAdapter.normalize(payload, ctx);
      const ids = new Set<string>();
      for (const event of events) {
        expect(event.v).toBe(1);
        expect(issued).toContain(event.id);
        expect(ids.has(event.id)).toBe(false);
        ids.add(event.id);
        expect(event.ts).toBe(T0 + 42);
        expect(event.sessionId).toBe(SESSION_ID);
        expect(event.provider).toBe('claude');
        expect(event.raw).toEqual(withoutTranscripts(payload));
        const text = JSON.stringify(event);
        for (const transcript of transcriptPaths(payload)) {
          expect(text).not.toContain(JSON.stringify(transcript).slice(1, -1));
        }
        expect(event).not.toHaveProperty('health');
        expect(event).not.toHaveProperty('severity');
        expect(event).not.toHaveProperty('attention');
      }
    },
  );

  it('a subagent payload keeps agent_transcript_path out of raw', () => {
    const payload = hook('SubagentStop', {
      agent_id: SUB,
      agent_type: 'Explore',
      agent_transcript_path: 'C:\\Users\\user\\.claude\\projects\\x\\subagents\\agent-9.jsonl',
    });
    const event = single(payload);
    expect(event.raw).toEqual(withoutTranscripts(payload));
    expect(event.raw).not.toHaveProperty('agent_transcript_path');
    expect(event.raw).not.toHaveProperty('transcript_path');
  });
});

describe('claudeAdapter.normalize: attribution (D4)', () => {
  it.each([
    { name: 'a non-empty agent_id → that subagent', agentId: SUB, sub: true },
    { name: 'an empty agent_id → the root agent', agentId: '', sub: false },
    { name: 'a numeric agent_id → the root agent', agentId: 7, sub: false },
    { name: 'an object agent_id → the root agent', agentId: { id: SUB }, sub: false },
    { name: 'no agent_id → the root agent', agentId: undefined, sub: false },
  ])('$name', ({ agentId, sub }) => {
    const fields: Record<string, unknown> = {
      tool_name: 'Read',
      tool_input: { file_path: 'src/a.ts' },
      tool_use_id: 'toolu_9',
    };
    if (agentId !== undefined) fields.agent_id = agentId;
    const event = single(hook('PreToolUse', fields));
    if (sub) {
      expect(event.agentId).toBe(SUB);
      expect(event.parentAgentId).toBe(ROOT);
    } else {
      expect(event.agentId).toBe(ROOT);
      expect(event).not.toHaveProperty('parentAgentId');
    }
  });
});

describe('claudeAdapter.normalize: event mapping (D4)', () => {
  it('SessionStart yields no event (session.started comes from the PTY)', () => {
    expect(normalize(fixtureLine('qa-command-hook', 0))).toEqual([]);
    expect(normalize(hook('SessionStart', { source: 'resume', model: 'x' }))).toEqual([]);
  });

  it.each([
    {
      name: 'UserPromptSubmit',
      payload: hook('UserPromptSubmit', { prompt: 'hi' }),
      kind: 'prompt.submitted',
    },
    { name: 'Stop', payload: hook('Stop', { stop_hook_active: false }), kind: 'turn.finished' },
    {
      name: 'PreCompact',
      payload: hook('PreCompact', { trigger: 'manual' }),
      kind: 'context.compacting',
    },
    {
      name: 'PreCompact (auto)',
      payload: hook('PreCompact', { trigger: 'auto' }),
      kind: 'context.compacting',
    },
    {
      name: 'SessionEnd',
      payload: hook('SessionEnd', { reason: 'prompt_input_exit' }),
      kind: 'session.ended',
    },
  ] as const)('$name → $kind for the root agent', ({ payload, kind }) => {
    const event = single(payload);
    expect(event.kind).toBe(kind);
    expect(event.agentId).toBe(ROOT);
  });

  it('Stop while background subagents run is still turn.finished for the root', () => {
    const event = single(
      hook('Stop', {
        background_tasks: [{ id: SUB, type: 'agent', agent_type: 'Explore', status: 'running' }],
      }),
    );
    expect(event.kind).toBe('turn.finished');
    expect(event.agentId).toBe(ROOT);
  });

  describe('prompt.submitted text', () => {
    it('the recorded prompt passes through unchanged', () => {
      expect(single(fixtureLine('qa', 0)).text).toBe(
        "In one sentence, what is a pure function? Don't use any tools.",
      );
    });

    it.each([
      { name: 'newlines', prompt: 'first line\nsecond line', expected: 'first line second line' },
      { name: 'CRLF and tabs', prompt: 'a\r\n\tb', expected: 'a b' },
      { name: 'runs of spaces', prompt: 'a    b     c', expected: 'a b c' },
      { name: 'blank lines', prompt: 'a\n\n\n  b', expected: 'a b' },
    ])('is one line: $name collapse to one space', ({ prompt, expected }) => {
      expect(single(hook('UserPromptSubmit', { prompt })).text).toBe(expected);
    });

    it('a 200-character prompt is kept whole', () => {
      const prompt = 'p'.repeat(200);
      expect(single(hook('UserPromptSubmit', { prompt })).text).toBe(prompt);
    });

    it.each([201, 500, 10_000])('a %i-character prompt is cut to at most 200, ending in …', (n) => {
      const prompt = 'abcdefghij'.repeat(Math.ceil(n / 10)).slice(0, n);
      const text = single(hook('UserPromptSubmit', { prompt })).text ?? '';
      expect(text.length).toBeLessThanOrEqual(200);
      expect(text.length).toBeGreaterThanOrEqual(190);
      expect(text.endsWith('…')).toBe(true);
      expect(prompt.startsWith(text.slice(0, -1))).toBe(true);
    });

    it('collapses whitespace before cutting', () => {
      const prompt = `${'word '.repeat(30)}\n\n\n${'x'.repeat(300)}`;
      const text = single(hook('UserPromptSubmit', { prompt })).text ?? '';
      expect(text).not.toMatch(/\s{2,}|\n/);
      expect(text.length).toBeLessThanOrEqual(200);
      expect(text.endsWith('…')).toBe(true);
    });

    it.each([
      { name: 'missing', prompt: undefined },
      { name: 'a number', prompt: 12 },
      { name: 'an object', prompt: { text: 'x' } },
    ])('a prompt that is $name → prompt.submitted without text, no throw', ({ prompt }) => {
      const fields: Record<string, unknown> = prompt === undefined ? {} : { prompt };
      const event = single(hook('UserPromptSubmit', fields));
      expect(event.kind).toBe('prompt.submitted');
      expect(event.text).toBeUndefined();
    });
  });

  describe('tool events', () => {
    it.each([
      { hookName: 'PreToolUse', kind: 'tool.started' },
      { hookName: 'PostToolUse', kind: 'tool.finished' },
      { hookName: 'PostToolUseFailure', kind: 'tool.failed' },
    ] as const)(
      '$hookName → $kind with name, category, useId and summary',
      ({ hookName, kind }) => {
        const event = single(
          hook(hookName, {
            tool_name: 'Bash',
            tool_input: { command: 'npm test', description: 'Run tests' },
            tool_use_id: 'toolu_42',
            ...(hookName === 'PostToolUseFailure'
              ? { error: 'Exit code 1', is_interrupt: false }
              : {}),
            ...(hookName === 'PostToolUse' ? { tool_response: { stdout: 'ok' } } : {}),
          }),
        );
        expect(event.kind).toBe(kind);
        expect(event.tool).toEqual({
          name: 'Bash',
          category: 'exec',
          useId: 'toolu_42',
          summary: 'npm test',
        });
      },
    );

    it.each([
      { tool: 'Read', category: 'read' },
      { tool: 'Glob', category: 'read' },
      { tool: 'Grep', category: 'read' },
      { tool: 'Edit', category: 'write' },
      { tool: 'Write', category: 'write' },
      { tool: 'NotebookEdit', category: 'write' },
      { tool: 'Bash', category: 'exec' },
      { tool: 'PowerShell', category: 'exec' },
      { tool: 'Agent', category: 'delegate' },
      { tool: 'Task', category: 'delegate' },
      { tool: 'WebFetch', category: 'web' },
      { tool: 'WebSearch', category: 'web' },
      { tool: 'SubagentHandback', category: 'other' },
      { tool: 'mcp__github__search_issues', category: 'other' },
      { tool: 'SomeFutureTool', category: 'other' },
    ] as const)('tool.started($tool) has category $category', ({ tool, category }) => {
      const event = single(
        hook('PreToolUse', { tool_name: tool, tool_input: {}, tool_use_id: 'toolu_1' }),
      );
      expect(event.kind).toBe('tool.started');
      expect(event.tool?.name).toBe(tool);
      expect(event.tool?.category).toBe(category);
    });

    it('PostToolUse(AskUserQuestion) is tool.finished with category ask', () => {
      const event = single(fixtureLine('ask-user-question', 3));
      expect(event.kind).toBe('tool.finished');
      expect(event.tool).toMatchObject({
        name: 'AskUserQuestion',
        category: 'ask',
        useId: 'toolu_000001',
      });
    });

    it('PreToolUse(AskUserQuestion) → attention.question, not tool.started', () => {
      const event = single(fixtureLine('ask-user-question', 1));
      expect(event.kind).toBe('attention.question');
      expect(event.agentId).toBe(ROOT);
    });

    it('a failed shell command (finding 2) is tool.failed for Bash', () => {
      const event = single(fixtureLine('failing-shell', 2));
      expect(event.kind).toBe('tool.failed');
      expect(event.tool).toEqual({
        name: 'Bash',
        category: 'exec',
        useId: 'toolu_000001',
        summary: 'node scripts/fail.js',
      });
    });

    it('the masked failure (finding 2) is tool.finished', () => {
      const event = single(fixtureLine('failing-shell-masked', 2));
      expect(event.kind).toBe('tool.finished');
      expect(event.tool).toEqual({
        name: 'Bash',
        category: 'exec',
        useId: 'toolu_000001',
        summary: 'node scripts/fail.js; echo "EXIT: $?"',
      });
    });
  });

  describe('tool.summary', () => {
    it.each([
      {
        name: 'Bash → command',
        tool: 'Bash',
        input: { command: 'ls -la', description: 'List' },
        summary: 'ls -la',
      },
      {
        name: 'PowerShell → command',
        tool: 'PowerShell',
        input: { command: 'Get-ChildItem' },
        summary: 'Get-ChildItem',
      },
      {
        name: 'Read → file_path',
        tool: 'Read',
        input: { file_path: 'src/a.ts', limit: 10 },
        summary: 'src/a.ts',
      },
      {
        name: 'Edit → file_path',
        tool: 'Edit',
        input: { file_path: 'src/b.ts', old_string: 'x', new_string: 'y' },
        summary: 'src/b.ts',
      },
      {
        name: 'Write → file_path',
        tool: 'Write',
        input: { file_path: 'notes.txt', content: 'hello' },
        summary: 'notes.txt',
      },
      {
        name: 'NotebookEdit → notebook_path',
        tool: 'NotebookEdit',
        input: { notebook_path: 'nb.ipynb', new_source: 'x' },
        summary: 'nb.ipynb',
      },
      {
        name: 'NotebookEdit prefers notebook_path',
        tool: 'NotebookEdit',
        input: { notebook_path: 'nb.ipynb', file_path: 'other.ipynb' },
        summary: 'nb.ipynb',
      },
      {
        name: 'NotebookEdit falls back to file_path',
        tool: 'NotebookEdit',
        input: { file_path: 'fb.ipynb' },
        summary: 'fb.ipynb',
      },
      {
        name: 'Glob → pattern',
        tool: 'Glob',
        input: { pattern: '**/*.ts', path: 'src' },
        summary: '**/*.ts',
      },
      {
        name: 'Grep → pattern',
        tool: 'Grep',
        input: { pattern: 'TODO\\(.*\\)', glob: '*.ts' },
        summary: 'TODO\\(.*\\)',
      },
      {
        name: 'Agent → description',
        tool: 'Agent',
        input: { description: 'Explore repo', prompt: 'long prompt' },
        summary: 'Explore repo',
      },
      {
        name: 'Task → description',
        tool: 'Task',
        input: { description: 'Old name', prompt: 'p' },
        summary: 'Old name',
      },
      {
        name: 'WebFetch → url',
        tool: 'WebFetch',
        input: { url: 'https://example.com/a', prompt: 'p' },
        summary: 'https://example.com/a',
      },
      {
        name: 'WebSearch → query',
        tool: 'WebSearch',
        input: { query: 'vitest each' },
        summary: 'vitest each',
      },
      {
        name: 'AskUserQuestion → the first question',
        tool: 'AskUserQuestion',
        input: { questions: [{ question: 'A or B?', header: 'Choice' }, { question: 'Second?' }] },
        summary: 'A or B?',
      },
    ])('$name', ({ tool, input, summary }) => {
      // PostToolUse, so AskUserQuestion is a tool event too.
      const event = single(
        hook('PostToolUse', { tool_name: tool, tool_input: input, tool_use_id: 'toolu_s' }),
      );
      expect(event.tool?.summary).toBe(summary);
    });

    it.each([
      {
        name: 'an unmapped tool',
        tool: 'mcp__x__y',
        input: { command: 'ls', query: 'q', file_path: 'f' },
      },
      { name: 'SubagentHandback', tool: 'SubagentHandback', input: { message: 'done' } },
      { name: 'Bash with a numeric command', tool: 'Bash', input: { command: 42 } },
      { name: 'Bash with no command', tool: 'Bash', input: { description: 'x' } },
      { name: 'Read with an object file_path', tool: 'Read', input: { file_path: { p: 1 } } },
      { name: 'tool_input a string', tool: 'Bash', input: 'ls -la' },
      { name: 'tool_input null', tool: 'Read', input: null },
      { name: 'tool_input an array', tool: 'Grep', input: ['pattern'] },
      { name: 'tool_input missing', tool: 'Bash', input: undefined },
      {
        name: 'AskUserQuestion with no questions',
        tool: 'AskUserQuestion',
        input: { questions: [] },
      },
      {
        name: 'AskUserQuestion with questions a string',
        tool: 'AskUserQuestion',
        input: { questions: 'A?' },
      },
      {
        name: 'AskUserQuestion with a non-string question',
        tool: 'AskUserQuestion',
        input: { questions: [{ question: 3 }] },
      },
      {
        name: 'AskUserQuestion with a null question entry',
        tool: 'AskUserQuestion',
        input: { questions: [null] },
      },
    ])('$name → no summary, no throw', ({ tool, input }) => {
      const fields: Record<string, unknown> = { tool_name: tool, tool_use_id: 'toolu_n' };
      if (input !== undefined) fields.tool_input = input;
      const event = single(hook('PostToolUse', fields));
      expect(event.kind).toBe('tool.finished');
      expect(event.tool?.name).toBe(tool);
      expect(event.tool?.summary).toBeUndefined();
    });

    it.each([
      { name: 'newlines', command: 'npm test\n  && echo done', expected: 'npm test && echo done' },
      { name: 'CRLF and tabs', command: 'a\r\n\t\tb', expected: 'a b' },
    ])('is one line: $name collapse to one space', ({ command, expected }) => {
      const event = single(
        hook('PreToolUse', { tool_name: 'Bash', tool_input: { command }, tool_use_id: 't' }),
      );
      expect(event.tool?.summary).toBe(expected);
    });

    it('a 120-character summary is kept whole', () => {
      const command = 'c'.repeat(120);
      const event = single(
        hook('PreToolUse', { tool_name: 'Bash', tool_input: { command }, tool_use_id: 't' }),
      );
      expect(event.tool?.summary).toBe(command);
    });

    it.each([121, 156, 4_000])('a %i-character source is cut to at most 120, ending in …', (n) => {
      const command = '0123456789'.repeat(Math.ceil(n / 10)).slice(0, n);
      const event = single(
        hook('PreToolUse', { tool_name: 'Bash', tool_input: { command }, tool_use_id: 't' }),
      );
      const summary = event.tool?.summary ?? '';
      expect(summary.length).toBeLessThanOrEqual(120);
      expect(summary.length).toBeGreaterThanOrEqual(110);
      expect(summary.endsWith('…')).toBe(true);
      expect(command.startsWith(summary.slice(0, -1))).toBe(true);
    });

    it('the recorded 156-character subagent command is cut (subagent.jsonl line 5)', () => {
      const event = single(fixtureLine('subagent', 5));
      const summary = event.tool?.summary ?? '';
      expect(summary.length).toBeLessThanOrEqual(120);
      expect(summary.endsWith('…')).toBe(true);
      expect(summary.startsWith('git ls-files && echo ---UNTRACKED---')).toBe(true);
    });

    it.each([
      {
        name: 'Read (read-edit line 1)',
        fixture: 'read-edit',
        line: 1,
        summary: 'C:\\Users\\user\\projects\\sample-repo\\src\\math.js',
      },
      {
        name: 'Agent (subagent line 1)',
        fixture: 'subagent',
        line: 1,
        summary: 'List and describe repo files',
      },
      {
        name: 'Bash (ctrl-c line 1)',
        fixture: 'ctrl-c',
        line: 1,
        summary: 'git ls-files && echo --- && ls -la && git log --stat',
      },
      {
        name: 'AskUserQuestion (ask-user-question line 3)',
        fixture: 'ask-user-question',
        line: 3,
        summary: 'Do you prefer option A or option B?',
      },
    ])('recorded summary: $name', ({ fixture, line, summary }) => {
      expect(single(fixtureLine(fixture, line)).tool?.summary).toBe(summary);
    });
  });

  describe('PermissionRequest', () => {
    it('Write (permission-prompt line 2) → attention.permission with tool name and category, no useId', () => {
      const event = single(fixtureLine('permission-prompt', 2));
      expect(event.kind).toBe('attention.permission');
      expect(event.agentId).toBe(ROOT);
      expect(event.tool).toMatchObject({ name: 'Write', category: 'write' });
      expect(event.tool).not.toHaveProperty('useId');
    });

    it('AskUserQuestion (ask-user-question line 2) → attention.question (finding 5)', () => {
      const event = single(fixtureLine('ask-user-question', 2));
      expect(event.kind).toBe('attention.question');
    });

    it.each([
      { tool: 'Bash', category: 'exec' },
      { tool: 'WebFetch', category: 'web' },
      { tool: 'mcp__db__query', category: 'other' },
    ] as const)('$tool → attention.permission, category $category', ({ tool, category }) => {
      const event = single(
        hook('PermissionRequest', { tool_name: tool, tool_input: {}, permission_suggestions: [] }),
      );
      expect(event.kind).toBe('attention.permission');
      expect(event.tool).toMatchObject({ name: tool, category });
      expect(event.tool).not.toHaveProperty('useId');
    });
  });

  describe('Notification', () => {
    it('idle_prompt (compaction line 10) → attention.idle with the message as text', () => {
      const event = single(fixtureLine('compaction', 10));
      expect(event.kind).toBe('attention.idle');
      expect(event.agentId).toBe(ROOT);
      expect(event.text).toBe('Claude is waiting for your input');
    });

    it('elicitation_dialog → attention.question with the message as text', () => {
      const event = single(
        hook('Notification', { notification_type: 'elicitation_dialog', message: 'Pick one' }),
      );
      expect(event.kind).toBe('attention.question');
      expect(event.text).toBe('Pick one');
    });

    it('a non-string message → no text', () => {
      const event = single(hook('Notification', { notification_type: 'idle_prompt', message: 5 }));
      expect(event.kind).toBe('attention.idle');
      expect(event.text).toBeUndefined();
    });

    it.each([
      { name: 'permission_prompt', type: 'permission_prompt' },
      { name: 'auth_success', type: 'auth_success' },
      { name: 'an unheard-of type', type: 'something_new' },
      { name: 'a missing type', type: undefined },
      { name: 'a numeric type', type: 3 },
    ])('$name → unknown with raw', ({ type }) => {
      const fields: Record<string, unknown> = { message: 'Claude needs your permission' };
      if (type !== undefined) fields.notification_type = type;
      const payload = hook('Notification', fields);
      const event = single(payload);
      expect(event.kind).toBe('unknown');
      expect(event.raw).toEqual(withoutTranscripts(payload));
    });
  });

  describe('subagents', () => {
    it('SubagentStart (subagent line 2) → agent.spawned for the subagent, parent the root', () => {
      const event = single(fixtureLine('subagent', 2));
      expect(event.kind).toBe('agent.spawned');
      expect(event.agentId).toBe('a0000000000000001');
      expect(event.parentAgentId).toBe(ROOT);
    });

    it('SubagentStop (subagent line 14) → agent.finished for the subagent', () => {
      const event = single(fixtureLine('subagent', 14));
      expect(event.kind).toBe('agent.finished');
      expect(event.agentId).toBe('a0000000000000001');
      expect(event.parentAgentId).toBe(ROOT);
    });

    it('SubagentStop from a never-started agent (empty agent_type) is still agent.finished', () => {
      const event = single(fixtureLine('subagent', 6));
      expect(event.kind).toBe('agent.finished');
      expect(event.agentId).toBe('a0000000000000002');
      expect(event.parentAgentId).toBe(ROOT);
    });

    it("a subagent's tool event (subagent line 5) belongs to the subagent", () => {
      const event = single(fixtureLine('subagent', 5));
      expect(event.kind).toBe('tool.started');
      expect(event.agentId).toBe('a0000000000000001');
      expect(event.parentAgentId).toBe(ROOT);
      expect(event.tool).toMatchObject({ name: 'Bash', category: 'exec', useId: 'toolu_000002' });
    });
  });

  describe('StopFailure → turn.failed with errorClass', () => {
    it.each([
      { errorType: 'rate_limit', errorClass: 'rate_limit' },
      { errorType: 'overloaded', errorClass: 'rate_limit' },
      { errorType: 'authentication_failed', errorClass: 'auth' },
      { errorType: 'oauth_org_not_allowed', errorClass: 'auth' },
      { errorType: 'cloud_credential_error', errorClass: 'auth' },
      { errorType: 'billing_error', errorClass: 'budget' },
      { errorType: 'account_on_hold', errorClass: 'budget' },
      { errorType: 'invalid_request', errorClass: 'other' },
      { errorType: 'model_not_found', errorClass: 'other' },
      { errorType: 'server_error', errorClass: 'other' },
      { errorType: 'max_output_tokens', errorClass: 'other' },
      { errorType: 'unknown', errorClass: 'other' },
      { errorType: 'a_brand_new_error', errorClass: 'other' },
      { errorType: 42, errorClass: 'other' },
      { errorType: undefined, errorClass: 'other' },
    ] as const)('error_type $errorType → $errorClass', ({ errorType, errorClass }) => {
      const fields: Record<string, unknown> = {};
      if (errorType !== undefined) fields.error_type = errorType;
      const event = single(hook('StopFailure', fields));
      expect(event.kind).toBe('turn.failed');
      expect(event.agentId).toBe(ROOT);
      expect(event.errorClass).toBe(errorClass);
    });

    it('only StopFailure sets errorClass: no other fixture event carries one', () => {
      for (const payload of allClaudeHookLines()) {
        for (const event of normalize(payload)) expect(event).not.toHaveProperty('errorClass');
      }
    });
  });

  describe('unknown input (hard rule 7)', () => {
    it.each([
      { name: 'an unheard-of hook', payload: hook('PostToolBatch', { tools: [] }) },
      { name: 'a lower-case hook name', payload: hook('stop') },
      { name: 'a numeric hook name', payload: hook(42) },
      {
        name: 'a missing hook name',
        payload: { session_id: 'x', cwd: 'y', transcript_path: 'C:\\t.jsonl' },
      },
      { name: 'an empty object', payload: {} },
    ])('$name → one unknown event with raw (without transcripts)', ({ payload }) => {
      const event = single(payload);
      expect(event.kind).toBe('unknown');
      expect(event.agentId).toBe(ROOT);
      expect(event.raw).toEqual(withoutTranscripts(payload));
      expect(event.raw).not.toHaveProperty('transcript_path');
    });

    it.each([
      { name: 'a string', payload: 'PreToolUse' },
      { name: 'a number', payload: 7 },
      { name: 'an array', payload: [{ hook_event_name: 'Stop' }] },
      { name: 'true', payload: true },
    ])('a non-object payload ($name) → one unknown event keeping it as raw', ({ payload }) => {
      const event = single(payload);
      expect(event.kind).toBe('unknown');
      expect(event.raw).toEqual(payload);
    });

    it.each([
      { name: 'null', payload: null },
      { name: 'undefined', payload: undefined },
    ])('$name → one unknown event, no throw', ({ payload }) => {
      const event = single(payload);
      expect(event.kind).toBe('unknown');
      expect(event.agentId).toBe(ROOT);
    });
  });
});

describeConformance('claude', () => claudeAdapter, { fixtures: allClaudeHookLines() });
