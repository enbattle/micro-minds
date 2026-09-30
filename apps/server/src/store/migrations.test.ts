// Task 2.7, clause C8: versioned, forward-only migrations. `migrate(db, migrations)` runs on a raw
// better-sqlite3 handle; the runner's behavior is pinned with synthetic migrations the test owns
// (so their schemas and data are known), and the real `MIGRATIONS` list is checked against a
// database created by the previous schema.
//
// The schema version is observed only through behavior: which `up()` functions a later `migrate`
// runs on the same file (a recorded version means the applied ones never run again).
import fs from 'node:fs';
import path from 'node:path';
import { type AgentEvent, parseAgentEvent } from '@micro-minds/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openEventStore } from './event-store.ts';
import { MIGRATIONS, type Migration, migrate } from './migrations.ts';
import {
  DB_FIXTURES_DIR,
  dumpDatabase,
  makeTempDir,
  removeTempDir,
  tableNames,
} from './store.test-helpers.ts';

let dir = '';
let file = '';
const open: Database.Database[] = [];

beforeEach(() => {
  dir = makeTempDir('mm-migrate-');
  file = path.join(dir, 'micro-minds.db');
});

afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
  removeTempDir(dir);
});

function handle(): Database.Database {
  const db = new Database(file);
  open.push(db);
  return db;
}

/** Runs `migrate` on a fresh handle to the test's file, then closes it. */
function migrateFile(migrations: readonly Migration[]): void {
  const db = handle();
  try {
    migrate(db, migrations);
  } finally {
    db.close();
  }
}

/** Synthetic migrations that record the order they ran in. */
function synthetic(ran: number[]): Migration[] {
  return [
    {
      version: 1,
      up: (db) => {
        ran.push(1);
        db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
      },
    },
    {
      version: 2,
      up: (db) => {
        ran.push(2);
        db.exec("ALTER TABLE notes ADD COLUMN tag TEXT NOT NULL DEFAULT 'none'");
      },
    },
    {
      version: 3,
      up: (db) => {
        ran.push(3);
        db.exec('CREATE INDEX notes_tag ON notes (tag)');
      },
    },
  ];
}

function firstOf(migrations: readonly Migration[], count: number): Migration[] {
  return migrations.slice(0, count);
}

/** A migration that changes the schema and data, then fails. */
function failing(version: number, ran: number[]): Migration {
  return {
    version,
    up: (db) => {
      ran.push(version);
      db.exec('CREATE TABLE half_done (x INTEGER)');
      db.exec("UPDATE notes SET body = 'clobbered'");
      throw new Error('migration failed on purpose');
    },
  };
}

function notes(db: Database.Database): unknown[] {
  return db.prepare('SELECT id, body FROM notes ORDER BY id').all();
}

describe('migrate (C8)', () => {
  it('applies every migration in order to an empty database', () => {
    const ran: number[] = [];

    migrateFile(synthetic(ran));

    expect(ran).toEqual([1, 2, 3]);
    const db = handle();
    expect(tableNames(db)).toContain('notes');
  });

  it('records the version: reopening at the latest version runs nothing and changes nothing', () => {
    const ran: number[] = [];
    migrateFile(synthetic(ran));
    const db = handle();
    db.prepare('INSERT INTO notes (body) VALUES (?)').run('kept');
    db.close();
    const before = dumpDatabase(file);

    migrateFile(synthetic(ran));

    expect(ran).toEqual([1, 2, 3]);
    expect(dumpDatabase(file)).toEqual(before);
  });

  it.each([
    { name: 'from version 1', applied: 1, expected: [2, 3] },
    { name: 'from version 2', applied: 2, expected: [3] },
  ])(
    'applies only the pending migrations, in order ($name), and the data survives',
    ({ applied, expected }) => {
      migrateFile(firstOf(synthetic([]), applied));
      const seed = handle();
      seed.prepare('INSERT INTO notes (body) VALUES (?), (?)').run('first', 'second');
      seed.close();
      const ran: number[] = [];

      migrateFile(synthetic(ran));

      expect(ran).toEqual(expected);
      const db = handle();
      expect(notes(db)).toEqual([
        { id: 1, body: 'first' },
        { id: 2, body: 'second' },
      ]);
    },
  );

  it('a failing migration throws, is rolled back, and leaves the database at the previous version with its data', () => {
    migrateFile(firstOf(synthetic([]), 1));
    const seed = handle();
    seed.prepare('INSERT INTO notes (body) VALUES (?)').run('precious');
    seed.close();
    const before = dumpDatabase(file);
    const ran: number[] = [];

    expect(() => migrateFile([...firstOf(synthetic([]), 1), failing(2, ran)])).toThrow();

    expect(ran).toEqual([2]);
    expect(dumpDatabase(file)).toEqual(before);
    // Still at version 1: the next run applies version 2 and nothing before it.
    const rerun: number[] = [];
    migrateFile(synthetic(rerun));
    expect(rerun).toEqual([2, 3]);
  });

  it('each migration has its own transaction: the ones before a failure stay applied', () => {
    const ran: number[] = [];
    const [one] = synthetic(ran);
    if (one === undefined) throw new Error('no synthetic migration');

    expect(() => migrateFile([one, failing(2, ran)])).toThrow();

    expect(ran).toEqual([1, 2]);
    const db = handle();
    expect(tableNames(db)).toContain('notes');
    expect(tableNames(db)).not.toContain('half_done');
    db.close();
    const rerun: number[] = [];
    migrateFile(synthetic(rerun));
    expect(rerun).toEqual([2, 3]);
  });

  it('refuses a database whose version is newer than the code knows, with an error naming the version, and changes nothing', () => {
    migrateFile(synthetic([]));
    const seed = handle();
    seed.prepare('INSERT INTO notes (body) VALUES (?)').run('from the future');
    seed.close();
    const before = dumpDatabase(file);
    const ran: number[] = [];

    expect(() => migrateFile(firstOf(synthetic(ran), 2))).toThrow(/3/);

    expect(ran).toEqual([]);
    expect(dumpDatabase(file)).toEqual(before);
  });
});

describe('MIGRATIONS (C8)', () => {
  it('are numbered 1, 2, 3… in order', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it('the first migration builds a working store from an empty database (the schema before it)', () => {
    new Database(file).close();

    const store = openEventStore({ file });
    try {
      expect(store.read('01K6G5W0000000000000000001')).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('the store records the version: a later migrate() on its file runs none of them again', () => {
    openEventStore({ file }).close();
    const ran: number[] = [];
    const spied = MIGRATIONS.map(
      (m): Migration => ({
        ...m,
        up: (db) => {
          ran.push(m.version);
          m.up(db);
        },
      }),
    );

    migrateFile(spied);

    expect(ran).toEqual([]);
  });

  it('the store refuses a database newer than the latest migration', () => {
    const next: Migration = { version: MIGRATIONS.length + 1, up: () => {} };
    migrateFile([...MIGRATIONS, next]);

    expect(() => openEventStore({ file }).close()).toThrow(new RegExp(String(next.version)));
  });

  // Each migration after the first is tested against a database created by the previous
  // schema: the real migrations up to it, then fixtures/db/v<N-1>-data.sql (INSERTs in that
  // schema's shape) whose events, listed in fixtures/db/v<N-1>-events.jsonl, must read back
  // exactly after the upgrade. A migration added later brings its two fixture files.
  it('each later migration upgrades a database created by the previous schema, and its data survives', () => {
    for (const migration of MIGRATIONS.slice(1)) {
      const previous = migration.version - 1;
      const dataSql = path.join(DB_FIXTURES_DIR, `v${previous}-data.sql`);
      const eventsFile = path.join(DB_FIXTURES_DIR, `v${previous}-events.jsonl`);
      expect(fs.existsSync(dataSql), `migration ${migration.version} needs ${dataSql}`).toBe(true);
      expect(fs.existsSync(eventsFile), `migration ${migration.version} needs ${eventsFile}`).toBe(
        true,
      );

      const upgradeFile = path.join(dir, `upgrade-from-v${previous}.db`);
      const db = new Database(upgradeFile);
      migrate(db, MIGRATIONS.slice(0, previous));
      db.exec(fs.readFileSync(dataSql, 'utf8'));
      db.close();
      const expected = fs
        .readFileSync(eventsFile, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line): AgentEvent => {
          const parsed = parseAgentEvent(JSON.parse(line));
          if (!parsed.ok) throw new Error(`bad fixture event: ${line}`);
          return parsed.value;
        });

      const store = openEventStore({ file: upgradeFile });
      try {
        for (const sessionId of new Set(expected.map((e) => e.sessionId))) {
          expect(store.read(sessionId)).toStrictEqual(
            expected.filter((e) => e.sessionId === sessionId),
          );
        }
      } finally {
        store.close();
      }
    }
  });
});
