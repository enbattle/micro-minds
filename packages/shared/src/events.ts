// The normalized event (PLAN §4.1) and its versioned schema. Pure: no I/O, no clock.
import { z } from 'zod';
import { PROVIDERS, type Provider } from './provider.ts';

/** The cross-provider tool contract: adapters map their own tool names onto these (PLAN §4.1). */
export const TOOL_CATEGORIES = [
  'read',
  'write',
  'exec',
  'delegate',
  'ask',
  'web',
  'other',
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const EVENT_KINDS = [
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
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const ERROR_CLASSES = ['rate_limit', 'auth', 'budget', 'other'] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/**
 * The schema version stored events carry (`v`). Bump it with a migration when the shape changes;
 * a parser meeting any other version says so explicitly rather than guessing.
 */
export const EVENT_SCHEMA_VERSION = 1 as const;

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** API-equivalent, as reported by the CLI; never computed here (PLAN §5.7). */
  costUsd: number;
}

export interface UsageDelta extends UsageTotals {
  /** The model id reported by the CLI. */
  model: string;
  source: 'otel' | 'statusline';
}

export interface EventTool {
  name: string;
  category: ToolCategory;
  useId?: string;
  summary?: string;
}

export interface AgentEvent {
  v: typeof EVENT_SCHEMA_VERSION;
  /** ULID. */
  id: string;
  /** ms epoch, stamped by the server on receipt. */
  ts: number;
  /** Our session id (a ULID). */
  sessionId: string;
  provider: Provider;
  /** Equals `sessionId` for the root agent; the provider's subagent id otherwise. */
  agentId: string;
  parentAgentId?: string;
  kind: EventKind;
  tool?: EventTool;
  /** Short, scrubbed, human-readable line for the board. */
  text?: string;
  /** Set by the adapter from payload facts. */
  errorClass?: ErrorClass;
  /** Only on usage.recorded. */
  usage?: UsageDelta;
  /** Bounded and redacted (D14); stripped from WS frames by default. */
  raw?: unknown;
}

/** An explicit parse result: parsers never throw. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'invalid' | 'unsupported_version' };

/** Crockford base32, 26 characters. */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const ulidSchema = z.string().regex(ULID_PATTERN);

const count = z.number().int().nonnegative();

export const usageTotalsSchema = z.object({
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  costUsd: z.number().nonnegative().finite(),
});

const usageDeltaSchema = usageTotalsSchema.extend({
  model: z.string().min(1),
  source: z.enum(['otel', 'statusline']),
});

const toolSchema = z.object({
  name: z.string().min(1),
  category: z.enum(TOOL_CATEGORIES),
  useId: z.string().optional(),
  summary: z.string().optional(),
});

const agentEventSchema = z.object({
  v: z.literal(EVENT_SCHEMA_VERSION),
  id: ulidSchema,
  ts: count,
  sessionId: ulidSchema,
  provider: z.enum(PROVIDERS),
  agentId: z.string().min(1),
  parentAgentId: z.string().min(1).optional(),
  kind: z.enum(EVENT_KINDS),
  tool: toolSchema.optional(),
  text: z.string().optional(),
  errorClass: z.enum(ERROR_CLASSES).optional(),
  usage: usageDeltaSchema.optional(),
  raw: z.unknown().optional(),
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drops keys whose value is `undefined`, so parsed values fit `exactOptionalPropertyTypes`. */
export function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, k === 'raw' ? v : withoutUndefined(v)]),
  ) as T;
}

/**
 * The version gate every versioned parser uses first: a missing or non-numeric `v` is invalid,
 * any number but `current` is unsupported, whatever the rest of the shape is.
 */
export function checkVersion(
  input: Record<string, unknown>,
  current: number,
): 'ok' | 'invalid' | 'unsupported_version' {
  const v = input.v;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'invalid';
  return v === current ? 'ok' : 'unsupported_version';
}

/**
 * Parses an AgentEvent from untrusted input (the store, the wire, a fixture). An unknown `kind`
 * becomes `kind: 'unknown'` with the original input kept as `raw` (hard rule 7).
 */
export function parseAgentEvent(input: unknown): ParseResult<AgentEvent> {
  if (!isRecord(input)) return { ok: false, reason: 'invalid' };
  const version = checkVersion(input, EVENT_SCHEMA_VERSION);
  if (version !== 'ok') return { ok: false, reason: version };
  const kind = input.kind;
  if (typeof kind !== 'string') return { ok: false, reason: 'invalid' };
  const known = (EVENT_KINDS as readonly string[]).includes(kind);
  const candidate = known ? input : { ...input, kind: 'unknown', raw: input };
  const parsed = agentEventSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  return { ok: true, value: withoutUndefined(parsed.data) as AgentEvent };
}
