import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from './roomDb';
import {
  approveAccount,
  banAccount,
  effectiveRole,
  getGrantRole,
  getMembership,
  insertOwner,
  purgeExpiredGrants,
  purgeExpiredRoomLifecycle,
  KICKED_PEER_TTL_MS,
  WAITING_REQUEST_TTL_MS,
  requestAccess,
  resolveModerationTarget,
  enqueueWaitingPeer,
  eraseAccountFromRoom,
} from './membership';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('room membership state machine', () => {
  it('cannot store pending and granted for the same account', () => {
    requestAccess(db, { roomId: 'r', accountId: 'a1', userName: 'Ada' });
    const granted = approveAccount(db, 'r', 'a1', { role: 'editor' });
    expect(granted?.role).toBe('editor');

    const rows = db.prepare(
      `SELECT role FROM room_members WHERE room_id = ? AND account_id = ?`,
    ).all('r', 'a1') as Array<{ role: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('editor');
    expect(effectiveRole(getMembership(db, 'r', 'a1'))).toBe('editor');
  });

  it('keeps a single owner when insertOwner races with itself', () => {
    db.transaction(() => {
      db.prepare(`INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`).run('r', 1, 1);
      insertOwner(db, 'r', 'owner-a', 1);
    })();
    insertOwner(db, 'r', 'owner-a', 2);

    const rows = db.prepare(`SELECT account_id, role FROM room_members WHERE room_id = ?`).all('r') as Array<{
      account_id: string;
      role: string;
    }>;
    expect(rows).toEqual([{ account_id: 'owner-a', role: 'owner' }]);
  });

  it('rejects insertOwner for a second account without replacing the owner', () => {
    db.prepare(`INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`).run('r', 1, 1);
    insertOwner(db, 'r', 'owner-a', 1);

    expect(() => insertOwner(db, 'r', 'owner-b', 2)).toThrow();

    const rows = db.prepare(`SELECT account_id, role FROM room_members WHERE room_id = ?`).all('r') as Array<{
      account_id: string;
      role: string;
    }>;
    expect(rows).toEqual([{ account_id: 'owner-a', role: 'owner' }]);
  });

  it('does not promote an account that was never pending', () => {
    insertOwner(db, 'r', 'owner', 1);
    expect(approveAccount(db, 'r', 'owner', { role: 'editor' })).toBeNull();
    expect(approveAccount(db, 'r', 'missing', { role: 'viewer' })).toBeNull();
    expect(getMembership(db, 'r', 'owner')?.role).toBe('owner');
  });

  it('refuses a new request after ban, including a later requestAccess call', () => {
    requestAccess(db, { roomId: 'r', accountId: 'a1', userName: 'Ada' });
    banAccount(db, 'r', 'a1');
    const again = requestAccess(db, { roomId: 'r', accountId: 'a1', userName: 'Ada' });
    expect(again).toEqual({ ok: false, reason: 'banned' });
    expect(getMembership(db, 'r', 'a1')?.role).toBe('banned');
  });

  it('does not select request PII when resolving a grant role', () => {
    requestAccess(db, { roomId: 'r', accountId: 'a1', userName: 'Ada', email: 'ada@example.com' });
    expect(getGrantRole(db, 'r', 'a1')).toBe('pending');
    expect(getGrantRole(db, 'r', 'missing')).toBeNull();
  });

  it('does not promote from a mismatched peerId and accountId', () => {
    insertOwner(db, 'r', 'owner', 1);
    requestAccess(db, { roomId: 'r', accountId: 'a1', userName: 'Ada' });
    requestAccess(db, { roomId: 'r', accountId: 'a2', userName: 'Bob' });
    db.prepare(
      `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
       VALUES ('r', 'peer-a1', 'Ada', '#111111', 1, 'a1')`,
    ).run();

    const mismatch = resolveModerationTarget(db, 'r', { peerId: 'peer-a1', accountId: 'a2' });
    expect(mismatch).toEqual({
      ok: false,
      status: 409,
      error: 'peerId does not match account',
    });

    const byPeer = resolveModerationTarget(db, 'r', { peerId: 'peer-a1' });
    expect(byPeer).toEqual({ ok: true, accountId: 'a1', peerId: 'peer-a1' });

    const byAccount = resolveModerationTarget(db, 'r', { accountId: 'a1' });
    expect(byAccount).toEqual({ ok: true, accountId: 'a1', peerId: null });

    // Presence rows come and go (admission, re-queue, reconnect), so a host can
    // hold a peerId that no longer resolves. The account is the real target, so
    // a stale label must not 404 the whole moderation call.
    const stalePeerKnownAccount = resolveModerationTarget(db, 'r', {
      peerId: 'peer-long-gone',
      accountId: 'a1',
    });
    expect(stalePeerKnownAccount).toEqual({ ok: true, accountId: 'a1', peerId: null });

    // A stale peerId with nothing to fall back on is still a 404.
    expect(resolveModerationTarget(db, 'r', { peerId: 'peer-long-gone' })).toEqual({
      ok: false,
      status: 404,
      error: 'Peer not bound to an account',
    });
  });

  it('purges expired editor rows only for the given room', () => {
    const now = 10_000;
    const insertMember = (
      roomId: string,
      accountId: string,
      role: string,
      expiresAt: number | null,
    ) => {
      db.prepare(
        `INSERT INTO room_members (
           room_id, account_id, role, display_name, email,
           requested_at, created_at, updated_at, expires_at
         ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      ).run(roomId, accountId, role, 1, 1, expiresAt);
    };

    insertMember('r1', 'expired-editor', 'editor', now - 1);
    insertMember('r1', 'fresh-editor', 'editor', now + 1);
    insertMember('r1', 'owner', 'owner', now - 1);
    insertMember('r1', 'viewer', 'viewer', now - 1);
    insertMember('r1', 'banned', 'banned', now - 1);
    insertMember('r1', 'pending', 'pending', now - 1);
    insertMember('r2', 'other-expired-editor', 'editor', now - 1);

    purgeExpiredGrants(db, 'r1', now);

    const roles = db.prepare(
      `SELECT room_id AS roomId, account_id AS accountId, role
       FROM room_members ORDER BY room_id, account_id`,
    ).all() as Array<{ roomId: string; accountId: string; role: string }>;

    expect(roles).toEqual([
      { roomId: 'r1', accountId: 'banned', role: 'banned' },
      { roomId: 'r1', accountId: 'fresh-editor', role: 'editor' },
      { roomId: 'r1', accountId: 'owner', role: 'owner' },
      { roomId: 'r1', accountId: 'pending', role: 'pending' },
      { roomId: 'r1', accountId: 'viewer', role: 'viewer' },
      { roomId: 'r2', accountId: 'other-expired-editor', role: 'editor' },
    ]);
    expect(getMembership(db, 'r1', 'expired-editor')).toBeNull();
    expect(getMembership(db, 'r1', 'fresh-editor')?.role).toBe('editor');
  });

  it('rejects a new requestAccess after pending rows reach the room maxUsers cap', () => {
    db.prepare(
      `INSERT INTO rooms (room_id, created_at, updated_at, max_users) VALUES (?, 1, 1, 3)`,
    ).run('r');

    for (let i = 1; i <= 3; i += 1) {
      const result = requestAccess(db, { roomId: 'r', accountId: `a${i}`, userName: `User${i}` });
      expect(result).toMatchObject({ ok: true, status: 'pending' });
    }

    const overflow = requestAccess(db, { roomId: 'r', accountId: 'a4', userName: 'Overflow' });
    expect(overflow).toEqual({ ok: false, reason: 'queue_full' });

    const pending = db.prepare(
      `SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND role = 'pending'`,
    ).get('r') as { n: number };
    expect(pending.n).toBe(3);
    expect(getMembership(db, 'r', 'a4')).toBeNull();
  });

  it('rejects a new waiting_peers row after pending waiters reach the room maxUsers cap', () => {
    db.prepare(
      `INSERT INTO rooms (room_id, created_at, updated_at, max_users) VALUES (?, 1, 1, 2)`,
    ).run('r');
    for (let i = 1; i <= 2; i += 1) {
      db.prepare(
        `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
         VALUES ('r', ?, ?, '#111111', 1, ?)`,
      ).run(`peer-${i}`, `Wait${i}`, `w${i}`);
    }

    const overflowAccess = requestAccess(db, { roomId: 'r', accountId: 'a-new', userName: 'New' });
    expect(overflowAccess).toEqual({ ok: false, reason: 'queue_full' });
    expect(getMembership(db, 'r', 'a-new')).toBeNull();

    const overflowWaiting = enqueueWaitingPeer(db, {
      roomId: 'r',
      peerId: 'peer-new',
      userName: 'New',
      color: '#222222',
      accountId: 'a-new',
    });
    expect(overflowWaiting).toEqual({ ok: false, reason: 'queue_full' });

    const waiting = db.prepare(
      `SELECT COUNT(*) AS n FROM waiting_peers WHERE room_id = ?`,
    ).get('r') as { n: number };
    expect(waiting.n).toBe(2);
  });

  it('still enqueues a waiting peer after requestAccess when maxUsers is 1', () => {
    db.prepare(
      `INSERT INTO rooms (room_id, created_at, updated_at, max_users) VALUES (?, 1, 1, 1)`,
    ).run('r');
    insertOwner(db, 'r', 'owner', 1);

    const requested = requestAccess(db, { roomId: 'r', accountId: 'guest', userName: 'Guest' });
    expect(requested).toMatchObject({ ok: true, status: 'pending' });

    const queued = enqueueWaitingPeer(db, {
      roomId: 'r',
      peerId: 'guest-peer',
      userName: 'Guest',
      color: '#e74c3c',
      accountId: 'guest',
    });
    expect(queued).toEqual({ ok: true });

    const waiting = db.prepare(
      `SELECT peer_id AS peerId FROM waiting_peers WHERE room_id = ? AND account_id = ?`,
    ).get('r', 'guest') as { peerId: string };
    expect(waiting.peerId).toBe('guest-peer');
  });

  it('treats an expired editor grant as absent and keeps a viewer grant', () => {
    insertOwner(db, 'r', 'owner', 1);
    requestAccess(db, { roomId: 'r', accountId: 'editor', userName: 'Ed' });
    requestAccess(db, { roomId: 'r', accountId: 'viewer', userName: 'Vi' });
    approveAccount(db, 'r', 'editor', { role: 'editor', now: 1_000 });
    approveAccount(db, 'r', 'viewer', { role: 'viewer', now: 1_000 });

    const twelveHours = 12 * 60 * 60 * 1000;
    expect(getGrantRole(db, 'r', 'editor', 1_000 + twelveHours - 1)).toBe('editor');
    expect(getGrantRole(db, 'r', 'editor', 1_000 + twelveHours)).toBeNull();
    expect(getGrantRole(db, 'r', 'viewer', 1_000 + twelveHours + 1)).toBe('viewer');
    expect(getGrantRole(db, 'r', 'owner', 1_000 + twelveHours + 1)).toBe('owner');
  });

  it('purges expired waiting, pending, and kicked rows only for the given room', () => {
    const now = 1_000_000_000_000;
    const staleWaiting = now - WAITING_REQUEST_TTL_MS;
    const staleKick = now - KICKED_PEER_TTL_MS;
    const insertMember = (
      roomId: string,
      accountId: string,
      role: string,
      requestedAt: number | null,
    ) => {
      db.prepare(
        `INSERT INTO room_members (
           room_id, account_id, role, display_name, email,
           requested_at, created_at, updated_at, expires_at
         ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
      ).run(roomId, accountId, role, requestedAt, 1, 1);
    };

    db.prepare(
      `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
       VALUES (?, ?, 'Wait', '#111111', ?, ?)`,
    ).run('r1', 'stale-wait', staleWaiting, 'w-stale');
    db.prepare(
      `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
       VALUES (?, ?, 'Wait', '#111111', ?, ?)`,
    ).run('r1', 'fresh-wait', staleWaiting + 1, 'w-fresh');
    db.prepare(
      `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
       VALUES (?, ?, 'Wait', '#111111', ?, ?)`,
    ).run('r2', 'other-wait', staleWaiting, 'w-other');

    db.prepare(
      `INSERT INTO kicked_peers (room_id, peer_id, kicked_at) VALUES (?, ?, ?)`,
    ).run('r1', 'stale-kick', staleKick);
    db.prepare(
      `INSERT INTO kicked_peers (room_id, peer_id, kicked_at) VALUES (?, ?, ?)`,
    ).run('r1', 'fresh-kick', staleKick + 1);
    db.prepare(
      `INSERT INTO kicked_peers (room_id, peer_id, kicked_at) VALUES (?, ?, ?)`,
    ).run('r2', 'other-kick', staleKick);

    insertMember('r1', 'stale-pending', 'pending', staleWaiting);
    insertMember('r1', 'fresh-pending', 'pending', staleWaiting + 1);
    insertMember('r1', 'owner', 'owner', staleWaiting);
    insertMember('r1', 'viewer', 'viewer', staleWaiting);
    insertMember('r1', 'editor', 'editor', staleWaiting);
    insertMember('r1', 'banned', 'banned', staleWaiting);
    insertMember('r2', 'other-pending', 'pending', staleWaiting);

    db.prepare(
      `INSERT INTO room_tombstones (room_id, deleted_at) VALUES (?, ?)`,
    ).run('r1', staleWaiting);

    purgeExpiredRoomLifecycle(db, 'r1', now);

    const waiting = db.prepare(
      `SELECT room_id AS roomId, peer_id AS peerId FROM waiting_peers ORDER BY room_id, peer_id`,
    ).all() as Array<{ roomId: string; peerId: string }>;
    expect(waiting).toEqual([
      { roomId: 'r1', peerId: 'fresh-wait' },
      { roomId: 'r2', peerId: 'other-wait' },
    ]);

    const kicked = db.prepare(
      `SELECT room_id AS roomId, peer_id AS peerId FROM kicked_peers ORDER BY room_id, peer_id`,
    ).all() as Array<{ roomId: string; peerId: string }>;
    expect(kicked).toEqual([
      { roomId: 'r1', peerId: 'fresh-kick' },
      { roomId: 'r2', peerId: 'other-kick' },
    ]);

    const members = db.prepare(
      `SELECT room_id AS roomId, account_id AS accountId, role
       FROM room_members ORDER BY room_id, account_id`,
    ).all() as Array<{ roomId: string; accountId: string; role: string }>;
    expect(members).toEqual([
      { roomId: 'r1', accountId: 'banned', role: 'banned' },
      { roomId: 'r1', accountId: 'editor', role: 'editor' },
      { roomId: 'r1', accountId: 'fresh-pending', role: 'pending' },
      { roomId: 'r1', accountId: 'owner', role: 'owner' },
      { roomId: 'r1', accountId: 'viewer', role: 'viewer' },
      { roomId: 'r2', accountId: 'other-pending', role: 'pending' },
    ]);

    const tombstone = db.prepare(
      `SELECT room_id AS roomId FROM room_tombstones WHERE room_id = ?`,
    ).get('r1') as { roomId: string } | undefined;
    expect(tombstone).toEqual({ roomId: 'r1' });
  });
});

describe('account erasure from a room', () => {
  it('removes a non-owner membership, presence, and waiting without touching another room', () => {
    const now = 5_000;
    insertOwner(db, 'r1', 'owner', now);
    requestAccess(db, { roomId: 'r1', accountId: 'editor', userName: 'Ed', email: 'ed@example.com', now });
    approveAccount(db, 'r1', 'editor', { role: 'editor', now });
    db.prepare(
      `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen, account_id)
       VALUES ('r1', 'peer-ed', 'Ed', '#111', ?, ?, 'editor')`,
    ).run(now, now);
    enqueueWaitingPeer(db, {
      roomId: 'r1',
      peerId: 'wait-ed',
      userName: 'Ed',
      color: '#111',
      accountId: 'editor',
      now,
    });

    insertOwner(db, 'r2', 'other-owner', now);
    requestAccess(db, { roomId: 'r2', accountId: 'other-editor', userName: 'Pat', email: 'pat@example.com', now });
    approveAccount(db, 'r2', 'other-editor', { role: 'editor', now });
    db.prepare(
      `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen, account_id)
       VALUES ('r2', 'peer-pat', 'Pat', '#222', ?, ?, 'other-editor')`,
    ).run(now, now);

    eraseAccountFromRoom(db, 'r1', 'editor');

    expect(getMembership(db, 'r1', 'editor')).toBeNull();
    expect(getMembership(db, 'r1', 'owner')?.role).toBe('owner');
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM room_presence WHERE room_id = 'r1' AND account_id = 'editor'`).get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM waiting_peers WHERE room_id = 'r1' AND account_id = 'editor'`).get() as { n: number }).n,
    ).toBe(0);
    expect(getMembership(db, 'r2', 'other-editor')).toMatchObject({
      accountId: 'other-editor',
      displayName: 'Pat',
      email: 'pat@example.com',
    });
    expect(
      (db.prepare(`SELECT user_name AS userName FROM room_presence WHERE room_id = 'r2'`).get() as { userName: string }).userName,
    ).toBe('Pat');
  });
});
