// The pure world-state reducer (PLAN §4.2, §4.3). Time enters only through clock.tick events
// (D15): nothing here reads a clock or randomness, and inputs are never mutated.
import { type AgentEvent, parseAgentEvent, type ToolCategory, type UsageTotals } from './events.ts';
import {
  clearFailures,
  deriveHealth,
  errorReason,
  evaluateStuck,
  isBlockingError,
  recordToolResult,
  recover,
} from './severity.ts';
import type { Activity, AgentState, AgentUsage, WorldState } from './state.ts';
import type { Thresholds } from './thresholds.ts';

export function createWorld(): WorldState {
  return { agents: {} };
}

const ACTIVITY_BY_CATEGORY: Record<ToolCategory, Activity> = {
  read: 'reading',
  web: 'reading',
  write: 'writing',
  exec: 'running',
  delegate: 'delegating',
  // No §4.3 row: the question itself arrives as attention.question, and other tools (MCP, the
  // subagent handback) do no reading, writing or running we can name.
  ask: 'thinking',
  other: 'thinking',
};

const ZERO_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

function getAgent(world: WorldState, agentId: string): AgentState | undefined {
  return Object.hasOwn(world.agents, agentId) ? world.agents[agentId] : undefined;
}

/**
 * The agent an event targets: it must belong to the event's session. `sessionId` is stamped by the
 * server from the authenticated route (hard rule 4) while `agentId` comes from the provider's
 * payload, so an event naming another session's agent must never reach it.
 */
function sessionAgent(
  world: WorldState,
  event: AgentEvent,
  agentId: string,
): AgentState | undefined {
  const agent = getAgent(world, agentId);
  return agent?.sessionId === event.sessionId ? agent : undefined;
}

function withAgent(world: WorldState, agent: AgentState): WorldState {
  return { ...world, agents: { ...world.agents, [agent.agentId]: agent } };
}

function omit<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy: Partial<T> = { ...value };
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}

function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

function addUsage(usage: AgentUsage | undefined, event: AgentEvent): AgentUsage | undefined {
  const delta = event.usage;
  if (delta === undefined) return usage;
  const byModel = usage?.byModel ?? {};
  const model = Object.hasOwn(byModel, delta.model) ? byModel[delta.model] : undefined;
  return {
    total: addTotals(usage?.total ?? ZERO_USAGE, delta),
    byModel: { ...byModel, [delta.model]: addTotals(model ?? ZERO_USAGE, delta) },
  };
}

function newAgent(event: AgentEvent, name: string, parentAgentId?: string): AgentState {
  return {
    agentId: event.agentId,
    sessionId: event.sessionId,
    ...(parentAgentId === undefined ? {} : { parentAgentId }),
    provider: event.provider,
    name,
    activity: 'starting',
    health: 'ok',
    telemetry: 'full',
    lastEventAt: event.ts,
    failureTimes: [],
    repeatedFailure: false,
    stuck: false,
    children: [],
  };
}

/** session.started: creates the root agent, or restarts it (resume) keeping usage and children. */
function sessionStarted(world: WorldState, event: AgentEvent): WorldState {
  if (event.agentId !== event.sessionId) return world;
  const existing = sessionAgent(world, event, event.agentId);
  if (existing === undefined) return withAgent(world, newAgent(event, event.provider));
  const restarted = omit(
    clearFailures(existing),
    'attention',
    'error',
    'errorAt',
    'healthReason',
    'currentTool',
    'lastToolResult',
  );
  return withAgent(world, {
    ...restarted,
    activity: 'starting',
    health: 'ok',
    stuck: false,
    lastEventAt: event.ts,
  });
}

/** agent.spawned: a child of a known parent. Never re-creates or re-parents an existing agent. */
function agentSpawned(world: WorldState, event: AgentEvent): WorldState {
  const parentId = event.parentAgentId;
  if (parentId === undefined || getAgent(world, event.agentId) !== undefined) return world;
  const parent = sessionAgent(world, event, parentId);
  if (parent === undefined) return world;
  const child = newAgent(event, event.text ?? 'subagent', parentId);
  const children = parent.children.includes(child.agentId)
    ? parent.children
    : [...parent.children, child.agentId];
  return withAgent(withAgent(world, { ...parent, children }), child);
}

/** session.ended / session.crashed: every agent of the session goes offline (done stays done). */
function sessionOver(world: WorldState, event: AgentEvent, cfg: Thresholds): WorldState {
  const crashed = event.kind === 'session.crashed';
  const agents = Object.fromEntries(
    Object.entries(world.agents).map(([id, agent]): [string, AgentState] => {
      if (agent.sessionId !== event.sessionId) return [id, agent];
      const target = id === event.agentId;
      let next: AgentState = omit(agent, 'attention', 'currentTool');
      next = {
        ...next,
        activity: agent.activity === 'done' ? 'done' : 'offline',
        stuck: false,
        ...(target ? { lastEventAt: event.ts } : {}),
      };
      if (target && (crashed || isBlockingError(event.errorClass))) {
        next = {
          ...next,
          error: crashed ? 'crashed' : errorReason(event.errorClass, 'ended'),
          errorAt: event.ts,
        };
      }
      return [id, deriveHealth(next, event.ts, cfg)];
    }),
  );
  return { ...world, agents };
}

/** clock.tick: starting settles to idle, failures decay, and quiet working agents go stuck. */
function clockTick(world: WorldState, event: AgentEvent, cfg: Thresholds): WorldState {
  const now = event.ts;
  const agents = Object.fromEntries(
    Object.entries(world.agents).map(([id, agent]): [string, AgentState] => {
      let next: AgentState = agent.activity === 'starting' ? { ...agent, activity: 'idle' } : agent;
      next = evaluateStuck(recover(next, now, cfg), now, cfg);
      return [id, deriveHealth(next, now, cfg)];
    }),
  );
  return { ...world, agents };
}

/** Every other kind, for an agent that already exists. */
function agentEvent(agent: AgentState, event: AgentEvent, cfg: Thresholds): AgentState {
  const now = event.ts;
  let next: AgentState = recover({ ...agent, lastEventAt: now, stuck: false }, now, cfg);
  switch (event.kind) {
    case 'prompt.submitted':
      next = { ...omit(next, 'attention', 'currentTool'), activity: 'thinking' };
      break;
    case 'tool.started': {
      const tool = event.tool;
      next =
        tool === undefined
          ? { ...omit(next, 'currentTool'), activity: 'thinking' }
          : {
              ...next,
              activity: ACTIVITY_BY_CATEGORY[tool.category],
              currentTool: {
                name: tool.name,
                category: tool.category,
                ...(tool.summary === undefined ? {} : { summary: tool.summary }),
              },
            };
      break;
    }
    case 'tool.finished':
    case 'tool.failed': {
      const failed = event.kind === 'tool.failed';
      const cleared = next.attention === 'permission' ? omit(next, 'attention') : next;
      next = recordToolResult(
        { ...omit(cleared, 'currentTool'), activity: 'thinking' },
        event.tool,
        failed,
        now,
        cfg,
      );
      break;
    }
    case 'attention.permission':
      next = { ...next, activity: 'waiting_permission', attention: 'permission' };
      break;
    case 'attention.question':
      next = { ...next, activity: 'waiting_input', attention: 'question' };
      break;
    case 'attention.idle':
      next = { ...next, activity: 'waiting_input', attention: 'idle' };
      break;
    case 'turn.finished':
      // Resets health if the latest problem was a tool failure (PLAN §4.3); errors stay.
      next = { ...clearFailures(omit(next, 'currentTool')), activity: 'idle' };
      break;
    case 'turn.failed':
      next = {
        ...omit(next, 'currentTool'),
        activity: 'idle',
        error: errorReason(event.errorClass, 'turn failed'),
        errorAt: now,
      };
      break;
    case 'agent.finished':
      // The root agent ends with its session, not with agent.finished.
      if (next.parentAgentId === undefined) return agent;
      next = { ...omit(next, 'attention', 'currentTool'), activity: 'done' };
      break;
    default:
      // context.compacting keeps the activity (§4.3 has no row for it).
      break;
  }
  if (event.kind !== 'turn.failed' && isBlockingError(event.errorClass)) {
    next = { ...next, error: errorReason(event.errorClass, 'error'), errorAt: now };
  }
  return deriveHealth(next, now, cfg);
}

/**
 * Applies one event to the world. Pure and total: an event that doesn't parse, an unknown kind,
 * or an event for an agent that was never started or spawned leaves the world as it is.
 */
export function reduce(state: WorldState, event: AgentEvent, cfg: Thresholds): WorldState {
  const parsed = parseAgentEvent(event);
  if (!parsed.ok) return state;
  const e = parsed.value;
  switch (e.kind) {
    case 'session.started':
      return sessionStarted(state, e);
    case 'agent.spawned':
      return agentSpawned(state, e);
    case 'session.ended':
    case 'session.crashed':
      return sessionAgent(state, e, e.agentId) === undefined ? state : sessionOver(state, e, cfg);
    case 'clock.tick':
      return clockTick(state, e, cfg);
    case 'unknown':
      return state;
    case 'usage.recorded': {
      const agent = sessionAgent(state, e, e.agentId);
      if (agent === undefined || e.usage === undefined) return state;
      const usage = addUsage(agent.usage, e);
      return usage === undefined ? state : withAgent(state, { ...agent, usage });
    }
    default: {
      const agent = sessionAgent(state, e, e.agentId);
      if (agent === undefined) return state;
      return withAgent(state, agentEvent(agent, e, cfg));
    }
  }
}
