// The EventStore (task 2.7): every AgentEvent a session produces, in SQLite (better-sqlite3), in
// the database file config names. Append-only: events are inserted, never updated; an event id
// already stored is ignored, never replaced. `clock.tick` events are never stored (ADR 0015).
// The only deletion is `prune(now)`, the retention setting (default 30 days, PLAN §13).
// The stored `raw` is already scrubbed and capped by the provider registry (D14).
import { type AgentEvent, parseAgentEvent } from '@micro-minds/shared';
import Database from 'better-sqlite3';
import { MIGRATIONS, migrate } from './migrations.ts';

export const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface EventStoreOptions {
  /** The database file (from config). */
  file: string;
  retentionMs?: number;
}

export interface EventStore {
  append(event: AgentEvent): void;
  /** A session's events in insertion order; with `after`, only those inserted after that event. */
  read(sessionId: string, options?: { after?: string }): AgentEvent[];
  /** Deletes the events older than the retention window before `now` (ms epoch). */
  prune(now: number): void;
  close(): void;
}

export function openEventStore(options: EventStoreOptions): EventStore {
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const db = new Database(options.file);
  try {
    db.pragma('journal_mode = WAL');
    migrate(db, MIGRATIONS);
  } catch (error: unknown) {
    db.close();
    throw error;
  }

  const insert = db.prepare(
    'INSERT OR IGNORE INTO events (id, session_id, ts, kind, v, event) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const all = db.prepare('SELECT event FROM events WHERE session_id = ? ORDER BY seq');
  const after = db.prepare(
    'SELECT event FROM events WHERE session_id = ? AND seq > (SELECT seq FROM events WHERE id = ?) ORDER BY seq',
  );
  const prune = db.prepare('DELETE FROM events WHERE ts < ?');

  function decode(rows: unknown[]): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const row of rows) {
      if (typeof row !== 'object' || row === null || !('event' in row)) continue;
      if (typeof row.event !== 'string') continue;
      // The database is a boundary too: a row that no longer parses is skipped, not trusted.
      let value: unknown;
      try {
        value = JSON.parse(row.event);
      } catch {
        continue;
      }
      const parsed = parseAgentEvent(value);
      if (parsed.ok) events.push(parsed.value);
    }
    return events;
  }

  return {
    append(event) {
      if (event.kind === 'clock.tick') return;
      insert.run(event.id, event.sessionId, event.ts, event.kind, event.v, JSON.stringify(event));
    },
    read(sessionId, readOptions) {
      const rows =
        readOptions?.after === undefined
          ? all.all(sessionId)
          : after.all(sessionId, readOptions.after);
      return decode(rows);
    },
    prune(now) {
      prune.run(now - retentionMs);
    },
    close() {
      db.close();
    },
  };
}
