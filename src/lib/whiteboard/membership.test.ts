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
  requestAccess,
  resolveModerationTarget,
  enqueueWaitingPeer,
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
});
