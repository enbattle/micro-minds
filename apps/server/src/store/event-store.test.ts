// Task 2.7, clauses C6 (EventStore), C7 (retention) and C8 (opening an existing database), and
// 2.7-fix clause F5 (a stored row that no longer parses).
// `openEventStore({ file, retentionMs? })` is the SQLite event store on better-sqlite3; the file
// path is handed in (from config), never derived here. Every database lives in a fresh temp dir.
import fs from 'node:fs';
import path from 'node:path';
import { type AgentEvent, EVENT_SCHEMA_VERSION } from '@micro-minds/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type EventStore, openEventStore } from './event-store.ts';
import {
  DAY_MS,
  dumpDatabase,
  eid,
  fullEvent,
  makeTempDir,
  minimalEvent,
  NOW,
  removeTempDir,
  sid,
  tickEvent,
  usageEvent,
} from './store.test-helpers.ts';

const S1 = sid(1);
const S2 = sid(2);

let dir = '';
let file = '';
const stores: EventStore[] = [];

beforeEach(() => {
  dir = makeTempDir();
  file = path.join(dir, 'micro-minds.db');
});

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
  removeTempDir(dir);
});

function openStore(options: { retentionMs?: number } = {}): EventStore {
  const store = openEventStore({ file, ...options });
  stores.push(store);
  return store;
}

function reopen(store: EventStore, options: { retentionMs?: number } = {}): EventStore {
  store.close();
  return openStore(options);
}

describe('EventStore (C6)', () => {
  it('creates its database at the path it is given', () => {
    openStore();

    expect(fs.existsSync(file)).toBe(true);
  });

  const ROUND_TRIPS: Array<{ name: string; event: AgentEvent }> = [
    { name: 'required fields only', event: minimalEvent(1, S1) },
    { name: 'every optional field, with a nested raw', event: fullEvent(2, S1) },
    { name: 'a usage delta', event: usageEvent(3, S1) },
    {
      name: 'a raw that is a string',
      event: { ...minimalEvent(4, S1), kind: 'unknown', raw: 'not json {' },
    },
    {
      name: 'a raw that is JSON null',
      event: { ...minimalEvent(5, S1), kind: 'unknown', raw: null },
    },
  ];

  it.each(ROUND_TRIPS)('reads back exactly what was appended: $name', ({ event }) => {
    const store = openStore();

    store.append(event);

    expect(store.read(S1)).toStrictEqual([event]);
  });

  it('keeps every event, with its schema version, across a reopen', () => {
    const events = ROUND_TRIPS.map((row) => row.event);
    const store = openStore();
    for (const event of events) store.append(event);

    const reopened = reopen(store);

    expect(reopened.read(S1)).toStrictEqual(events);
    expect(reopened.read(S1).map((e) => e.v)).toEqual(events.map((e) => e.v));
  });

  it('reads per session in insertion order, whatever the ids and timestamps say', () => {
    const store = openStore();
    const a1 = minimalEvent(9, S1, NOW + 500);
    const b1 = minimalEvent(8, S2, NOW + 400);
    const a2 = minimalEvent(3, S1, NOW + 100);
    const b2 = minimalEvent(7, S2, NOW + 900);
    const a3 = minimalEvent(5, S1, NOW + 100);
    for (const event of [a1, b1, a2, b2, a3]) store.append(event);

    expect(store.read(S1)).toStrictEqual([a1, a2, a3]);
    expect(store.read(S2)).toStrictEqual([b1, b2]);
    expect(store.read(sid(3))).toEqual([]);
  });

  it('reads the events inserted after a cursor (an event id), in insertion order', () => {
    const store = openStore();
    const events = [9, 2, 7, 4].map((n) => minimalEvent(n, S1));
    const other = minimalEvent(5, S2);
    store.append(events[0] ?? other);
    store.append(events[1] ?? other);
    store.append(other);
    store.append(events[2] ?? other);
    store.append(events[3] ?? other);

    expect(store.read(S1, { after: eid(9) })).toStrictEqual(events.slice(1));
    expect(store.read(S1, { after: eid(7) })).toStrictEqual(events.slice(3));
    expect(store.read(S1, { after: eid(4) })).toEqual([]);
  });

  it('is append-only: an event with an id already stored never replaces the stored one', () => {
    const store = openStore();
    const original = fullEvent(1, S1);
    store.append(original);
    const impostor: AgentEvent = { ...original, text: 'overwritten', kind: 'turn.failed' };

    try {
      store.append(impostor);
    } catch {
      // Refusing the duplicate is fine; replacing the original is not.
    }

    const stored = store.read(S1);
    expect(stored[0]).toStrictEqual(original);
    expect(stored.some((e) => e.text === 'overwritten')).toBe(false);
  });

  it('never stores clock.tick events (D15: ticks are emitted, not stored)', () => {
    const store = openStore();

    try {
      store.append(tickEvent(1, S1));
    } catch {
      // Refusing the tick is fine too.
    }
    store.append(minimalEvent(2, S1));

    expect(store.read(S1)).toStrictEqual([minimalEvent(2, S1)]);
  });
});

describe('a stored row that no longer parses (F5)', () => {
  const bad = (n: number): string => eid(100 + n);

  const BAD_ROWS: Array<{ name: string; event: string | Buffer }> = [
    { name: 'corrupt JSON', event: '{"v":1,"id":"01K6G5X' },
    { name: 'JSON that is not an object', event: '[1,2,3]' },
    {
      name: 'an event from a schema version this code refuses',
      event: JSON.stringify({ ...minimalEvent(51, S1), v: EVENT_SCHEMA_VERSION + 1 }),
    },
    {
      name: 'an event with a provider the schema refuses',
      event: JSON.stringify({ ...minimalEvent(52, S1), provider: 'no-such-provider' }),
    },
    {
      name: 'an event missing a required field',
      event: JSON.stringify({ ...minimalEvent(53, S1), agentId: undefined }),
    },
    { name: 'a blob, not text', event: Buffer.from([0xff, 0x00, 0x7b]) },
  ];

  function insertRaw(n: number, event: string | Buffer): void {
    const db = new Database(file);
    try {
      db.prepare(
        'INSERT INTO events (id, session_id, ts, kind, v, event) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(bad(n), S1, NOW, 'prompt.submitted', EVENT_SCHEMA_VERSION, event);
    } finally {
      db.close();
    }
  }

  it.each(BAD_ROWS)(
    'a row holding $name is skipped: read() never throws and returns the other events in order',
    ({ event }) => {
      const store = openStore();
      const before = [minimalEvent(1, S1), minimalEvent(2, S1)];
      const after = [minimalEvent(3, S1), minimalEvent(4, S1)];
      for (const e of before) store.append(e);
      insertRaw(1, event);
      for (const e of after) store.append(e);

      expect(() => store.read(S1)).not.toThrow();
      expect(store.read(S1)).toStrictEqual([...before, ...after]);
      expect(store.read(S1, { after: eid(1) })).toStrictEqual([before[1], ...after]);
    },
  );
});

describe('retention (C7)', () => {
  it('by default deletes events older than 30 days before now, and nothing newer', () => {
    const store = openStore();
    const expired = minimalEvent(1, S1, NOW - 30 * DAY_MS - 1);
    const boundary = minimalEvent(2, S1, NOW - 30 * DAY_MS);
    const recent = minimalEvent(3, S1, NOW - DAY_MS);
    const ahead = minimalEvent(4, S1, NOW + 60_000);
    const otherExpired = minimalEvent(5, S2, NOW - 45 * DAY_MS);
    const otherRecent = minimalEvent(6, S2, NOW - 29 * DAY_MS);
    for (const event of [expired, boundary, recent, ahead, otherExpired, otherRecent]) {
      store.append(event);
    }

    store.prune(NOW);

    expect(store.read(S1)).toStrictEqual([boundary, recent, ahead]);
    expect(store.read(S2)).toStrictEqual([otherRecent]);
  });

  it('uses the configured retention window', () => {
    const hour = 60 * 60 * 1000;
    const store = openStore({ retentionMs: hour });
    const expired = minimalEvent(1, S1, NOW - hour - 1);
    const kept = minimalEvent(2, S1, NOW - hour / 2);
    store.append(expired);
    store.append(kept);

    store.prune(NOW);

    expect(store.read(S1)).toStrictEqual([kept]);
  });

  it('measures age by each event’s ts against the given now, not by insertion order', () => {
    const store = openStore({ retentionMs: DAY_MS });
    const lateButOld = minimalEvent(1, S1, NOW - 2 * DAY_MS);
    const early = minimalEvent(2, S1, NOW);
    store.append(early);
    store.append(lateButOld);

    store.prune(NOW);

    expect(store.read(S1)).toStrictEqual([early]);
  });

  it('pruning twice, or with nothing old, deletes nothing more', () => {
    const store = openStore({ retentionMs: DAY_MS });
    const kept = [minimalEvent(1, S1, NOW - 1000), minimalEvent(2, S1, NOW)];
    for (const event of kept) store.append(event);

    store.prune(NOW);
    store.prune(NOW);

    expect(store.read(S1)).toStrictEqual(kept);
  });

  it('nothing is deleted without a prune: old events survive appends, reads and reopens', () => {
    const store = openStore({ retentionMs: DAY_MS });
    const ancient = minimalEvent(1, S1, 0);
    store.append(ancient);
    store.append(minimalEvent(2, S1, NOW));
    store.read(S1);

    const reopened = reopen(store, { retentionMs: DAY_MS });

    expect(reopened.read(S1)[0]).toStrictEqual(ancient);
  });
});

describe('opening an existing database (C8)', () => {
  it('opening a database already at the latest version changes nothing', () => {
    const store = openStore();
    store.append(fullEvent(1, S1));
    store.append(usageEvent(2, S2));
    store.close();
    const before = dumpDatabase(file);

    openStore().close();

    expect(dumpDatabase(file)).toEqual(before);
  });
});
