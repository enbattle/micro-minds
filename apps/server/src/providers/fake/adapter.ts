// The fake provider (D10): a stand-in CLI for tests and CI, never a real provider. Its CLI
// (cli.ts, run as `node cli.ts`) replays a scenario from fixtures/fake/ to /hooks and echoes
// its input. Its payloads are its own, one JSON object per event:
//
//   { event: <EventKind>, tool?, useId?, summary?, text?, agent?, errorClass? }
//
// `agent` names a subagent (its parent is the root agent). `clock.tick` (time comes from the
// server, D15), `session.started` (it comes from the PTY spawn) and anything unrecognized become
// kind `unknown` with the payload kept as raw.
import path from 'node:path';
import {
  type AgentEvent,
  ERROR_CLASSES,
  type ErrorClass,
  EVENT_KINDS,
  EVENT_SCHEMA_VERSION,
  type EventKind,
  type EventTool,
  type ToolCategory,
} from '@micro-minds/shared';
import { isRecord, nonEmpty } from '../text.ts';
import type { LaunchContext, LaunchSpec, NormalizeContext, ProviderAdapter } from '../types.ts';

const TOOL_CATEGORIES: Readonly<Record<string, ToolCategory>> = {
  Read: 'read',
  Write: 'write',
  Bash: 'exec',
  Agent: 'delegate',
  AskUserQuestion: 'ask',
};

/** The fake CLI, run with `node` (a native executable, so no `.cmd` shim is involved). */
const CLI_PATH = path.join(import.meta.dirname, 'cli.ts');

const TOOL_KINDS = new Set<EventKind>(['tool.started', 'tool.finished', 'tool.failed']);
const NOT_FROM_PROVIDER = new Set<EventKind>(['clock.tick', 'session.started', 'unknown']);

function launch(ctx: LaunchContext): LaunchSpec {
  return {
    args: [CLI_PATH, ...(ctx.firstPrompt === undefined ? [] : ['--', ctx.firstPrompt])],
    env: {
      MICROMINDS_URL: ctx.serverUrl,
      MICROMINDS_SESSION_ID: ctx.sessionId,
      MICROMINDS_HOOK_TOKEN: ctx.hookToken,
      MICROMINDS_PROVIDER: 'fake',
    },
    files: [],
  };
}

function eventKind(value: unknown): EventKind | undefined {
  const kind = EVENT_KINDS.find((k) => k === value);
  return kind === undefined || NOT_FROM_PROVIDER.has(kind) ? undefined : kind;
}

function errorClassOf(value: unknown): ErrorClass | undefined {
  return ERROR_CLASSES.find((c) => c === value);
}

function toolOf(payload: Record<string, unknown>): EventTool | undefined {
  const name = nonEmpty(payload.tool);
  if (name === undefined) return undefined;
  const useId = nonEmpty(payload.useId);
  const summary = nonEmpty(payload.summary);
  return {
    name,
    category: Object.hasOwn(TOOL_CATEGORIES, name) ? (TOOL_CATEGORIES[name] ?? 'other') : 'other',
    ...(useId === undefined ? {} : { useId }),
    ...(summary === undefined ? {} : { summary }),
  };
}

function normalize(raw: unknown, ctx: NormalizeContext): AgentEvent[] {
  const base: AgentEvent = {
    v: EVENT_SCHEMA_VERSION,
    id: ctx.newId(),
    ts: ctx.receivedAt,
    sessionId: ctx.sessionId,
    provider: 'fake',
    agentId: ctx.sessionId,
    kind: 'unknown',
  };
  const unknown = (): AgentEvent[] => [raw === undefined ? base : { ...base, raw }];
  if (!isRecord(raw)) return unknown();
  const kind = eventKind(raw.event);
  if (kind === undefined) return unknown();
  const tool = toolOf(raw);
  if (TOOL_KINDS.has(kind) && tool === undefined) return unknown();
  const agent = nonEmpty(raw.agent);
  const text = nonEmpty(raw.text);
  const errorClass = errorClassOf(raw.errorClass);
  return [
    {
      ...base,
      kind,
      ...(agent === undefined ? {} : { agentId: agent, parentAgentId: ctx.sessionId }),
      ...(TOOL_KINDS.has(kind) && tool !== undefined ? { tool } : {}),
      ...(text === undefined ? {} : { text }),
      ...(errorClass === undefined ? {} : { errorClass }),
    },
  ];
}

export const fakeAdapter: ProviderAdapter = {
  id: 'fake',
  binary: { command: 'node', versionArgs: ['--version'] },
  hooks: 'http',
  toolCategories: TOOL_CATEGORIES,
  launch,
  normalize,
};
