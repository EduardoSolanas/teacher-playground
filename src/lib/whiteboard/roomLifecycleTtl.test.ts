import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from './roomDb';
import {
  ROOM_IDLE_TTL_MS,
  ROOM_SCOPED_TABLES,
  TOMBSTONE_TTL_MS,
  purgeExpiredRoomsAndTombstones,
} from './roomSchema';
import { createSqlTombstoneStore } from './tombstone';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function insertRoom(roomId: string, updatedAt: number): void {
  db.prepare(
    `INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`,
  ).run(roomId, updatedAt, updatedAt);
  db.prepare(
    `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen)
     VALUES (?, 'p1', 'Ada', '#111111', ?, ?)`,
  ).run(roomId, updatedAt, updatedAt);
  db.prepare(
    `INSERT INTO room_members (
       room_id, account_id, role, display_name, email,
       requested_at, created_at, updated_at, expires_at
     ) VALUES (?, 'acc', 'owner', NULL, NULL, NULL, ?, ?, NULL)`,
  ).run(roomId, updatedAt, updatedAt);
}

function scopedRowCount(roomId: string): number {
  let n = 0;
  for (const table of ROOM_SCOPED_TABLES) {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE room_id = ?`)
      .get(roomId) as { n: number };
    n += row.n;
  }
  return n;
}

describe('purgeExpiredRoomsAndTombstones (SEC-007)', () => {
  it('empties stale room tables and writes a tombstone', () => {
    const now = 1_700_000_000_000;
    insertRoom('stale', now - ROOM_IDLE_TTL_MS);
    expect(scopedRowCount('stale')).toBeGreaterThan(0);

    const purged = purgeExpiredRoomsAndTombstones(db, now);

    expect(scopedRowCount('stale')).toBe(0);
    expect(createSqlTombstoneStore(db).has('stale')).toBe(true);
    expect(purged).toEqual(['stale']);
  });

  it('keeps a fresh room', () => {
    const now = 1_700_000_000_000;
    insertRoom('fresh', now - ROOM_IDLE_TTL_MS + 1);
    const before = scopedRowCount('fresh');

    const purged = purgeExpiredRoomsAndTombstones(db, now);

    expect(scopedRowCount('fresh')).toBe(before);
    expect(createSqlTombstoneStore(db).has('fresh')).toBe(false);
    expect(purged).toEqual([]);
  });

  it('removes an old tombstone so recreate can proceed', () => {
    const now = 1_700_000_000_000;
    const store = createSqlTombstoneStore(db);
    db.prepare(
      `INSERT INTO room_tombstones (room_id, deleted_at) VALUES (?, ?)`,
    ).run('old-tomb', now - TOMBSTONE_TTL_MS);
    expect(store.has('old-tomb')).toBe(true);

    purgeExpiredRoomsAndTombstones(db, now);

    expect(store.has('old-tomb')).toBe(false);
  });

  it('keeps a new tombstone', () => {
    const now = 1_700_000_000_000;
    const store = createSqlTombstoneStore(db);
    db.prepare(
      `INSERT INTO room_tombstones (room_id, deleted_at) VALUES (?, ?)`,
    ).run('new-tomb', now - TOMBSTONE_TTL_MS + 1);
    expect(store.has('new-tomb')).toBe(true);

    purgeExpiredRoomsAndTombstones(db, now);

    expect(store.has('new-tomb')).toBe(true);
  });
});
