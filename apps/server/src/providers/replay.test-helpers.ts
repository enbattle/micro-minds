// Task 2.4: shared helpers for the provider adapter tests. Fixture loading (paths resolved from
// this file, never the cwd), deterministic normalize contexts and a replay through shared reduce().
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, Provider, WorldState } from '@micro-minds/shared';
import { createWorld, DEFAULT_THRESHOLDS, EVENT_SCHEMA_VERSION, reduce } from '@micro-minds/shared';
import type { NormalizeContext } from './types.ts';

/** The repository root: apps/server/src/providers → four levels up. */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
export const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');
export const CLAUDE_FIXTURES_DIR = path.join(FIXTURES_DIR, 'claude');
export const FAKE_FIXTURES_DIR = path.join(FIXTURES_DIR, 'fake');

/** Our session id (a ULID); the root agent's id equals it. */
export const SESSION_ID = '01K6A2B3C4D5E6F7G8H9J0K1M2';
export const ROOT = SESSION_ID;
/** A fixed ms epoch; tests never read the real clock. */
export const T0 = 1_790_000_000_000;

/** One parsed JSON value per non-empty line. */
export function loadJsonl(file: string): unknown[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line): unknown => JSON.parse(line));
}

/** The raw (unparsed) non-empty lines of a JSONL file. */
export function rawLines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}

/** Hook fixtures: every fixtures/claude/*.jsonl except the telemetry ones (otel-*, statusline-*). */
export function claudeHookFixtureNames(): string[] {
  return readdirSync(CLAUDE_FIXTURES_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .filter((f) => !f.startsWith('otel-') && !f.startsWith('statusline-'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .sort();
}

export function loadClaudeFixture(name: string): unknown[] {
  return loadJsonl(path.join(CLAUDE_FIXTURES_DIR, `${name}.jsonl`));
}

/** Every line of every Claude hook fixture. */
export function allClaudeHookLines(): unknown[] {
  return claudeHookFixtureNames().flatMap((name) => loadClaudeFixture(name));
}

export function fakeFixtureNames(): string[] {
  return readdirSync(FAKE_FIXTURES_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .sort();
}

export function loadFakeFixture(name: string): unknown[] {
  return loadJsonl(path.join(FAKE_FIXTURES_DIR, `${name}.jsonl`));
}

/** Every line of every fixtures/fake/*.jsonl scenario. */
export function allFakeLines(): unknown[] {
  return fakeFixtureNames().flatMap((name) => loadFakeFixture(name));
}

/**
 * A source of deterministic contexts: ids are ULID-shaped and unique across calls, and each call
 * to `next()` advances the receipt time by one second from T0.
 */
export function contextSource(sessionId: string = SESSION_ID): {
  next: () => NormalizeContext;
  issued: string[];
} {
  const issued: string[] = [];
  let n = 0;
  let step = 0;
  return {
    issued,
    next: () => {
      step += 1;
      return {
        sessionId,
        receivedAt: T0 + step * 1_000,
        newId: () => {
          n += 1;
          const id = `01K6G${String(n).padStart(21, '0')}`;
          issued.push(id);
          return id;
        },
      };
    },
  };
}

/** One fixed context whose newId hands out ULID-shaped ids in order. */
export function fixedContext(receivedAt: number = T0): {
  ctx: NormalizeContext;
  issued: string[];
} {
  const issued: string[] = [];
  let n = 0;
  return {
    issued,
    ctx: {
      sessionId: SESSION_ID,
      receivedAt,
      newId: () => {
        n += 1;
        const id = `01K6H${String(n).padStart(21, '0')}`;
        issued.push(id);
        return id;
      },
    },
  };
}

/** The synthetic session.started that the PTY spawn would record (ADR 0029). */
export function sessionStarted(provider: Provider, ts: number = T0): AgentEvent {
  return {
    v: EVENT_SCHEMA_VERSION,
    id: '01K6J000000000000000000000',
    ts,
    sessionId: SESSION_ID,
    provider,
    agentId: ROOT,
    kind: 'session.started',
  };
}

/** Folds events through reduce() from `start`. */
export function fold(events: readonly AgentEvent[], start: WorldState = createWorld()): WorldState {
  let world = start;
  for (const event of events) world = reduce(world, event, DEFAULT_THRESHOLDS);
  return world;
}

/**
 * Replays payloads, one normalize call per payload: returns the events of each payload and the
 * world after each payload, starting from a world where `session.started` created the root agent.
 */
export function replay(
  provider: Provider,
  payloads: readonly unknown[],
  normalize: (raw: unknown, ctx: NormalizeContext) => AgentEvent[],
): { perLine: AgentEvent[][]; events: AgentEvent[]; worlds: WorldState[]; final: WorldState } {
  const source = contextSource();
  const perLine: AgentEvent[][] = [];
  const worlds: WorldState[] = [];
  let world = fold([sessionStarted(provider)]);
  for (const payload of payloads) {
    const events = normalize(payload, source.next());
    perLine.push(events);
    world = fold(events, world);
    worlds.push(world);
  }
  return { perLine, events: perLine.flat(), worlds, final: world };
}

/** The payload with the transcript keys removed: what an adapter keeps as raw (hard rule 1). */
export function withoutTranscripts(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload;
  const copy: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  delete copy.transcript_path;
  delete copy.agent_transcript_path;
  return copy;
}

/** The transcript path values a payload carries, for "never stored" checks. */
export function transcriptPaths(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  return [record.transcript_path, record.agent_transcript_path].filter(
    (v): v is string => typeof v === 'string' && v !== '',
  );
}
