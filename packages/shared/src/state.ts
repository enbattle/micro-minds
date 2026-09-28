// Derived state (PLAN §4.2): what reduce() produces and what a WS snapshot carries.
import { z } from 'zod';
import {
  TOOL_CATEGORIES,
  type ToolCategory,
  type UsageTotals,
  usageTotalsSchema,
} from './events.ts';
import { PROVIDERS, type Provider } from './provider.ts';

export const ACTIVITIES = [
  'starting',
  'idle',
  'thinking',
  'reading',
  'writing',
  'running',
  'delegating',
  'waiting_permission',
  'waiting_input',
  'done',
  'offline',
] as const;
export type Activity = (typeof ACTIVITIES)[number];

export const ATTENTIONS = ['permission', 'question', 'idle'] as const;
export type Attention = (typeof ATTENTIONS)[number];

export const HEALTHS = ['ok', 'notice', 'warning', 'error'] as const;
export type Health = (typeof HEALTHS)[number];

export interface AgentUsage {
  total: UsageTotals;
  byModel: Record<string, UsageTotals>;
}

export interface AgentState {
  agentId: string;
  sessionId: string;
  parentAgentId?: string;
  provider: Provider;
  name: string;
  label?: string;
  activity: Activity;
  /** A separate channel from health; absent when nothing is asked of the user. */
  attention?: Attention;
  health: Health;
  /** "3 tool failures in 5m", "no events for 12m", "rate limited". */
  healthReason?: string;
  /** `limited` = terminal-only fallback (PLAN §5.4). */
  telemetry: 'full' | 'limited';
  /** ms epoch of the agent's last event; clock.tick and usage.recorded don't count. */
  lastEventAt: number;
  currentTool?: { name: string; category: ToolCategory; summary?: string };
  /** Tool failures still inside the failure window, for the rolling count. */
  failureTimes: number[];
  /** The latest tool failure, for recovery; cleared on recovery and on turn.finished. */
  lastFailureAt?: number;
  /** The latest tool result, for "the same tool failing twice in a row". */
  lastToolResult?: { name: string; failed: boolean };
  /** The same tool failed twice in a row since the last recovery. */
  repeatedFailure: boolean;
  /** Set on clock.tick while working and quiet for longer than the stuck threshold. */
  stuck: boolean;
  /** Why the agent is in error, if it is. */
  error?: string;
  /** When the error was set; a live agent recovers `recoveryAfterMs` later (PLAN §6). */
  errorAt?: number;
  children: string[];
  /** The root agent's usage is the whole session's (D30); absent until a delta arrives. */
  usage?: AgentUsage;
}

export interface WorldState {
  agents: Record<string, AgentState>;
}

const agentStateSchema = z.object({
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  parentAgentId: z.string().min(1).optional(),
  provider: z.enum(PROVIDERS),
  name: z.string(),
  label: z.string().optional(),
  activity: z.enum(ACTIVITIES),
  attention: z.enum(ATTENTIONS).optional(),
  health: z.enum(HEALTHS),
  healthReason: z.string().optional(),
  telemetry: z.enum(['full', 'limited']),
  lastEventAt: z.number(),
  currentTool: z
    .object({
      name: z.string(),
      category: z.enum(TOOL_CATEGORIES),
      summary: z.string().optional(),
    })
    .optional(),
  failureTimes: z.array(z.number()),
  lastFailureAt: z.number().optional(),
  lastToolResult: z.object({ name: z.string(), failed: z.boolean() }).optional(),
  repeatedFailure: z.boolean(),
  stuck: z.boolean(),
  error: z.string().optional(),
  errorAt: z.number().optional(),
  children: z.array(z.string()),
  usage: z
    .object({ total: usageTotalsSchema, byModel: z.record(z.string(), usageTotalsSchema) })
    .optional(),
});

export const worldStateSchema = z.object({
  agents: z.record(z.string(), agentStateSchema),
});
