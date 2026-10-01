// Task 2.7: shared fixtures for the EventStore and migration tests. Every database file lives in a
// fresh `fs.mkdtemp` directory per test; nothing touches the real `$MICROMINDS_HOME`. Events are
// written out in full with constant ULIDs and fixed ms epochs, so every comparison is exact.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AgentEvent, EVENT_SCHEMA_VERSION } from '@micro-minds/shared';
import Database from 'better-sqlite3';

/** Where a later migration's previous-schema data fixtures live (see migrations.test.ts). */
export const DB_FIXTURES_DIR = path.resolve(import.meta.dirname, '../../../../fixtures/db');

export const DAY_MS = 24 * 60 * 60 * 1000;
/** A fixed "now" for retention tests (2025-10-09T08:53:20Z). */
export const NOW = 1_760_000_000_000;

/** ULID-shaped session ids (Crockford base32, 26 chars). */
export function sid(n: number): string {
  return `01K6G5W0000000000000${String(n).padStart(6, '0')}`;
}

/** ULID-shaped event ids, deliberately not in insertion order when the test says so. */
export function eid(n: number): string {
  return `01K6G5X${String(n).padStart(19, '0')}`;
}

export function makeTempDir(prefix = 'mm-store-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** The smallest valid event: required fields only. */
export function minimalEvent(n: number, sessionId: string, ts: number = NOW): AgentEvent {
  return {
    v: EVENT_SCHEMA_VERSION,
    id: eid(n),
    ts,
    sessionId,
    provider: 'fake',
    agentId: sessionId,
    kind: 'prompt.submitted',
  };
}

/** Every optional field set, with a nested raw of every JSON type. */
export function fullEvent(n: number, sessionId: string): AgentEvent {
  return {
    v: EVENT_SCHEMA_VERSION,
    id: eid(n),
    ts: NOW + 17,
    sessionId,
    provider: 'claude',
    agentId: 'agent-a1b2c3',
    parentAgentId: sessionId,
    kind: 'tool.failed',
    tool: { name: 'Bash', category: 'exec', useId: 'toolu_01AbCd', summary: 'npm test' },
    text: 'npm test failed: ünïcödé ✓ "quoted" \\ back\nslash',
    errorClass: 'other',
    raw: {
      hook_event_name: 'PostToolUseFailure',
      nested: { list: [1, 'two', null, true, { deep: 1.5, neg: -3 }], empty: {}, none: [] },
      exit_code: 1,
    },
  };
}

export function usageEvent(n: number, sessionId: string): AgentEvent {
  return {
    v: EVENT_SCHEMA_VERSION,
    id: eid(n),
    ts: NOW + 99,
    sessionId,
    provider: 'claude',
    agentId: sessionId,
    kind: 'usage.recorded',
    usage: {
      inputTokens: 1200,
      outputTokens: 345,
      cacheReadTokens: 56_789,
      cacheWriteTokens: 0,
      costUsd: 0.012_345,
      model: 'claude-sonnet-4-5',
      source: 'otel',
    },
  };
}

export function tickEvent(n: number, sessionId: string): AgentEvent {
  return {
    v: EVENT_SCHEMA_VERSION,
    id: eid(n),
    ts: NOW,
    sessionId,
    provider: 'fake',
    agentId: sessionId,
    kind: 'clock.tick',
  };
}

/** Every table's schema SQL and every row, read through a fresh raw handle. */
export function dumpDatabase(file: string): { schema: string[]; rows: Record<string, unknown[]> } {
  const db = new Database(file, { readonly: true });
  try {
    const entries = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ type: string; name: string; sql: string | null }>;
    const rows: Record<string, unknown[]> = {};
    for (const entry of entries) {
      if (entry.type !== 'table') continue;
      rows[entry.name] = db.prepare(`SELECT * FROM "${entry.name.replaceAll('"', '""')}"`).all();
    }
    return { schema: entries.map((e) => `${e.type} ${e.name} ${e.sql ?? ''}`), rows };
  } finally {
    db.close();
  }
}

/** The names of every table in the database. */
export function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}
