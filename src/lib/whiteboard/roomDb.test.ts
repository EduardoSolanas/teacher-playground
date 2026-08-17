import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from './roomDb';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
});

describe('roomDb schema', () => {
  describe('applySchema', () => {
    it('creates a rooms table with a name column', () => {
      applySchema(db);

      const columns = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
      const nameColumn = columns.find((col) => col.name === 'name');

      expect(nameColumn).toBeDefined();
    });

    it('is idempotent - calling twice does not throw', () => {
      expect(() => {
        applySchema(db);
        applySchema(db);
      }).not.toThrow();
    });

    it('migration path: adds name column to existing rooms table', () => {
      db.exec(`
        CREATE TABLE rooms (
          room_id TEXT PRIMARY KEY,
          elements TEXT NOT NULL DEFAULT '[]',
          viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
          max_users INTEGER NOT NULL DEFAULT 3,
          host_peer_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      const columnsBeforeMigration = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
      const hasNameBefore = columnsBeforeMigration.some((col) => col.name === 'name');
      expect(hasNameBefore).toBe(false);

      applySchema(db);

      const columnsAfterMigration = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
      const hasNameAfter = columnsAfterMigration.some((col) => col.name === 'name');
      expect(hasNameAfter).toBe(true);
    });

    it('migration preserves pre-existing rows with name NULL', () => {
      db.exec(`
        CREATE TABLE rooms (
          room_id TEXT PRIMARY KEY,
          elements TEXT NOT NULL DEFAULT '[]',
          viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
          max_users INTEGER NOT NULL DEFAULT 3,
          host_peer_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      const now = Date.now();
      db.prepare(
        `INSERT INTO rooms (room_id, elements, viewport, max_users, host_peer_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('room-1', '[]', '{}', 3, null, now, now);

      applySchema(db);

      const row = db.prepare(`SELECT room_id, name FROM rooms WHERE room_id = ?`).get('room-1') as
        | { room_id: string; name: string | null }
        | undefined;

      expect(row).toBeDefined();
      expect(row?.room_id).toBe('room-1');
      expect(row?.name).toBeNull();
    });

    it('a room row round-trips a name value', () => {
      applySchema(db);

      const now = Date.now();
      const testName = 'My Whiteboard';

      db.prepare(
        `INSERT INTO rooms (room_id, elements, viewport, max_users, host_peer_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('room-123', '[]', '{}', 3, null, testName, now, now);

      const row = db.prepare(`SELECT name FROM rooms WHERE room_id = ?`).get('room-123') as
        | { name: string }
        | undefined;

      expect(row?.name).toBe('My Whiteboard');
    });

    it('allows NULL for name column', () => {
      applySchema(db);

      const now = Date.now();
      db.prepare(
        `INSERT INTO rooms (room_id, elements, viewport, max_users, host_peer_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('room-null', '[]', '{}', 3, null, null, now, now);

      const row = db.prepare(`SELECT name FROM rooms WHERE room_id = ?`).get('room-null') as
        | { name: string | null }
        | undefined;

      expect(row?.name).toBeNull();
    });
  });
});
