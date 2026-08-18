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
  requestAccess,
  resolveModerationTarget,
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
