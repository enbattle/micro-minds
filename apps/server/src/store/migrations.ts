// Versioned, forward-only schema migrations for the SQLite store (task 2.7). The database records
// its version in `PRAGMA user_version`. Opening applies the pending migrations in order, each in
// its own transaction together with its version bump, so a failing migration leaves the database
// at the previous version with its data. A database newer than the code is refused: there are no
// downgrades. A new migration is appended to MIGRATIONS with the next number, and brings the
// previous schema's data fixtures (fixtures/db/v<N-1>-*.{sql,jsonl}, see migrations.test.ts).
import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (db) => {
      // `seq` is the insertion order; the event itself is stored whole as JSON, with the columns
      // the queries need beside it. Append-only: nothing updates a row, and only retention
      // pruning deletes.
      db.exec(`
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          v INTEGER NOT NULL,
          event TEXT NOT NULL
        );
        CREATE INDEX events_session_seq ON events (session_id, seq);
        CREATE INDEX events_ts ON events (ts);
      `);
    },
  },
];

export function schemaVersion(db: Database.Database): number {
  const version: unknown = db.pragma('user_version', { simple: true });
  return typeof version === 'number' ? version : 0;
}

/** Brings `db` up to the last migration's version. Throws on a newer database or a failure. */
export function migrate(db: Database.Database, migrations: readonly Migration[]): void {
  migrations.forEach((migration, i) => {
    if (migration.version !== i + 1) {
      throw new Error(`Migrations must be numbered 1..n in order; found ${migration.version}`);
    }
  });
  const latest = migrations.length;
  const current = schemaVersion(db);
  if (current > latest) {
    throw new Error(
      `The database is at schema version ${current}, newer than this micro-minds knows (${latest}); it won't be downgraded`,
    );
  }
  for (const migration of migrations.slice(current)) {
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
