import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  BACKUP_BLOB_PREFIX,
  BACKUP_CADENCE_MS,
  BACKUP_VERSION,
  BackupError,
  BackupRestoreError,
  backupObjectKey,
  isBackupDue,
  parseBackupsEnabled,
  restoreBackup,
  serializeBackup,
  ROOM_BACKUP_TABLES,
  type BackupDump,
} from './backup';
import { ROOM_IDLE_TTL_MS, ROOM_SCOPED_TABLES, applySchema } from '../whiteboard/roomSchema';
import type { RoomDatabase } from '../whiteboard/db';

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('pinned constants', () => {
  it('uses the documented literal values', () => {
    expect(BACKUP_VERSION).toBe(1);
    expect(BACKUP_CADENCE_MS).toBe(86_400_000);
    expect(BACKUP_BLOB_PREFIX).toBe('base64:');
    expect(ROOM_IDLE_TTL_MS).toBe(90 * DAY);
  });
});

describe('isBackupDue', () => {
  it('is due when the object was never backed up and is still active', () => {
    expect(isBackupDue(null, T0 - DAY, T0)).toBe(true);
  });

  it('is due exactly 24h after the last backup (literal boundary)', () => {
    expect(isBackupDue(T0 - 86_400_000, T0 - DAY, T0)).toBe(true);
  });

  it('is not due one millisecond before the 24h boundary', () => {
    expect(isBackupDue(T0 - 86_399_999, T0 - DAY, T0)).toBe(false);
  });

  it('is not due when activity is exactly at the 90-day retention boundary', () => {
    expect(isBackupDue(null, T0 - 90 * DAY, T0)).toBe(false);
  });

  it('is due when activity is one millisecond inside the retention window', () => {
    expect(isBackupDue(T0 - 86_400_000, T0 - 90 * DAY + 1, T0)).toBe(true);
  });

  it('refuses stale rooms even when they were never backed up', () => {
    expect(isBackupDue(null, T0 - 91 * DAY, T0)).toBe(false);
  });

  it('honours explicit window overrides', () => {
    expect(isBackupDue(T0 - 500, T0 - 10, T0, { windowMs: 500 })).toBe(true);
    expect(isBackupDue(T0 - 500, T0 - 10, T0, { windowMs: 501 })).toBe(false);
    expect(isBackupDue(null, T0 - 100, T0, { activityWindowMs: 100 })).toBe(false);
    expect(isBackupDue(null, T0 - 99, T0, { activityWindowMs: 100 })).toBe(true);
  });

  it('is due when never backed up even for a clock near zero', () => {
    expect(isBackupDue(null, 50, 100)).toBe(true);
  });
});

describe('backupObjectKey', () => {
  it('names the object after the class, id, and ISO timestamp', () => {
    const createdAt = Date.UTC(2026, 0, 2, 3, 4, 5, 6);
    expect(backupObjectKey('rooms', 'room-abc', createdAt)).toBe(
      'backups/rooms/room-abc/2026-01-02T03:04:05.006Z.json',
    );
    expect(backupObjectKey('identity', 'global', createdAt)).toBe(
      'backups/identity/global/2026-01-02T03:04:05.006Z.json',
    );
  });
});

describe('parseBackupsEnabled', () => {
  it('defaults to enabled when unset or unrecognised (fail-open)', () => {
    for (const raw of [undefined, '', 'yes', 'enabled', 'ON', 'True', '1']) {
      expect(parseBackupsEnabled(raw), JSON.stringify(raw)).toBe(true);
    }
  });

  it('disables only on the explicit kill switches', () => {
    for (const raw of ['off', 'false', '0', 'OFF', 'False']) {
      expect(parseBackupsEnabled(raw), JSON.stringify(raw)).toBe(false);
    }
  });
});

describe('serializeBackup over the room schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db as unknown as RoomDatabase);
  });

  function seedRoom(roomId: string): void {
    db.prepare(
      `INSERT INTO rooms (
         room_id, elements, viewport, max_users, host_peer_id, name,
         allow_first_user_host, created_at, updated_at, grant_version,
         guest_access, guest_pin, guest_pin_expires_at, guest_failed_count,
         guest_failed_window_at, guest_lockout_until, file_bytes_total
       ) VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?, 2, 0, NULL, NULL, 0, NULL, NULL, 0)`,
    ).run(roomId, '[]', '{"x":1,"y":2,"zoom":3}', 5, 'Algebra', T0, T0 + 1);
    db.prepare(
      `INSERT INTO room_members (
         room_id, account_id, role, display_name, email,
         requested_at, created_at, updated_at, expires_at
       ) VALUES (?, ?, 'owner', 'Teacher', 't@example.test', NULL, ?, ?, NULL)`,
    ).run(roomId, 'account-1', T0, T0 + 2);
    db.prepare(
      `INSERT INTO room_members (
         room_id, account_id, role, display_name, email,
         requested_at, created_at, updated_at, expires_at
       ) VALUES (?, ?, 'editor', NULL, NULL, ?, ?, ?, ?)`,
    ).run(roomId, 'account-2', T0, T0 + 3, T0 + 4, T0 + 5);
    db.prepare(
      `INSERT INTO room_presence (
         room_id, peer_id, user_name, color, first_seen, last_seen,
         hand_raised, account_id
       ) VALUES (?, ?, 'Teacher', '#ff0000', ?, ?, 1, NULL)`,
    ).run(roomId, 'peer-1', T0, T0 + 6);
  }

  function snapshotRows(database: Database.Database): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const table of ROOM_BACKUP_TABLES) {
      out[table] = database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
    }
    return out;
  }

  it('dumps the pinned table list in order with version 1', () => {
    seedRoom('room-1');
    const dump = serializeBackup(db as unknown as RoomDatabase, ROOM_BACKUP_TABLES);
    expect(dump.version).toBe(BACKUP_VERSION);
    expect(typeof dump.createdAt).toBe('number');
    expect(dump.tables.map((table) => table.name)).toEqual([
      'rooms',
      'room_presence',
      'waiting_peers',
      'kicked_peers',
      'room_members',
    ]);
  });

  it('keeps ROOM_SCOPED_TABLES fully covered exactly once each', () => {
    expect(new Set(ROOM_BACKUP_TABLES).size).toBe(ROOM_BACKUP_TABLES.length);
    for (const table of ROOM_SCOPED_TABLES) {
      expect(ROOM_BACKUP_TABLES).toContain(table);
    }
  });

  it('round-trips every row and column losslessly, including NULLs', () => {
    seedRoom('room-1');
    const before = snapshotRows(db);
    const dump = serializeBackup(db as unknown as RoomDatabase, ROOM_BACKUP_TABLES);

    for (const table of ROOM_BACKUP_TABLES) {
      db.prepare(`DELETE FROM "${table}"`).run();
    }
    restoreBackup(db as unknown as RoomDatabase, dump);

    expect(snapshotRows(db)).toEqual(before);
    const rooms = db.prepare(`SELECT * FROM rooms`).all() as Array<Record<string, unknown>>;
    expect(rooms[0].host_peer_id).toBeNull();
    expect(rooms[0].elements).toBe('[]');
    expect(rooms[0].file_bytes_total).toBe(0);
    const presence = db.prepare(`SELECT * FROM room_presence`).all() as Array<Record<string, unknown>>;
    expect(presence[0].account_id).toBeNull();
    expect(presence[0].hand_raised).toBe(1);
  });

  it('restores an empty schema to row parity with the source (rehearsal shape)', () => {
    seedRoom('room-src');
    const dump = serializeBackup(db as unknown as RoomDatabase, ROOM_BACKUP_TABLES);
    const before = snapshotRows(db);

    const fresh = new Database(':memory:');
    applySchema(fresh as unknown as RoomDatabase);
    restoreBackup(fresh as unknown as RoomDatabase, dump);

    expect(snapshotRows(fresh)).toEqual(before);
  });

  it('is deterministic for unchanged data', () => {
    seedRoom('room-1');
    const first = serializeBackup(db as unknown as RoomDatabase, ROOM_BACKUP_TABLES);
    const second = serializeBackup(db as unknown as RoomDatabase, ROOM_BACKUP_TABLES);
    expect(first.tables).toEqual(second.tables);
    expect(JSON.stringify({ ...first, createdAt: 0 })).toBe(JSON.stringify({ ...second, createdAt: 0 }));
  });

  it('orders rows by primary key even when inserted in reverse rowid order', () => {
    // room-2 gets the lower rowid, so a rowid-order mutant would flip the dump.
    db.prepare(
      `INSERT INTO rooms (room_id, created_at, updated_at) VALUES ('room-2', ?, ?)`,
    ).run(T0, T0);
    db.prepare(
      `INSERT INTO rooms (room_id, created_at, updated_at) VALUES ('room-1', ?, ?)`,
    ).run(T0, T0);
    const dump = serializeBackup(db as unknown as RoomDatabase, ['rooms']);
    expect(dump.tables[0].rows.map((row) => row.room_id)).toEqual(['room-1', 'room-2']);
  });

  it('orders composite primary keys by every key column in key order', () => {
    seedRoom('room-1');
    // The room order and the peer order disagree, so a dump ordered by either
    // single column alone cannot satisfy this assertion.
    db.prepare(
      `INSERT INTO room_presence (
         room_id, peer_id, user_name, color, first_seen, last_seen
       ) VALUES (?, ?, 'B', '#123456', ?, ?)`,
    ).run('room-b', 'peer-a', T0, T0);
    db.prepare(
      `INSERT INTO room_presence (
         room_id, peer_id, user_name, color, first_seen, last_seen
       ) VALUES (?, ?, 'A', '#654321', ?, ?)`,
    ).run('room-a', 'peer-b', T0, T0);
    const dump = serializeBackup(db as unknown as RoomDatabase, ['room_presence']);
    expect(
      dump.tables[0].rows.map((row) => [row.room_id, row.peer_id]),
    ).toEqual([
      ['room-1', 'peer-1'],
      ['room-a', 'peer-b'],
      ['room-b', 'peer-a'],
    ]);
  });

  it('falls back to rowid order for a table without a primary key', () => {
    db.exec(`CREATE TABLE loose (a TEXT, b TEXT)`);
    db.prepare(`INSERT INTO loose (a, b) VALUES ('second', 'row')`).run();
    db.prepare(`INSERT INTO loose (a, b) VALUES ('first', 'row')`).run();
    const dump = serializeBackup(db as unknown as RoomDatabase, ['loose']);
    expect(dump.tables[0].rows.map((row) => row.a)).toEqual(['second', 'first']);
  });

  it('orders composite keys by key position even when declared after other columns', () => {
    // cid order is (b, a) but the key order is (a, b); a dropped or mis-keyed
    // sort would emit ORDER BY b, a and flip this dump.
    db.exec(`CREATE TABLE rev (b TEXT, a TEXT, PRIMARY KEY (a, b))`);
    db.prepare(`INSERT INTO rev (b, a) VALUES ('z', 'x')`).run();
    db.prepare(`INSERT INTO rev (b, a) VALUES ('a', 'y')`).run();
    const dump = serializeBackup(db as unknown as RoomDatabase, ['rev']);
    expect(dump.tables[0].rows.map((row) => row.a)).toEqual(['x', 'y']);
  });

  it('orders rows by the primary key columns', () => {
    seedRoom('room-1');
    seedRoom('room-2');
    const dump = serializeBackup(db as unknown as RoomDatabase, ROOM_BACKUP_TABLES);
    const roomRows = dump.tables.find((table) => table.name === 'rooms')!;
    expect(roomRows.rows.map((row) => row.room_id)).toEqual(['room-1', 'room-2']);
    // room_members keys on (room_id, account_id), so both orders apply.
    const memberRows = dump.tables.find((table) => table.name === 'room_members')!;
    expect(
      memberRows.rows.map((row) => [row.room_id, row.account_id]),
    ).toEqual([
      ['room-1', 'account-1'],
      ['room-1', 'account-2'],
      ['room-2', 'account-1'],
      ['room-2', 'account-2'],
    ]);
  });

  it('carries empty tables through the dump', () => {
    seedRoom('room-1');
    const dump = serializeBackup(db as unknown as RoomDatabase, ROOM_BACKUP_TABLES);
    const waiting = dump.tables.find((table) => table.name === 'waiting_peers')!;
    expect(waiting.rows).toEqual([]);
  });

  it('refuses to serialize an unknown table with the named error', () => {
    const thrown = (() => {
      try {
        serializeBackup(db as unknown as RoomDatabase, ['not_a_table']);
        return null;
      } catch (error) {
        return error as BackupError;
      }
    })();
    expect(thrown).toBeInstanceOf(BackupError);
    expect(thrown?.name).toBe('BackupError');
    expect(thrown?.message).toContain('not_a_table');
  });
});

describe('restoreBackup guards', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db as unknown as RoomDatabase);
  });

  function seedRoom(roomId: string): void {
    db.prepare(
      `INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`,
    ).run(roomId, T0, T0);
  }

  it('refuses a dump with a foreign version, naming the error class', () => {
    seedRoom('room-1');
    const dump = { ...serializeBackup(db as unknown as RoomDatabase, ROOM_BACKUP_TABLES), version: 999 };
    const thrown = (() => {
      try {
        restoreBackup(db as unknown as RoomDatabase, dump as never);
        return null;
      } catch (error) {
        return error as BackupRestoreError;
      }
    })();
    expect(thrown).toBeInstanceOf(BackupRestoreError);
    expect(thrown?.name).toBe('BackupRestoreError');
    expect(thrown?.message).toContain('unsupported backup version');
  });

  it('refuses every malformed dump shape with a diagnostic message', () => {
    const cases: Array<[unknown, string]> = [
      [null, 'not an object'],
      [42, 'not an object'],
      [[], 'not an object'],
      [{ version: 1, createdAt: 0 }, 'tables must be an array'],
      [{ version: 1, createdAt: 0, tables: {} }, 'tables must be an array'],
      [{ version: 1, createdAt: 0, tables: [null] }, 'table without a name'],
      [{ version: 1, createdAt: 0, tables: [undefined] }, 'table without a name'],
      [{ version: 1, createdAt: 0, tables: [{}] }, 'table without a name'],
      [{ version: 1, createdAt: 0, tables: [42] }, 'table without a name'],
      [{ version: 1, createdAt: 0, tables: [{ name: 'rooms', rows: 'no' }] }, 'must be an array'],
    ];
    for (const [dump, message] of cases) {
      expect(() => restoreBackup(db as unknown as RoomDatabase, dump as never), message)
        .toThrow(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('refuses rows that are not objects', () => {
    const dump: BackupDump = {
      version: BACKUP_VERSION,
      createdAt: T0,
      tables: [{ name: 'rooms', rows: [null as never] }],
    };
    expect(() => restoreBackup(db as unknown as RoomDatabase, dump))
      .toThrow(/row in rooms is not an object/);

    const numericRow: BackupDump = {
      version: BACKUP_VERSION,
      createdAt: T0,
      tables: [{ name: 'rooms', rows: [42 as never] }],
    };
    expect(() => restoreBackup(db as unknown as RoomDatabase, numericRow))
      .toThrow(/row in rooms is not an object/);
  });

  it('skips empty rows without crashing', () => {
    const dump: BackupDump = {
      version: BACKUP_VERSION,
      createdAt: T0,
      tables: [{ name: 'rooms', rows: [{}] }],
    };
    restoreBackup(db as unknown as RoomDatabase, dump);
    // The empty row inserted nothing after the delete cleared the table.
    const survivors = db.prepare(`SELECT room_id FROM rooms`).all();
    expect(survivors).toEqual([]);
  });

  it('refuses an unknown table and leaves the database untouched (atomic rollback)', () => {
    seedRoom('room-1');
    const dump: BackupDump = {
      version: BACKUP_VERSION,
      createdAt: T0,
      tables: [
        { name: 'rooms', rows: [] },
        { name: 'nope', rows: [] },
      ],
    };
    expect(() => restoreBackup(db as unknown as RoomDatabase, dump))
      .toThrow(/cannot restore unknown table/);
    const survivors = db.prepare(`SELECT COUNT(*) AS n FROM rooms`).get() as { n: number };
    expect(survivors.n).toBe(1);
  });

  it('restores a backup taken before the document tables were retired', () => {
    seedRoom('room-1');
    const current = serializeBackup(db as unknown as RoomDatabase, ROOM_BACKUP_TABLES);
    const legacy: BackupDump = {
      ...current,
      tables: [
        ...current.tables,
        { name: 'room_documents', rows: [] },
        { name: 'room_document_jobs', rows: [] },
      ],
    };
    const fresh = new Database(':memory:');
    applySchema(fresh as unknown as RoomDatabase);
    restoreBackup(fresh as unknown as RoomDatabase, legacy);
    const restored = fresh.prepare(`SELECT room_id FROM rooms`).all();
    expect(restored).toEqual([{ room_id: 'room-1' }]);
  });

  it('refuses a retired document table that still carries rows', () => {
    seedRoom('room-1');
    const dump: BackupDump = {
      version: BACKUP_VERSION,
      createdAt: T0,
      tables: [
        { name: 'rooms', rows: [] },
        { name: 'room_documents', rows: [{ document_id: 'doc-1' }] },
      ],
    };
    expect(() => restoreBackup(db as unknown as RoomDatabase, dump))
      .toThrow(/cannot restore retired table "room_documents" with rows/);
    const survivors = db.prepare(`SELECT COUNT(*) AS n FROM rooms`).get() as { n: number };
    expect(survivors.n).toBe(1);
  });

  it('refuses rows naming unknown columns', () => {
    const dump: BackupDump = {
      version: BACKUP_VERSION,
      createdAt: T0,
      tables: [{ name: 'rooms', rows: [{ room_id: 'room-1', not_a_column: 1 }] }],
    };
    expect(() => restoreBackup(db as unknown as RoomDatabase, dump))
      .toThrow(/cannot restore unknown column/);
  });

  it('handles table and column names containing double quotes', () => {
    db.exec(`CREATE TABLE "we""ird" ("co""l" TEXT PRIMARY KEY)`);
    db.prepare(`INSERT INTO "we""ird" ("co""l") VALUES ('v')`).run();
    const dump = serializeBackup(db as unknown as RoomDatabase, ['we"ird']);
    expect(dump.tables[0].rows).toEqual([{ 'co"l': 'v' }]);

    restoreBackup(db as unknown as RoomDatabase, dump);
    expect(
      db.prepare(`SELECT "co""l" AS c FROM "we""ird"`).all(),
    ).toEqual([{ c: 'v' }]);
  });

  it('replaces existing rows instead of merging', () => {
    seedRoom('room-1');
    const dump: BackupDump = {
      version: BACKUP_VERSION,
      createdAt: T0,
      tables: [
        { name: 'rooms', rows: [{ room_id: 'room-restored', created_at: T0, updated_at: T0 }] },
      ],
    };
    restoreBackup(db as unknown as RoomDatabase, dump);
    const ids = db.prepare(`SELECT room_id FROM rooms`).all() as Array<{ room_id: string }>;
    expect(ids).toEqual([{ room_id: 'room-restored' }]);
  });
});

describe('blob column round-trip', () => {
  it('encodes and decodes binary values through the documented marker', () => {
    const db = new Database(':memory:');
    // Lowercase declared type on purpose: the marker matcher must normalise
    // the column type, not string-compare it.
    db.exec(`CREATE TABLE blobby (id TEXT PRIMARY KEY, payload blob)`);
    const bytes = new Uint8Array([0, 1, 2, 250, 254, 255]);
    db.prepare(`INSERT INTO blobby (id, payload) VALUES ('b1', ?)`).run(Buffer.from(bytes));

    const dump = serializeBackup(db as unknown as RoomDatabase, ['blobby']);
    const encoded = dump.tables[0].rows[0].payload as string;
    expect(encoded.startsWith(BACKUP_BLOB_PREFIX)).toBe(true);

    const fresh = new Database(':memory:');
    fresh.exec(`CREATE TABLE blobby (id TEXT PRIMARY KEY, payload blob)`);
    restoreBackup(fresh as unknown as RoomDatabase, dump);

    const restored = fresh.prepare(`SELECT payload FROM blobby WHERE id = 'b1'`).get() as {
      payload: Buffer;
    };
    expect(new Uint8Array(restored.payload)).toEqual(bytes);
  });

  it('leaves plain text alone in typed TEXT columns', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE texts (id TEXT PRIMARY KEY, note TEXT)`);
    db.prepare(`INSERT INTO texts (id, note) VALUES ('t1', ?)`).run('plain note');
    const dump = serializeBackup(db as unknown as RoomDatabase, ['texts']);
    expect(dump.tables[0].rows[0].note).toBe('plain note');
  });

  it('never decodes marker-shaped text out of a typed TEXT column', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE texts (id TEXT PRIMARY KEY, note TEXT)`);
    // Valid base64 after the prefix: a decode-happy mutant would mangle this.
    db.prepare(`INSERT INTO texts (id, note) VALUES ('t1', ?)`).run('base64:QUJD');
    const dump = serializeBackup(db as unknown as RoomDatabase, ['texts']);

    const fresh = new Database(':memory:');
    fresh.exec(`CREATE TABLE texts (id TEXT PRIMARY KEY, note TEXT)`);
    restoreBackup(fresh as unknown as RoomDatabase, dump);
    expect((fresh.prepare(`SELECT note FROM texts`).get() as { note: string }).note).toBe(
      'base64:QUJD',
    );
  });

  it('round-trips binary values larger than one base64 chunk', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE blobby (id TEXT PRIMARY KEY, payload BLOB)`);
    const bytes = new Uint8Array(40_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
    db.prepare(`INSERT INTO blobby (id, payload) VALUES ('b1', ?)`).run(Buffer.from(bytes));

    const dump = serializeBackup(db as unknown as RoomDatabase, ['blobby']);
    const fresh = new Database(':memory:');
    fresh.exec(`CREATE TABLE blobby (id TEXT PRIMARY KEY, payload BLOB)`);
    restoreBackup(fresh as unknown as RoomDatabase, dump);
    const restored = fresh.prepare(`SELECT payload FROM blobby`).get() as { payload: Buffer };
    expect(new Uint8Array(restored.payload)).toEqual(bytes);
  });
});
