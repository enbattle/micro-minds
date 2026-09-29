// The Claude Code adapter (D10, PLAN §5.3). The mapping, the tool categories and the findings it
// handles are in docs/protocols/claude.md, recorded with Claude Code 2.1.283.
import path from 'node:path';
import {
  type AgentEvent,
  type ErrorClass,
  EVENT_SCHEMA_VERSION,
  type EventKind,
  type EventTool,
  type ToolCategory,
} from '@micro-minds/shared';
import { hookEndpoint } from '../hook-url.ts';
import { isRecord, nonEmpty, oneLine } from '../text.ts';
import type { LaunchContext, LaunchSpec, NormalizeContext, ProviderAdapter } from '../types.ts';

const TOOL_CATEGORIES: Readonly<Record<string, ToolCategory>> = {
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
};

/** Every hook we inject; `SessionStart` never arrives over HTTP (D29), but it costs nothing. */
const HOOK_EVENTS = [
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

const TOKEN_ENV = 'MICROMINDS_HOOK_TOKEN';
/** HTTP hooks block the tool until the reply (ADR 0029). */
const HOOK_TIMEOUT_SECONDS = 1;
const PROMPT_MAX = 200;
const SUMMARY_MAX = 120;

/** Payload keys never stored: they point into ~/.claude (hard rule 1). */
const TRANSCRIPT_KEYS = new Set(['transcript_path', 'agent_transcript_path']);

const ERROR_CLASSES: Readonly<Record<string, ErrorClass>> = {
  rate_limit: 'rate_limit',
  overloaded: 'rate_limit',
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  cloud_credential_error: 'auth',
  billing_error: 'budget',
  account_on_hold: 'budget',
};

function launch(ctx: LaunchContext): LaunchSpec {
  const hook = {
    type: 'http',
    url: hookEndpoint(ctx.serverUrl, ctx.sessionId),
    // The token stays in the PTY env; the CLI reads it from there (docs/protocols/claude.md).
    headers: { Authorization: `Bearer $${TOKEN_ENV}` },
    allowedEnvVars: [TOKEN_ENV],
    timeout: HOOK_TIMEOUT_SECONDS,
  };
  const hooks = Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [hook] }]]));
  return {
    args: [
      '--settings',
      path.join(ctx.sessionDir, 'settings.json'),
      ...(ctx.firstPrompt === undefined ? [] : ['--', ctx.firstPrompt]),
    ],
    env: {
      MICROMINDS_URL: ctx.serverUrl,
      MICROMINDS_SESSION_ID: ctx.sessionId,
      [TOKEN_ENV]: ctx.hookToken,
      MICROMINDS_PROVIDER: 'claude',
    },
    files: [{ name: 'settings.json', content: JSON.stringify({ hooks }, null, 2) }],
  };
}

function category(toolName: string): ToolCategory {
  return Object.hasOwn(TOOL_CATEGORIES, toolName)
    ? (TOOL_CATEGORIES[toolName] ?? 'other')
    : 'other';
}

/** The field of `tool_input` that says what a tool call does, per tool. */
function summarySource(toolName: string, input: Record<string, unknown>): unknown {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return input.command;
    case 'Read':
    case 'Edit':
    case 'Write':
      return input.file_path;
    case 'NotebookEdit':
      return nonEmpty(input.notebook_path) ?? input.file_path;
    case 'Glob':
    case 'Grep':
      return input.pattern;
    case 'Agent':
    case 'Task':
      return input.description;
    case 'WebFetch':
      return input.url;
    case 'WebSearch':
      return input.query;
    case 'AskUserQuestion': {
      const first: unknown = Array.isArray(input.questions) ? input.questions[0] : undefined;
      return isRecord(first) ? first.question : undefined;
    }
    default:
      return undefined;
  }
}

function toolSummary(toolName: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const source = nonEmpty(summarySource(toolName, input));
  return source === undefined ? undefined : oneLine(source, SUMMARY_MAX);
}

/** The tool of a tool payload; `withUseId` is false for `PermissionRequest`, which has none. */
function toolOf(payload: Record<string, unknown>, withUseId: boolean): EventTool | undefined {
  const name = nonEmpty(payload.tool_name);
  if (name === undefined) return undefined;
  const useId = withUseId ? nonEmpty(payload.tool_use_id) : undefined;
  const summary = toolSummary(name, payload.tool_input);
  return {
    name,
    category: category(name),
    ...(useId === undefined ? {} : { useId }),
    ...(summary === undefined ? {} : { summary }),
  };
}

interface Mapped {
  kind: EventKind;
  tool?: EventTool;
  text?: string;
  errorClass?: ErrorClass;
}

const TOOL_KINDS: Readonly<Record<string, EventKind>> = {
  PreToolUse: 'tool.started',
  PostToolUse: 'tool.finished',
  PostToolUseFailure: 'tool.failed',
};

const PLAIN_KINDS: Readonly<Record<string, EventKind>> = {
  SubagentStart: 'agent.spawned',
  SubagentStop: 'agent.finished',
  Stop: 'turn.finished',
  PreCompact: 'context.compacting',
  SessionEnd: 'session.ended',
};

/**
 * AskUserQuestion's dialog (its PreToolUse and its PermissionRequest, finding 5) raises a question:
 * the agent waits for the user, it isn't busy with a tool. The question itself becomes the text.
 */
function question(tool: EventTool): Mapped {
  return {
    kind: 'attention.question',
    ...(tool.summary === undefined ? {} : { text: tool.summary }),
  };
}

/** The event a hook payload maps to, `unknown` when it's none we know; `null` for SessionStart. */
function map(payload: Record<string, unknown>): Mapped | null {
  const hook = payload.hook_event_name;
  if (typeof hook !== 'string') return { kind: 'unknown' };
  if (hook === 'SessionStart') return null; // session.started comes from the PTY spawn (D29)
  if (Object.hasOwn(TOOL_KINDS, hook)) {
    const tool = toolOf(payload, true);
    if (tool === undefined) return { kind: 'unknown' };
    if (hook === 'PreToolUse' && tool.name === 'AskUserQuestion') return question(tool);
    return { kind: TOOL_KINDS[hook] ?? 'unknown', tool };
  }
  if (Object.hasOwn(PLAIN_KINDS, hook)) return { kind: PLAIN_KINDS[hook] ?? 'unknown' };
  switch (hook) {
    case 'UserPromptSubmit': {
      const prompt = nonEmpty(payload.prompt);
      return {
        kind: 'prompt.submitted',
        ...(prompt === undefined ? {} : { text: oneLine(prompt, PROMPT_MAX) }),
      };
    }
    case 'PermissionRequest': {
      const tool = toolOf(payload, false);
      if (tool?.name === 'AskUserQuestion') return question(tool);
      return { kind: 'attention.permission', ...(tool === undefined ? {} : { tool }) };
    }
    case 'Notification': {
      const kind =
        payload.notification_type === 'idle_prompt'
          ? 'attention.idle'
          : payload.notification_type === 'elicitation_dialog'
            ? 'attention.question'
            : undefined;
      // permission_prompt duplicates PermissionRequest; anything else is new to us (hard rule 7).
      if (kind === undefined) return { kind: 'unknown' };
      const message = nonEmpty(payload.message);
      return { kind, ...(message === undefined ? {} : { text: oneLine(message, PROMPT_MAX) }) };
    }
    case 'StopFailure': {
      const type = payload.error_type;
      const errorClass =
        typeof type === 'string' && Object.hasOwn(ERROR_CLASSES, type)
          ? (ERROR_CLASSES[type] ?? 'other')
          : 'other';
      return { kind: 'turn.failed', errorClass };
    }
    default:
      return { kind: 'unknown' };
  }
}

function withoutTranscripts(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !TRANSCRIPT_KEYS.has(key)));
}

function normalize(raw: unknown, ctx: NormalizeContext): AgentEvent[] {
  const payload = isRecord(raw) ? raw : undefined;
  const mapped = payload === undefined ? { kind: 'unknown' as const } : map(payload);
  if (mapped === null) return [];
  // An event with agent_id belongs to that subagent; without, to the root agent.
  const subagent = payload === undefined ? undefined : nonEmpty(payload.agent_id);
  const kept = payload === undefined ? raw : withoutTranscripts(payload);
  return [
    {
      v: EVENT_SCHEMA_VERSION,
      id: ctx.newId(),
      ts: ctx.receivedAt,
      sessionId: ctx.sessionId,
      provider: 'claude',
      agentId: subagent ?? ctx.sessionId,
      ...(subagent === undefined ? {} : { parentAgentId: ctx.sessionId }),
      kind: mapped.kind,
      ...(mapped.tool === undefined ? {} : { tool: mapped.tool }),
      ...(mapped.text === undefined ? {} : { text: mapped.text }),
      ...(mapped.errorClass === undefined ? {} : { errorClass: mapped.errorClass }),
      ...(kept === undefined ? {} : { raw: kept }),
    },
  ];
}

export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  binary: { command: 'claude', versionArgs: ['--version'] },
  hooks: 'http',
  toolCategories: TOOL_CATEGORIES,
  launch,
  normalize,
};
