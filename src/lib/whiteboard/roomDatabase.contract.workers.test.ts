import { describe, it, expect } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { RoomDO } from '../../do/RoomDO';
import type { RoomDatabase } from './db';
import {
  approveAccount,
  getMembership,
  insertOwner,
  requestAccess,
} from './membership';

declare global {
  namespace Cloudflare {
    interface Env {
      ROOMS: DurableObjectNamespace<RoomDO>;
    }
  }
}

let roomCounter = 0;

/** Runs `fn` against a freshly-created Durable Object's real SQLite storage. */
async function withDb<T>(fn: (db: RoomDatabase) => T): Promise<T> {
  const id = env.ROOMS.idFromName(`contract-${roomCounter++}`);
  const stub = env.ROOMS.get(id);
  return runInDurableObject(stub, (instance) => fn(instance.db));
}

describe('RoomDatabase contract on real Durable Object SQLite', () => {
  it('applySchema creates the room tables', async () => {
    const tables = await withDb((db) =>
      (db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
        )
        .all() as Array<{ name: string }>).map((r) => r.name),
    );

    for (const table of [
      'access_requests',
      'kicked_peers',
      'room_access',
      'room_members',
      'room_presence',
      'rooms',
      'waiting_peers',
    ]) {
      expect(tables).toContain(table);
    }
  });

  it('supports PRAGMA table_info, which applySchema depends on', async () => {
    const columns = await withDb(
      (db) => db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>,
    );

    expect(columns.length).toBeGreaterThan(0);
    expect(columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(['room_id', 'max_users', 'host_peer_id', 'name']),
    );
  });

  it('get returns undefined when no row matches', async () => {
    const row = await withDb((db) =>
      db.prepare(`SELECT room_id FROM rooms WHERE room_id = ?`).get('absent'),
    );
    expect(row).toBeUndefined();
  });

  it('get returns the matching row', async () => {
    const row = await withDb((db) => {
      db.prepare(
        `INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`,
      ).run('r1', 1, 1);
      return db.prepare(`SELECT room_id FROM rooms WHERE room_id = ?`).get('r1');
    });
    expect(row).toMatchObject({ room_id: 'r1' });
  });

  it('all returns [] with no matches and every row otherwise', async () => {
    const { empty, filled } = await withDb((db) => {
      const empty = db.prepare(`SELECT room_id FROM rooms`).all();
      db.prepare(
        `INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`,
      ).run('a', 1, 1);
      db.prepare(
        `INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`,
      ).run('b', 1, 1);
      return { empty, filled: db.prepare(`SELECT room_id FROM rooms`).all() };
    });

    expect(empty).toEqual([]);
    expect(filled).toHaveLength(2);
  });

  // The case that catches a rowsWritten-based implementation.
  it('run reports the true changed-row count, including zero', async () => {
    const { insert, deletedNone, deletedTwo } = await withDb((db) => {
      const insert = db
        .prepare(`INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`)
        .run('keep', 1, 1);

      db.prepare(
        `INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`,
      ).run('gone1', 1, 1);
      db.prepare(
        `INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`,
      ).run('gone2', 1, 1);

      const deletedNone = db
        .prepare(`DELETE FROM rooms WHERE room_id = ?`)
        .run('never-existed');
      const deletedTwo = db
        .prepare(`DELETE FROM rooms WHERE room_id IN ('gone1','gone2')`)
        .run();

      return { insert, deletedNone, deletedTwo };
    });

    expect(insert.changes).toBe(1);
    expect(deletedNone.changes).toBe(0);
    expect(deletedTwo.changes).toBe(2);
  });

  it('transaction commits on success', async () => {
    const count = await withDb((db) => {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`,
        ).run('committed', 1, 1);
      })();
      return (
        db.prepare(`SELECT COUNT(*) AS n FROM rooms`).get() as { n: number }
      ).n;
    });
    expect(count).toBe(1);
  });

  it('transaction rolls back when the callback throws', async () => {
    const count = await withDb((db) => {
      expect(() =>
        db.transaction(() => {
          db.prepare(
            `INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`,
          ).run('rolled-back', 1, 1);
          throw new Error('boom');
        })(),
      ).toThrow('boom');

      return (
        db.prepare(`SELECT COUNT(*) AS n FROM rooms`).get() as { n: number }
      ).n;
    });
    expect(count).toBe(0);
  });
});

describe('membership against real Durable Object SQLite', () => {
  it('stores one grant per account and never both pending and editor', async () => {
    const result = await withDb((db) => {
      requestAccess(db, { roomId: 'room-1', accountId: 'acc-1', userName: 'Ada' });
      const granted = approveAccount(db, 'room-1', 'acc-1', { role: 'editor' });
      const rows = db
        .prepare(`SELECT role FROM room_members WHERE room_id = ? AND account_id = ?`)
        .all('room-1', 'acc-1') as Array<{ role: string }>;
      return { granted: granted?.role, rows };
    });

    expect(result.granted).toBe('editor');
    expect(result.rows).toEqual([{ role: 'editor' }]);
  });

  it('approveAccount is a no-op when the account is not pending', async () => {
    const result = await withDb((db) => {
      insertOwner(db, 'room-2', 'owner', 1);
      return {
        missing: approveAccount(db, 'room-2', 'nobody', { role: 'editor' }),
        owner: getMembership(db, 'room-2', 'owner')?.role,
      };
    });

    expect(result.missing).toBeNull();
    expect(result.owner).toBe('owner');
  });

  it('requestAccess after ban does not insert a pending row', async () => {
    const result = await withDb((db) => {
      requestAccess(db, { roomId: 'room-3', accountId: 'acc-3', userName: 'Alan' });
      db.prepare(`UPDATE room_members SET role = 'banned' WHERE room_id = ? AND account_id = ?`)
        .run('room-3', 'acc-3');
      const again = requestAccess(db, { roomId: 'room-3', accountId: 'acc-3', userName: 'Alan' });
      return {
        again,
        role: getMembership(db, 'room-3', 'acc-3')?.role,
      };
    });

    expect(result.again).toEqual({ ok: false, reason: 'banned' });
    expect(result.role).toBe('banned');
  });
});
