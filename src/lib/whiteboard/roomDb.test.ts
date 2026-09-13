import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applySchema } from './roomDb';
import {
  addFileBytes,
  getFileBytesTotal,
  getGrantVersion,
  getRoomHostPeerId,
  incrementGrantVersion,
  purgeExpiredRoomsAndTombstones,
  roomExists,
  setFileBytes,
  subtractFileBytes,
} from './roomSchema';

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

    it('adds hand_raised to an existing room_presence table without clearing rows', () => {
      db.exec(`
        CREATE TABLE room_presence (
          room_id TEXT NOT NULL,
          peer_id TEXT NOT NULL,
          user_name TEXT NOT NULL,
          color TEXT NOT NULL,
          first_seen INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          PRIMARY KEY (room_id, peer_id)
        )
      `);
      db.prepare(
        `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('room-1', 'peer-1', 'Alice', '#3498db', 1, 2);

      applySchema(db);

      const columns = db.prepare(`PRAGMA table_info(room_presence)`).all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === 'hand_raised')).toBe(true);
      const row = db.prepare(
        `SELECT hand_raised AS handRaised FROM room_presence WHERE room_id = ? AND peer_id = ?`,
      ).get('room-1', 'peer-1') as { handRaised: number };
      expect(row.handRaised).toBe(0);
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

    it('migration path: adds all six guest columns to existing rooms table', () => {
      db.exec(`
        CREATE TABLE rooms (
          room_id TEXT PRIMARY KEY,
          elements TEXT NOT NULL DEFAULT '[]',
          viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
          max_users INTEGER NOT NULL DEFAULT 3,
          host_peer_id TEXT,
          name TEXT,
          allow_first_user_host INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      const columnsBeforeMigration = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
      expect(columnsBeforeMigration.some((col) => col.name === 'guest_access')).toBe(false);
      expect(columnsBeforeMigration.some((col) => col.name === 'guest_pin')).toBe(false);
      expect(columnsBeforeMigration.some((col) => col.name === 'guest_pin_expires_at')).toBe(false);
      expect(columnsBeforeMigration.some((col) => col.name === 'guest_failed_count')).toBe(false);
      expect(columnsBeforeMigration.some((col) => col.name === 'guest_failed_window_at')).toBe(false);
      expect(columnsBeforeMigration.some((col) => col.name === 'guest_lockout_until')).toBe(false);

      applySchema(db);

      const columnsAfterMigration = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
      expect(columnsAfterMigration.some((col) => col.name === 'guest_access')).toBe(true);
      expect(columnsAfterMigration.some((col) => col.name === 'guest_pin')).toBe(true);
      expect(columnsAfterMigration.some((col) => col.name === 'guest_pin_expires_at')).toBe(true);
      expect(columnsAfterMigration.some((col) => col.name === 'guest_failed_count')).toBe(true);
      expect(columnsAfterMigration.some((col) => col.name === 'guest_failed_window_at')).toBe(true);
      expect(columnsAfterMigration.some((col) => col.name === 'guest_lockout_until')).toBe(true);
    });

    it('migration preserves pre-existing rows with guest_access = 0, guest_pin IS NULL, guest_failed_count = 0', () => {
      db.exec(`
        CREATE TABLE rooms (
          room_id TEXT PRIMARY KEY,
          elements TEXT NOT NULL DEFAULT '[]',
          viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
          max_users INTEGER NOT NULL DEFAULT 3,
          host_peer_id TEXT,
          name TEXT,
          allow_first_user_host INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      const now = Date.now();
      db.prepare(
        `INSERT INTO rooms (room_id, elements, viewport, max_users, host_peer_id, name, allow_first_user_host, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('room-migration', '[]', '{}', 3, null, 'Test Room', 0, now, now);

      applySchema(db);

      const row = db.prepare(
        `SELECT room_id, guest_access, guest_pin, guest_failed_count FROM rooms WHERE room_id = ?`
      ).get('room-migration') as
        | { room_id: string; guest_access: number; guest_pin: string | null; guest_failed_count: number }
        | undefined;

      expect(row).toBeDefined();
      expect(row?.room_id).toBe('room-migration');
      expect(row?.guest_access).toBe(0);
      expect(row?.guest_pin).toBeNull();
      expect(row?.guest_failed_count).toBe(0);
    });

    it('applySchema is idempotent - calling twice does not throw and does not duplicate columns', () => {
      db.exec(`
        CREATE TABLE rooms (
          room_id TEXT PRIMARY KEY,
          elements TEXT NOT NULL DEFAULT '[]',
          viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
          max_users INTEGER NOT NULL DEFAULT 3,
          host_peer_id TEXT,
          name TEXT,
          allow_first_user_host INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      applySchema(db);
      const columnsAfterFirst = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
      const guestAccessCountAfterFirst = columnsAfterFirst.filter((col) => col.name === 'guest_access').length;

      applySchema(db);
      const columnsAfterSecond = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
      const guestAccessCountAfterSecond = columnsAfterSecond.filter((col) => col.name === 'guest_access').length;

      expect(guestAccessCountAfterFirst).toBe(1);
      expect(guestAccessCountAfterSecond).toBe(1);
    });
  });
});

describe('applySchema migrations', () => {
  it('adds every current column to a rooms table that predates them', () => {
    db.exec(`
      CREATE TABLE rooms (
        room_id TEXT PRIMARY KEY,
        elements TEXT NOT NULL DEFAULT '[]',
        viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.prepare(`INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`).run('legacy', 1, 1);

    applySchema(db);

    const columns = (db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    for (const name of [
      'max_users',
      'host_peer_id',
      'name',
      'allow_first_user_host',
      'grant_version',
      'guest_access',
      'guest_pin',
      'guest_pin_expires_at',
      'guest_failed_count',
      'guest_failed_window_at',
      'guest_lockout_until',
      'file_bytes_total',
    ]) {
      expect(columns).toContain(name);
    }
    expect(db.prepare(`SELECT room_id FROM rooms WHERE room_id = ?`).get('legacy')).toBeDefined();
  });

  it('drops the retired room_access and access_requests tables', () => {
    db.exec(`CREATE TABLE room_access (room_id TEXT)`);
    db.exec(`CREATE TABLE access_requests (room_id TEXT)`);

    applySchema(db);

    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
      name: string;
    }>).map((row) => row.name);
    expect(names).not.toContain('room_access');
    expect(names).not.toContain('access_requests');
  });

  it('migrates a legacy room_members table and converts the member role to editor', () => {
    db.exec(`
      CREATE TABLE room_members (
        room_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, account_id)
      )
    `);
    db.prepare(
      `INSERT INTO room_members (room_id, account_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('room-1', 'acct-1', 'member', 1, 1);

    applySchema(db);

    const columns = (db.prepare(`PRAGMA table_info(room_members)`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(columns).toContain('display_name');
    const row = db
      .prepare(`SELECT role, display_name FROM room_members WHERE account_id = ?`)
      .get('acct-1') as { role: string; display_name: string | null };
    expect(row.role).toBe('editor');
    expect(row.display_name).toBeNull();
  });

  it('leaves a current room_members table alone even when a stale migration table exists', () => {
    applySchema(db);
    db.exec(`CREATE TABLE room_members_v2 (room_id TEXT)`);

    expect(() => applySchema(db)).not.toThrow();
  });
});

describe('room schema helpers', () => {
  it('roomExists reflects whether the room row is present', () => {
    applySchema(db);
    expect(roomExists(db, 'missing')).toBe(false);

    db.prepare(`INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`).run('room-1', 1, 1);
    expect(roomExists(db, 'room-1')).toBe(true);
  });

  it('getRoomHostPeerId returns null for a missing row and the stored id otherwise', () => {
    applySchema(db);
    expect(getRoomHostPeerId(db, 'missing')).toBeNull();

    db.prepare(`INSERT INTO rooms (room_id, host_peer_id, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
      'room-1',
      'peer-9',
      1,
      1,
    );
    expect(getRoomHostPeerId(db, 'room-1')).toBe('peer-9');
  });

  it('getGrantVersion defaults to 0 and incrementGrantVersion bumps it', () => {
    applySchema(db);
    expect(getGrantVersion(db, 'missing')).toBe(0);

    db.prepare(`INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`).run('room-1', 1, 1);
    expect(getGrantVersion(db, 'room-1')).toBe(0);
    expect(incrementGrantVersion(db, 'room-1')).toBe(1);
    expect(incrementGrantVersion(db, 'room-1')).toBe(2);
  });

  it('file byte counters add, set, and floor at zero', () => {
    applySchema(db);
    expect(getFileBytesTotal(db, 'missing')).toBe(0);

    db.prepare(`INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`).run('room-1', 1, 1);

    expect(getFileBytesTotal(db, 'room-1')).toBe(0);
    addFileBytes(db, 'room-1', 150);
    expect(getFileBytesTotal(db, 'room-1')).toBe(150);
    subtractFileBytes(db, 'room-1', 50);
    expect(getFileBytesTotal(db, 'room-1')).toBe(100);
    subtractFileBytes(db, 'room-1', 1000);
    expect(getFileBytesTotal(db, 'room-1')).toBe(0);
    setFileBytes(db, 'room-1', 777);
    expect(getFileBytesTotal(db, 'room-1')).toBe(777);
  });

  it('purge keeps a fresh tombstone and drops one older than the tombstone TTL', () => {
    applySchema(db);
    const now = Date.now();
    const fresh = now - 60_000;
    db.prepare(`INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`).run('stale-room', 1, 0);
    db.prepare(`INSERT INTO room_tombstones (room_id, deleted_at) VALUES (?, ?)`).run('fresh', fresh);
    db.prepare(`INSERT INTO room_tombstones (room_id, deleted_at) VALUES (?, ?)`).run(
      'ancient',
      now - 2 * 365 * 24 * 60 * 60 * 1000,
    );

    const purged = purgeExpiredRoomsAndTombstones(db, now);

    expect(purged).toEqual(['stale-room']);
    const freshRow = db
      .prepare(`SELECT deleted_at FROM room_tombstones WHERE room_id = ?`)
      .get('fresh') as { deleted_at: number };
    expect(freshRow.deleted_at).toBe(fresh);
    expect(db.prepare(`SELECT 1 FROM room_tombstones WHERE room_id = ?`).get('ancient')).toBeUndefined();
  });

  it('purge keeps a tombstone that is days old, well inside the tombstone TTL', () => {
    applySchema(db);
    const now = Date.now();
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
    db.prepare(`INSERT INTO room_tombstones (room_id, deleted_at) VALUES (?, ?)`).run('two-days', twoDaysAgo);

    purgeExpiredRoomsAndTombstones(db, now);

    const row = db
      .prepare(`SELECT deleted_at FROM room_tombstones WHERE room_id = ?`)
      .get('two-days') as { deleted_at: number };
    expect(row.deleted_at).toBe(twoDaysAgo);
  });

  it('purge keeps the timestamp of an existing tombstone for a stale room', () => {
    applySchema(db);
    const now = Date.now();
    const recordedAt = now - 60_000;
    db.prepare(`INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`).run('stale-room', 1, 0);
    db.prepare(`INSERT INTO room_tombstones (room_id, deleted_at) VALUES (?, ?)`).run('stale-room', recordedAt);

    purgeExpiredRoomsAndTombstones(db, now);

    const row = db
      .prepare(`SELECT deleted_at FROM room_tombstones WHERE room_id = ?`)
      .get('stale-room') as { deleted_at: number };
    expect(row.deleted_at).toBe(recordedAt);
  });
});

describe('getRoomDb configuration', () => {
  const originalDbPath = process.env.WHITEBOARD_DB_PATH;

  afterEach(() => {
    if (originalDbPath === undefined) {
      delete process.env.WHITEBOARD_DB_PATH;
    } else {
      process.env.WHITEBOARD_DB_PATH = originalDbPath;
    }
    vi.resetModules();
  });

  it('returns one shared in-memory connection with the schema applied', async () => {
    process.env.WHITEBOARD_DB_PATH = ':memory:';
    vi.resetModules();
    const mod = await import('./roomDb');

    const first = mod.getRoomDb();
    const second = mod.getRoomDb();

    expect(second).toBe(first);
    expect(
      first.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rooms'`).get(),
    ).toBeDefined();
  });

  it('opens a file database at the configured path with WAL enabled', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roomdb-file-'));
    const dbPath = path.join(tmp, 'whiteboard.db');
    process.env.WHITEBOARD_DB_PATH = dbPath;
    vi.resetModules();
    const mod = await import('./roomDb');

    const connection = mod.getRoomDb();

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(connection.prepare(`PRAGMA journal_mode`).get()).toEqual({ journal_mode: 'wal' });
  });
});
