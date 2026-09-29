// The WS protocol (PLAN §8): every frame carries the protocol version `v`, and both directions are
// validated with zod, discriminated on `t`. Parsers return an explicit result and never throw.
import { z } from 'zod';
import {
  type AgentEvent,
  checkVersion,
  isRecord,
  type ParseResult,
  parseAgentEvent,
  type UsageTotals,
  ulidSchema,
  usageTotalsSchema,
  withoutUndefined,
} from './events.ts';
import { PROVIDERS, type Provider } from './provider.ts';
import { type WorldState, worldStateSchema } from './state.ts';

/** The WS protocol version; a client on another version gets a clear "reload" error (task 2.8). */
export const PROTOCOL_VERSION = 1 as const;
type V = typeof PROTOCOL_VERSION;

export type ServerFrame =
  | { t: 'snapshot'; v: V; world: WorldState }
  | { t: 'event'; v: V; event: AgentEvent }
  | { t: 'pty.data'; v: V; sessionId: string; data: string }
  | { t: 'pty.exit'; v: V; sessionId: string; code: number }
  | { t: 'pty.snapshot'; v: V; sessionId: string; data: string }
  | { t: 'usage.summary'; v: V; today: UsageTotals }
  | { t: 'error'; v: V; code: string; message: string };

export type ClientFrame =
  | {
      t: 'session.create';
      v: V;
      provider: Provider;
      repoPath: string;
      name?: string;
      initialPrompt?: string;
    }
  | { t: 'session.stop'; v: V; sessionId: string }
  | { t: 'session.kill'; v: V; sessionId: string }
  | { t: 'session.resume'; v: V; sessionId: string }
  | { t: 'worktree.remove'; v: V; sessionId: string; confirm: true }
  | { t: 'app.quit'; v: V; confirm: true }
  | { t: 'pty.input'; v: V; sessionId: string; data: string }
  | { t: 'pty.resize'; v: V; sessionId: string; cols: number; rows: number };

const v = z.literal(PROTOCOL_VERSION);
const size = z.number().int().min(1).max(1000);

const serverFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('snapshot'), v, world: worldStateSchema }),
  // The event itself is checked with parseAgentEvent below (its own version and unknown kinds).
  z.object({ t: z.literal('event'), v, event: z.unknown() }),
  z.object({ t: z.literal('pty.data'), v, sessionId: ulidSchema, data: z.string() }),
  z.object({ t: z.literal('pty.exit'), v, sessionId: ulidSchema, code: z.number().int() }),
  z.object({ t: z.literal('pty.snapshot'), v, sessionId: ulidSchema, data: z.string() }),
  z.object({ t: z.literal('usage.summary'), v, today: usageTotalsSchema }),
  z.object({ t: z.literal('error'), v, code: z.string().min(1), message: z.string() }),
]);

const clientFrameSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('session.create'),
    v,
    provider: z.enum(PROVIDERS),
    repoPath: z.string().min(1),
    name: z.string().optional(),
    initialPrompt: z.string().optional(),
  }),
  z.object({ t: z.literal('session.stop'), v, sessionId: ulidSchema }),
  z.object({ t: z.literal('session.kill'), v, sessionId: ulidSchema }),
  z.object({ t: z.literal('session.resume'), v, sessionId: ulidSchema }),
  z.object({
    t: z.literal('worktree.remove'),
    v,
    sessionId: ulidSchema,
    confirm: z.literal(true),
  }),
  z.object({ t: z.literal('app.quit'), v, confirm: z.literal(true) }),
  z.object({ t: z.literal('pty.input'), v, sessionId: ulidSchema, data: z.string() }),
  z.object({ t: z.literal('pty.resize'), v, sessionId: ulidSchema, cols: size, rows: size }),
]);

function parseFrame<T>(input: unknown, schema: z.ZodType): ParseResult<T> {
  if (!isRecord(input)) return { ok: false, reason: 'invalid' };
  const version = checkVersion(input, PROTOCOL_VERSION);
  if (version !== 'ok') return { ok: false, reason: version };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  // An event frame's `event` is still unparsed here (z.unknown): take it from parseAgentEvent,
  // which only keeps schema fields, and never walk the untrusted value itself (it may nest deep
  // enough to overflow the stack).
  if (isRecord(parsed.data) && parsed.data.t === 'event') {
    const event = parseAgentEvent(parsed.data.event);
    return event.ok
      ? ({
          ok: true,
          value: { t: 'event', v: PROTOCOL_VERSION, event: event.value },
        } as ParseResult<T>)
      : { ok: false, reason: 'invalid' };
  }
  return { ok: true, value: withoutUndefined(parsed.data) as T };
}

export function parseServerFrame(input: unknown): ParseResult<ServerFrame> {
  return parseFrame<ServerFrame>(input, serverFrameSchema);
}

export function parseClientFrame(input: unknown): ParseResult<ClientFrame> {
  return parseFrame<ClientFrame>(input, clientFrameSchema);
}
