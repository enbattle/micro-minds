// Shared helpers for the packages/shared tests (task 2.1). Test-only: this file may use node:
// modules; the package source may not (packages/shared/CLAUDE.md).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  AgentEvent,
  AgentState,
  EventKind,
  Thresholds,
  ToolCategory,
  UsageDelta,
  WorldState,
} from './index.ts';
import {
  createWorld,
  DEFAULT_THRESHOLDS,
  EVENT_SCHEMA_VERSION,
  parseAgentEvent,
  reduce,
} from './index.ts';

export const SEC = 1_000;
export const MIN = 60_000;
/** A fixed ms epoch; tests never read the real clock. */
export const T0 = 1_790_000_000_000;

/** Our session id (a ULID). The root agent's id equals it (PLAN §4.1). */
export const SESSION_ID = '01K6A2B3C4D5E6F7G8H9J0K1M2';
export const ROOT = SESSION_ID;
/** A provider subagent id, shaped like Claude's `agent_id`. */
export const SUB = 'a3f9c2e17b8d4056';
/** An agent id that never sent agent.spawned (docs/protocols/claude.md, finding 6). */
export const GHOST = 'a0d1e2f3a4b5c6d7';

let sequence = 0;
/** Deterministic ULID-shaped event ids. */
export function nextEventId(): string {
  sequence += 1;
  return `01K6C${String(sequence).padStart(21, '0')}`;
}

export interface EventInit {
  ts: number;
  agentId?: string;
  parentAgentId?: string;
  tool?: { name: string; category: ToolCategory; useId?: string; summary?: string };
  text?: string;
  errorClass?: 'rate_limit' | 'auth' | 'budget' | 'other';
  usage?: UsageDelta;
  raw?: unknown;
}

/** Builds a valid AgentEvent for the root agent of SESSION_ID unless `agentId` says otherwise. */
export function ev(kind: EventKind, init: EventInit): AgentEvent {
  return {
    v: EVENT_SCHEMA_VERSION,
    id: nextEventId(),
    sessionId: SESSION_ID,
    provider: 'claude',
    agentId: ROOT,
    kind,
    ...init,
  };
}

export function tick(ts: number, agentId: string = ROOT): AgentEvent {
  return ev('clock.tick', { ts, agentId });
}

/** Folds events through reduce() from an empty world. */
export function run(
  events: readonly AgentEvent[],
  cfg: Thresholds = DEFAULT_THRESHOLDS,
  start: WorldState = createWorld(),
): WorldState {
  let world = start;
  for (const event of events) {
    world = reduce(world, event, cfg);
  }
  return world;
}

/** The world after each event, in order. */
export function trace(
  events: readonly AgentEvent[],
  cfg: Thresholds = DEFAULT_THRESHOLDS,
): WorldState[] {
  const worlds: WorldState[] = [];
  let world = createWorld();
  for (const event of events) {
    world = reduce(world, event, cfg);
    worlds.push(world);
  }
  return worlds;
}

export function agentOf(world: WorldState, agentId: string): AgentState {
  const agent = world.agents[agentId];
  if (agent === undefined) {
    throw new Error(`agent ${agentId} is missing from the world`);
  }
  return agent;
}

const EVENT_FIXTURES = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'fixtures',
  'agent-events',
);

/** Loads fixtures/agent-events/<name>.jsonl: one AgentEvent per line, each parsed as unknown. */
export function loadEventFixture(name: string): AgentEvent[] {
  const text = readFileSync(path.join(EVENT_FIXTURES, `${name}.jsonl`), 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      const input: unknown = JSON.parse(line);
      const result = parseAgentEvent(input);
      if (!result.ok) {
        throw new Error(`${name}.jsonl line ${index + 1} did not parse: ${result.reason}`);
      }
      return result.value;
    });
}
