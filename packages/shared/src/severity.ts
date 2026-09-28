// Health is derived here and only here (hard rule 6, PLAN §6): from an agent's failure history,
// its staleness and its errors, with every threshold taken from the Thresholds passed in. Pure.
import type { ErrorClass, EventTool } from './events.ts';
import type { AgentState, Health } from './state.ts';
import type { Thresholds } from './thresholds.ts';

const MINUTE = 60_000;

/** Error classes that make an agent unable to continue on its own (PLAN §6). */
const BLOCKING_ERROR_CLASSES: ReadonlySet<ErrorClass> = new Set(['rate_limit', 'auth', 'budget']);

const ERROR_REASONS: Record<ErrorClass, string> = {
  rate_limit: 'rate limited',
  auth: 'authentication failed',
  budget: 'budget or plan limit reached',
  other: 'turn failed',
};

export function isBlockingError(errorClass: ErrorClass | undefined): boolean {
  return errorClass !== undefined && BLOCKING_ERROR_CLASSES.has(errorClass);
}

export function errorReason(errorClass: ErrorClass | undefined, fallback: string): string {
  return errorClass === undefined || errorClass === 'other' ? fallback : ERROR_REASONS[errorClass];
}

/** Activities in which a long silence means the agent may be stuck. */
const WORKING = new Set(['thinking', 'running', 'delegating']);

/**
 * PLAN §6: health goes back to ok once `recoveryAfterMs` has passed without a new failure. That
 * clears the tool-failure history and a live agent's error (a rate limit or an overload is
 * transient); an offline agent's error (a crash) stays, since its session is gone.
 */
export function recover(agent: AgentState, now: number, cfg: Thresholds): AgentState {
  let next = agent;
  if (next.lastFailureAt !== undefined && now - next.lastFailureAt >= cfg.recoveryAfterMs) {
    next = clearFailures(next);
  }
  if (
    next.error !== undefined &&
    next.errorAt !== undefined &&
    next.activity !== 'offline' &&
    now - next.errorAt >= cfg.recoveryAfterMs
  ) {
    const { error: _error, errorAt: _errorAt, ...rest } = next;
    next = rest;
  }
  return next;
}

/** Forgets the tool-failure history (recovery, turn.finished, a new session). */
export function clearFailures(agent: AgentState): AgentState {
  const { lastFailureAt: _dropped, ...rest } = agent;
  return { ...rest, failureTimes: [], repeatedFailure: false };
}

/**
 * Failures not yet older than the window. No upper bound: a tick stamped before a failure (the
 * server clock stepped back after NTP or sleep/wake) must not erase it.
 */
function inWindow(times: readonly number[], now: number, cfg: Thresholds): number[] {
  return times.filter((t) => t >= now - cfg.failureWindowMs);
}

/** Records a tool result: a failure joins the rolling window and may repeat the previous one. */
export function recordToolResult(
  agent: AgentState,
  tool: EventTool | undefined,
  failed: boolean,
  now: number,
  cfg: Thresholds,
): AgentState {
  const name = tool?.name;
  const result = name === undefined ? agent.lastToolResult : { name, failed };
  if (!failed) {
    return result === undefined ? agent : { ...agent, lastToolResult: result };
  }
  const previous = agent.lastToolResult;
  const repeated = name !== undefined && previous?.failed === true && previous.name === name;
  return {
    ...agent,
    ...(result === undefined ? {} : { lastToolResult: result }),
    failureTimes: [...inWindow(agent.failureTimes, now, cfg), now],
    lastFailureAt: now,
    repeatedFailure: agent.repeatedFailure || repeated,
  };
}

/** Evaluates staleness on clock.tick: working and quiet for longer than `stuckAfterMs`. */
export function evaluateStuck(agent: AgentState, now: number, cfg: Thresholds): AgentState {
  const stuck = WORKING.has(agent.activity) && now - agent.lastEventAt > cfg.stuckAfterMs;
  return stuck === agent.stuck ? agent : { ...agent, stuck };
}

/** Sets `health` and `healthReason` from the agent's facts; error outranks warning outranks notice. */
export function deriveHealth(agent: AgentState, now: number, cfg: Thresholds): AgentState {
  const failureTimes = inWindow(agent.failureTimes, now, cfg);
  const failures = failureTimes.length;
  let health: Health = 'ok';
  let reason: string | undefined;
  if (agent.error !== undefined) {
    health = 'error';
    reason = agent.error;
  } else if (agent.stuck) {
    health = 'warning';
    reason = `no events for ${Math.floor((now - agent.lastEventAt) / MINUTE)}m`;
  } else if (agent.lastFailureAt !== undefined) {
    if (failures >= cfg.failuresForWarning) {
      health = 'warning';
      reason = `${failures} tool failures in ${Math.round(cfg.failureWindowMs / MINUTE)}m`;
    } else if (agent.repeatedFailure) {
      health = 'warning';
      reason = `${agent.lastToolResult?.name ?? 'a tool'} failed twice in a row`;
    } else {
      health = 'notice';
      reason = `${agent.lastToolResult?.name ?? 'a tool'} failed`;
    }
  }
  const { healthReason: _old, ...rest } = agent;
  return {
    ...rest,
    failureTimes,
    health,
    ...(reason === undefined ? {} : { healthReason: reason }),
  };
}
