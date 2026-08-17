import { describe, it, expect } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { RoomDO } from '../../do/RoomDO';
import type { RoomDatabase } from './db';
import {
  grantAccess,
  findGrant,
  revokeGrant,
  createRequest,
  approveRequest,
  denyRequest,
  purgeExpiredGrants,
} from './access';

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
  it('applySchema creates all six tables', async () => {
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

describe('access.ts against real Durable Object SQLite', () => {
  it('grants, finds, and revokes a grant', async () => {
    const result = await withDb((db) => {
      grantAccess(db, {
        roomId: 'room-1',
        token: 'tok-1',
        role: 'peer',
        userName: 'Ada',
      });
      const found = findGrant(db, 'room-1', 'tok-1');
      const revoked = revokeGrant(db, 'room-1', 'tok-1');
      const afterRevoke = findGrant(db, 'room-1', 'tok-1');
      const revokedAgain = revokeGrant(db, 'room-1', 'tok-1');
      return { found, revoked, afterRevoke, revokedAgain };
    });

    expect(result.found).toMatchObject({ role: 'peer', userName: 'Ada' });
    expect(result.revoked).toBe(true);
    expect(result.afterRevoke).toBeNull();
    // Depends on a correct `changes` of 0.
    expect(result.revokedAgain).toBe(false);
  });

  it('approveRequest moves a request into a grant inside one transaction', async () => {
    const result = await withDb((db) => {
      createRequest(db, {
        roomId: 'room-2',
        requestId: 'req-1',
        token: 'tok-2',
        userName: 'Grace',
      });
      const grant = approveRequest(db, 'room-2', 'req-1', { role: 'peer' });
      return {
        grant,
        found: findGrant(db, 'room-2', 'tok-2'),
        remaining: db
          .prepare(`SELECT COUNT(*) AS n FROM access_requests WHERE room_id = ?`)
          .get('room-2') as { n: number },
      };
    });

    expect(result.grant).toMatchObject({ role: 'peer', userName: 'Grace' });
    expect(result.found).toMatchObject({ role: 'peer', userName: 'Grace' });
    expect(result.remaining.n).toBe(0);
  });

  it('denyRequest reports whether a request was removed', async () => {
    const result = await withDb((db) => {
      createRequest(db, {
        roomId: 'room-3',
        requestId: 'req-2',
        token: 'tok-3',
        userName: 'Alan',
      });
      return {
        denied: denyRequest(db, 'room-3', 'req-2'),
        deniedAgain: denyRequest(db, 'room-3', 'req-2'),
      };
    });

    expect(result.denied).toBe(true);
    expect(result.deniedAgain).toBe(false);
  });

  it('purgeExpiredGrants returns the number of grants removed', async () => {
    const purged = await withDb((db) => {
      grantAccess(db, {
        roomId: 'room-4',
        token: 'expired-1',
        role: 'peer',
        userName: 'A',
        expiresAt: 500,
      });
      grantAccess(db, {
        roomId: 'room-4',
        token: 'expired-2',
        role: 'peer',
        userName: 'B',
        expiresAt: 500,
      });
      grantAccess(db, {
        roomId: 'room-4',
        token: 'live',
        role: 'peer',
        userName: 'C',
        expiresAt: 10_000,
      });
      return purgeExpiredGrants(db, 1_000);
    });

    expect(purged).toBe(2);
  });
});
