import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  MAX_BACKUP_DUE_TARGETS,
  applyBackupRegistrySchema,
  listDueBackupTargets,
  markBackupDone,
  registerBackupTarget,
  type BackupRegistryRow,
} from './identityStore';

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('backup registry store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyBackupRegistrySchema(db);
  });

  function readRow(doClass: string, doId: string): BackupRegistryRow | undefined {
    return db
      .prepare(
        `SELECT do_class AS doClass, do_id AS doId,
                last_backup_at AS lastBackupAt, last_activity_at AS lastActivityAt
         FROM backup_registry WHERE do_class = ? AND do_id = ?`,
      )
      .get(doClass, doId) as BackupRegistryRow | undefined;
  }

  it('creates the registry table idempotently', () => {
    applyBackupRegistrySchema(db);
    applyBackupRegistrySchema(db);
    const columns = db.prepare(`PRAGMA table_info(backup_registry)`).all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      'do_class',
      'do_id',
      'last_backup_at',
      'last_activity_at',
    ]);
  });

  it('registers a room target that has never been backed up', () => {
    registerBackupTarget(db, { doClass: 'rooms', doId: 'room-1', lastActivityAt: T0 });
    expect(readRow('rooms', 'room-1')).toEqual({
      doClass: 'rooms',
      doId: 'room-1',
      lastBackupAt: null,
      lastActivityAt: T0,
    });
  });

  it('refreshes activity and keeps the newer stamp when an older register arrives', () => {
    registerBackupTarget(db, { doClass: 'rooms', doId: 'room-1', lastActivityAt: T0 });
    registerBackupTarget(db, { doClass: 'rooms', doId: 'room-1', lastActivityAt: T0 + 5 });
    expect(readRow('rooms', 'room-1')?.lastActivityAt).toBe(T0 + 5);
    registerBackupTarget(db, { doClass: 'rooms', doId: 'room-1', lastActivityAt: T0 + 1 });
    expect(readRow('rooms', 'room-1')?.lastActivityAt).toBe(T0 + 5);
  });

  it('keeps last_backup_at across register calls', () => {
    registerBackupTarget(db, { doClass: 'rooms', doId: 'room-1', lastActivityAt: T0 });
    markBackupDone(db, { doClass: 'rooms', doId: 'room-1', at: T0 + DAY });
    registerBackupTarget(db, { doClass: 'rooms', doId: 'room-1', lastActivityAt: T0 + DAY + 1 });
    expect(readRow('rooms', 'room-1')).toEqual({
      doClass: 'rooms',
      doId: 'room-1',
      lastBackupAt: T0 + DAY,
      lastActivityAt: T0 + DAY + 1,
    });
  });

  it('marks done even for a row that vanished', () => {
    markBackupDone(db, { doClass: 'rooms', doId: 'room-late', at: T0 });
    expect(readRow('rooms', 'room-late')).toEqual({
      doClass: 'rooms',
      doId: 'room-late',
      lastBackupAt: T0,
      lastActivityAt: T0,
    });
  });

  it('accepts an identity-class target with an opaque id', () => {
    registerBackupTarget(db, { doClass: 'identity', doId: 'global', lastActivityAt: T0 });
    expect(readRow('identity', 'global')).toEqual({
      doClass: 'identity',
      doId: 'global',
      lastBackupAt: null,
      lastActivityAt: T0,
    });
  });

  it('rejects unknown classes with a named error', () => {
    expect(() =>
      registerBackupTarget(db, { doClass: 'files' as never, doId: 'room-1', lastActivityAt: T0 }),
    ).toThrow(/doClass must be "rooms" or "identity"/);
    expect(() =>
      markBackupDone(db, { doClass: 'files' as never, doId: 'room-1', at: T0 }),
    ).toThrow(/doClass must be "rooms" or "identity"/);
  });

  it('rejects malformed doIds with a named error', () => {
    for (const doId of [null as never, 42 as never, '']) {
      expect(() =>
        registerBackupTarget(db, { doClass: 'rooms', doId, lastActivityAt: T0 }),
      ).toThrow(/doId must be a string of 1..128 characters/);
    }
    expect(() =>
      registerBackupTarget(db, { doClass: 'rooms', doId: 'x'.repeat(129), lastActivityAt: T0 }),
    ).toThrow(/doId must be a string of 1..128 characters/);
    expect(() =>
      registerBackupTarget(db, { doClass: 'identity', doId: 'x'.repeat(129), lastActivityAt: T0 }),
    ).toThrow(/doId must be a string of 1..128 characters/);
  });

  it('accepts doIds at the length boundaries and rejects invalid room ids', () => {
    registerBackupTarget(db, { doClass: 'rooms', doId: 'a', lastActivityAt: T0 });
    registerBackupTarget(db, { doClass: 'identity', doId: 'x'.repeat(128), lastActivityAt: T0 });
    expect(readRow('rooms', 'a')).toBeDefined();
    expect(readRow('identity', 'x'.repeat(128))).toBeDefined();

    // 65 characters is beyond ROOM_ID_RE's {1,64}.
    expect(() =>
      registerBackupTarget(db, { doClass: 'rooms', doId: 'x'.repeat(65), lastActivityAt: T0 }),
    ).toThrow(/invalid roomId/);
  });

  it('validates room ids only for the rooms class', () => {
    // Not a valid room id (dots and slashes), but the identity class is not
    // room-scoped, so the registry accepts it.
    const opaque = 'identity/object/name';
    registerBackupTarget(db, { doClass: 'identity', doId: opaque, lastActivityAt: T0 });
    expect(readRow('identity', opaque)).toBeDefined();
  });

  it('rejects non-integer and negative timestamps with a named error', () => {
    for (const lastActivityAt of [-1, 1.5, Number.NaN, 'now' as never]) {
      expect(() =>
        registerBackupTarget(db, { doClass: 'rooms', doId: 'room-1', lastActivityAt }),
      ).toThrow(/lastActivityAt must be a non-negative integer/);
    }
    expect(() =>
      markBackupDone(db, { doClass: 'rooms', doId: 'room-1', at: -1 }),
    ).toThrow(/at must be a non-negative integer/);
    expect(() =>
      markBackupDone(db, { doClass: 'rooms', doId: 'room-1', at: 'x' as never }),
    ).toThrow(/at must be a non-negative integer/);
  });

  it('accepts a timestamp of exactly zero', () => {
    registerBackupTarget(db, { doClass: 'rooms', doId: 'room-zero', lastActivityAt: 0 });
    expect(readRow('rooms', 'room-zero')?.lastActivityAt).toBe(0);
  });

  describe('listDueBackupTargets', () => {
    it('returns never-backed-up active targets', () => {
      registerBackupTarget(db, { doClass: 'rooms', doId: 'room-1', lastActivityAt: T0 - DAY });
      expect(listDueBackupTargets(db, T0)).toEqual([{ doClass: 'rooms', doId: 'room-1' }]);
    });

    it('excludes targets backed up within the cadence and returns stale ones', () => {
      registerBackupTarget(db, { doClass: 'rooms', doId: 'room-fresh', lastActivityAt: T0 - DAY });
      registerBackupTarget(db, { doClass: 'rooms', doId: 'room-stale', lastActivityAt: T0 - DAY });
      markBackupDone(db, { doClass: 'rooms', doId: 'room-fresh', at: T0 - 1000 });
      expect(listDueBackupTargets(db, T0)).toEqual([{ doClass: 'rooms', doId: 'room-stale' }]);
    });

    it('excludes targets idle beyond the retention window', () => {
      registerBackupTarget(db, {
        doClass: 'rooms',
        doId: 'room-idle',
        lastActivityAt: T0 - 91 * DAY,
      });
      expect(listDueBackupTargets(db, T0)).toEqual([]);
    });

    it('orders the due list oldest backup first, then by class and id', () => {
      // Never-backed-up rows sort ahead of any real timestamp, so the most
      // neglected object leads the list.
      registerBackupTarget(db, { doClass: 'rooms', doId: 'room-b', lastActivityAt: T0 - DAY });
      registerBackupTarget(db, { doClass: 'rooms', doId: 'room-a', lastActivityAt: T0 - DAY });
      registerBackupTarget(db, { doClass: 'rooms', doId: 'room-old', lastActivityAt: T0 - DAY });
      markBackupDone(db, { doClass: 'rooms', doId: 'room-old', at: T0 - 5 * DAY });
      expect(listDueBackupTargets(db, T0)).toEqual([
        { doClass: 'rooms', doId: 'room-a' },
        { doClass: 'rooms', doId: 'room-b' },
        { doClass: 'rooms', doId: 'room-old' },
      ]);
    });

    it('caps the due list', () => {
      const insert = db.prepare(
        `INSERT INTO backup_registry (do_class, do_id, last_backup_at, last_activity_at)
         VALUES ('rooms', ?, NULL, ?)`,
      );
      for (let index = 0; index < MAX_BACKUP_DUE_TARGETS + 5; index += 1) {
        insert.run(`room-${String(index).padStart(3, '0')}`, T0 - DAY);
      }
      const due = listDueBackupTargets(db, T0);
      expect(due).toHaveLength(MAX_BACKUP_DUE_TARGETS);
    });

    it('honours an explicit cadence override', () => {
      registerBackupTarget(db, { doClass: 'rooms', doId: 'room-1', lastActivityAt: T0 - DAY });
      markBackupDone(db, { doClass: 'rooms', doId: 'room-1', at: T0 - 500 });
      expect(listDueBackupTargets(db, T0)).toEqual([]);
      expect(listDueBackupTargets(db, T0, { cadenceMs: 400 })).toEqual([
        { doClass: 'rooms', doId: 'room-1' },
      ]);
    });
  });
});
