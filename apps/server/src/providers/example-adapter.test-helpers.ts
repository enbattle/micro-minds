// Task 2.3, clause C4: a small, correct example adapter for the conformance suite's own tests,
// and a helper to derive variants (broken ones, other ids, other binaries) from it. Test data,
// not a provider: the real fake provider arrives in task 2.4.
//
// Its made-up payload shape: { event: <an EventKind>, tool?, useId?, summary?, text?, agent? }.
// `agent` names a subagent (parent: the root agent); anything else becomes `unknown` with raw.
import path from 'node:path';
import type { AgentEvent, EventKind, ToolCategory } from '@micro-minds/shared';
import { EVENT_SCHEMA_VERSION } from '@micro-minds/shared';
import type { LaunchContext, LaunchSpec, NormalizeContext, ProviderAdapter } from './types.ts';

export const EXAMPLE_TOOL_CATEGORIES: Readonly<Record<string, ToolCategory>> = {
  Read: 'read',
  Write: 'write',
  Bash: 'exec',
};

const TOOL_KINDS: readonly EventKind[] = ['tool.started', 'tool.finished', 'tool.failed'];
const PLAIN_KINDS: readonly EventKind[] = [
  'session.started',
  'prompt.submitted',
  'turn.finished',
  'attention.idle',
  'agent.spawned',
  'agent.finished',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function base(kind: EventKind, ctx: NormalizeContext): AgentEvent {
  return {
    v: EVENT_SCHEMA_VERSION,
    id: ctx.newId(),
    ts: ctx.receivedAt,
    sessionId: ctx.sessionId,
    provider: 'fake',
    agentId: ctx.sessionId,
    kind,
  };
}

function unknownEvent(raw: unknown, ctx: NormalizeContext): AgentEvent {
  const event = base('unknown', ctx);
  return raw === undefined ? event : { ...event, raw };
}

function exampleNormalize(raw: unknown, ctx: NormalizeContext): AgentEvent[] {
  if (!isRecord(raw)) return [unknownEvent(raw, ctx)];
  const name = raw.event;
  const toolKind = TOOL_KINDS.find((k) => k === name);
  const plainKind = PLAIN_KINDS.find((k) => k === name);
  const agent = nonEmpty(raw.agent);
  const text = nonEmpty(raw.text);
  let event: AgentEvent;
  if (toolKind !== undefined) {
    const toolName = nonEmpty(raw.tool);
    if (toolName === undefined) return [unknownEvent(raw, ctx)];
    const category = Object.hasOwn(EXAMPLE_TOOL_CATEGORIES, toolName)
      ? (EXAMPLE_TOOL_CATEGORIES[toolName] ?? 'other')
      : 'other';
    const useId = nonEmpty(raw.useId);
    const summary = nonEmpty(raw.summary);
    event = {
      ...base(toolKind, ctx),
      tool: {
        name: toolName,
        category,
        ...(useId === undefined ? {} : { useId }),
        ...(summary === undefined ? {} : { summary }),
      },
    };
  } else if (plainKind !== undefined) {
    event = base(plainKind, ctx);
  } else {
    return [unknownEvent(raw, ctx)];
  }
  return [
    {
      ...event,
      ...(agent === undefined ? {} : { agentId: agent, parentAgentId: ctx.sessionId }),
      ...(text === undefined ? {} : { text }),
    },
  ];
}

function exampleLaunch(ctx: LaunchContext): LaunchSpec {
  const settings = {
    hooks: {
      url: `${ctx.serverUrl}/hooks`,
      headers: { Authorization: 'Bearer $MICROMINDS_HOOK_TOKEN' },
    },
  };
  return {
    args: [
      '--settings',
      path.join(ctx.sessionDir, 'settings.json'),
      ...(ctx.firstPrompt === undefined ? [] : ['--', ctx.firstPrompt]),
    ],
    env: {
      MICROMINDS_URL: ctx.serverUrl,
      MICROMINDS_SESSION_ID: ctx.sessionId,
      MICROMINDS_HOOK_TOKEN: ctx.hookToken,
      MICROMINDS_PROVIDER: 'fake',
    },
    files: [{ name: 'settings.json', content: JSON.stringify(settings) }],
  };
}

/** A correct adapter: provider 'fake', three tools mapped, hooks 'http'. */
export function exampleAdapter(): ProviderAdapter {
  return {
    id: 'fake',
    binary: { command: 'micro-minds-fake', versionArgs: ['--version'] },
    hooks: 'http',
    toolCategories: EXAMPLE_TOOL_CATEGORIES,
    launch: exampleLaunch,
    normalize: exampleNormalize,
  };
}

/** A copy of an adapter with some members replaced. */
export function withOverrides(
  adapter: ProviderAdapter,
  overrides: Partial<ProviderAdapter>,
): ProviderAdapter {
  return { ...adapter, ...overrides };
}

/** Raw payloads in the example adapter's shape, used as its conformance fixtures. */
export const EXAMPLE_FIXTURES: readonly unknown[] = [
  { event: 'session.started' },
  { event: 'prompt.submitted', text: 'add a greeting' },
  { event: 'tool.started', tool: 'Read', useId: 'tu_1', summary: 'src/greet.ts' },
  { event: 'tool.finished', tool: 'Read', useId: 'tu_1' },
  { event: 'tool.failed', tool: 'Bash', useId: 'tu_2', summary: 'npm test' },
  { event: 'tool.started', tool: 'Mystery', useId: 'tu_3' },
  { event: 'agent.spawned', agent: 'sub-1', text: 'Explore' },
  { event: 'tool.started', tool: 'Write', agent: 'sub-1', useId: 'tu_4' },
  { event: 'agent.finished', agent: 'sub-1' },
  { event: 'turn.finished' },
  { event: 'fake.unheard_of', detail: 'kept as raw' },
];
