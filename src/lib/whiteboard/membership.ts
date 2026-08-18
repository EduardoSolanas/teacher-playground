import type { RoomDatabase } from './db';

/**
 * Single admission record per (room, account). There is no second grant table:
 * pending, granted, and banned all live here, so an account cannot be both
 * waiting and admitted.
 */
export type MembershipRole = 'owner' | 'editor' | 'viewer' | 'pending' | 'banned';

/** Wire names kept so existing UIs can keep sending peer/viewer/creator. */
export type PublicGrantRole = 'creator' | 'peer' | 'viewer';

export interface Membership {
  roomId: string;
  accountId: string;
  role: MembershipRole;
  displayName: string | null;
  email: string | null;
  createdAt: number;
  updatedAt: number;
  requestedAt: number | null;
  expiresAt: number | null;
}

const PEER_GRANT_MS = 12 * 60 * 60 * 1000;

export function isGrantedRole(role: MembershipRole | null): boolean {
  return role === 'owner' || role === 'editor' || role === 'viewer';
}

export function canWriteBoard(role: MembershipRole | null): boolean {
  return role === 'owner' || role === 'editor';
}

export function toPublicRole(role: MembershipRole): PublicGrantRole | null {
  if (role === 'owner') return 'creator';
  if (role === 'editor') return 'peer';
  if (role === 'viewer') return 'viewer';
  return null;
}

export function approveRoleFromPayload(role: 'peer' | 'viewer' | undefined): 'editor' | 'viewer' {
  return role === 'viewer' ? 'viewer' : 'editor';
}

export function getMembership(
  db: RoomDatabase,
  roomId: string,
  accountId: string | null,
): Membership | null {
  if (!accountId) return null;
  const row = db.prepare(
    `SELECT room_id AS roomId, account_id AS accountId, role,
            display_name AS displayName, email,
            created_at AS createdAt, updated_at AS updatedAt,
            requested_at AS requestedAt, expires_at AS expiresAt
     FROM room_members
     WHERE room_id = ? AND account_id = ?`,
  ).get(roomId, accountId) as Membership | undefined;
  return row ?? null;
}

/** Granted roles expire; pending/banned/owner do not use expiry to admit. */
export function effectiveRole(
  membership: Pick<Membership, 'role' | 'expiresAt'> | null,
  now = Date.now(),
): MembershipRole | null {
  if (!membership) return null;
  if (membership.role === 'editor' || membership.role === 'viewer') {
    if (membership.expiresAt !== null && membership.expiresAt <= now) return null;
  }
  return membership.role;
}

/**
 * Grant role only — no display name, email, or other request PII.
 * Authorization should use this instead of loading the full membership row.
 */
export function getGrantRole(
  db: RoomDatabase,
  roomId: string,
  accountId: string | null,
  now = Date.now(),
): MembershipRole | null {
  if (!accountId) return null;
  const row = db.prepare(
    `SELECT role, expires_at AS expiresAt
     FROM room_members
     WHERE room_id = ? AND account_id = ?`,
  ).get(roomId, accountId) as { role: MembershipRole; expiresAt: number | null } | undefined;
  return effectiveRole(row ?? null, now);
}

export function isOwnerRole(role: MembershipRole | null): boolean {
  return role === 'owner';
}

export function insertOwner(
  db: RoomDatabase,
  roomId: string,
  accountId: string,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO room_members (
       room_id, account_id, role, display_name, email,
       requested_at, created_at, updated_at, expires_at
     ) VALUES (?, ?, 'owner', NULL, NULL, NULL, ?, ?, NULL)
     ON CONFLICT(room_id, account_id) DO UPDATE SET
       role = 'owner',
       updated_at = excluded.updated_at,
       expires_at = NULL`,
  ).run(roomId, accountId, now, now);
}

export type RequestAccessResult =
  | { ok: true; status: 'approved'; role: PublicGrantRole; expiresAt: number | null }
  | { ok: true; status: 'pending'; requestId: string }
  | { ok: false; reason: 'banned' };

/**
 * None → pending. Already granted stays granted. Banned stays banned.
 * One row per account, so this cannot also leave a pending copy behind.
 */
export function requestAccess(
  db: RoomDatabase,
  params: {
    roomId: string;
    accountId: string;
    userName: string;
    email?: string | null;
    now?: number;
  },
): RequestAccessResult {
  const now = params.now ?? Date.now();
  const current = getMembership(db, params.roomId, params.accountId);
  const role = effectiveRole(current, now);

  if (role === 'banned') return { ok: false, reason: 'banned' };
  if (isGrantedRole(role) && current) {
    return {
      ok: true,
      status: 'approved',
      role: toPublicRole(current.role)!,
      expiresAt: current.expiresAt,
    };
  }
  if (role === 'pending' && current) {
    return { ok: true, status: 'pending', requestId: current.accountId };
  }

  db.prepare(
    `INSERT INTO room_members (
       room_id, account_id, role, display_name, email,
       requested_at, created_at, updated_at, expires_at
     ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(room_id, account_id) DO UPDATE SET
       role = CASE WHEN room_members.role IN ('owner', 'editor', 'viewer', 'banned')
         THEN room_members.role ELSE 'pending' END,
       display_name = excluded.display_name,
       email = excluded.email,
       requested_at = COALESCE(room_members.requested_at, excluded.requested_at),
       updated_at = excluded.updated_at`,
  ).run(
    params.roomId,
    params.accountId,
    params.userName,
    params.email ?? null,
    now,
    now,
    now,
  );

  const stored = getMembership(db, params.roomId, params.accountId);
  const storedRole = effectiveRole(stored, now);
  if (storedRole === 'banned') return { ok: false, reason: 'banned' };
  if (isGrantedRole(storedRole) && stored) {
    return {
      ok: true,
      status: 'approved',
      role: toPublicRole(stored.role)!,
      expiresAt: stored.expiresAt,
    };
  }
  return { ok: true, status: 'pending', requestId: params.accountId };
}

export function listPending(
  db: RoomDatabase,
  roomId: string,
): Array<{
  requestId: string;
  roomId: string;
  userName: string;
  email: string | null;
  requestedAt: number;
}> {
  const rows = db.prepare(
    `SELECT account_id AS requestId, display_name AS userName, email,
            requested_at AS requestedAt
     FROM room_members
     WHERE room_id = ? AND role = 'pending'
     ORDER BY requested_at ASC, account_id ASC`,
  ).all(roomId) as Array<{
    requestId: string;
    userName: string | null;
    email: string | null;
    requestedAt: number | null;
  }>;

  return rows.map((row) => ({
    requestId: row.requestId,
    roomId,
    userName: row.userName ?? '',
    email: row.email,
    requestedAt: row.requestedAt ?? 0,
  }));
}

export function approveAccount(
  db: RoomDatabase,
  roomId: string,
  accountId: string,
  params: { role: 'editor' | 'viewer'; now?: number },
): Membership | null {
  const now = params.now ?? Date.now();
  const current = getMembership(db, roomId, accountId);
  if (!current || current.role !== 'pending') return null;

  const expiresAt = params.role === 'editor' ? now + PEER_GRANT_MS : null;
  db.prepare(
    `UPDATE room_members
     SET role = ?, requested_at = NULL, updated_at = ?, expires_at = ?
     WHERE room_id = ? AND account_id = ? AND role = 'pending'`,
  ).run(params.role, now, expiresAt, roomId, accountId);

  return getMembership(db, roomId, accountId);
}

export function banAccount(
  db: RoomDatabase,
  roomId: string,
  accountId: string,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO room_members (
       room_id, account_id, role, display_name, email,
       requested_at, created_at, updated_at, expires_at
     ) VALUES (?, ?, 'banned', NULL, NULL, NULL, ?, ?, NULL)
     ON CONFLICT(room_id, account_id) DO UPDATE SET
       role = CASE WHEN room_members.role = 'owner' THEN 'owner' ELSE 'banned' END,
       requested_at = NULL,
       updated_at = excluded.updated_at,
       expires_at = NULL`,
  ).run(roomId, accountId, now, now);
}

/** Owner-only suspend: a granted non-owner goes back to pending, not banned. */
export function suspendAccount(
  db: RoomDatabase,
  roomId: string,
  accountId: string,
  now = Date.now(),
): void {
  const current = getMembership(db, roomId, accountId);
  if (!current || current.role === 'owner' || current.role === 'banned') return;
  db.prepare(
    `UPDATE room_members
     SET role = 'pending', requested_at = ?, updated_at = ?, expires_at = NULL
     WHERE room_id = ? AND account_id = ? AND role != 'owner'`,
  ).run(now, now, roomId, accountId);
}

/** Self-service leave from the queue: pending → none. Never bans. */
export function dropPending(
  db: RoomDatabase,
  roomId: string,
  accountId: string,
): void {
  db.prepare(
    `DELETE FROM room_members
     WHERE room_id = ? AND account_id = ? AND role = 'pending'`,
  ).run(roomId, accountId);
}

export function peerAccountId(
  db: RoomDatabase,
  roomId: string,
  peerId: string,
): string | null {
  for (const table of ['room_presence', 'waiting_peers']) {
    const row = db
      .prepare(`SELECT account_id AS accountId FROM ${table} WHERE room_id = ? AND peer_id = ?`)
      .get(roomId, peerId) as { accountId: string | null } | undefined;
    if (row?.accountId) return row.accountId;
  }
  return null;
}

export function bindPeerAccount(
  db: RoomDatabase,
  roomId: string,
  peerId: string,
  accountId: string,
): void {
  for (const table of ['room_presence', 'waiting_peers']) {
    db.prepare(
      `UPDATE ${table} SET account_id = ? WHERE room_id = ? AND peer_id = ?`,
    ).run(accountId, roomId, peerId);
  }
}

/**
 * Owner moderation names a grant, not a replaceable cursor id.
 * Body `accountId` is the *target* (never the caller). A peerId is only an
 * optional lookup and must already be bound to that same account.
 */
export type ModerationTarget =
  | { ok: true; accountId: string; peerId: string | null }
  | { ok: false; status: 400 | 404 | 409; error: string };

export function resolveModerationTarget(
  db: RoomDatabase,
  roomId: string,
  input: { accountId?: string | null; peerId?: string | null },
): ModerationTarget {
  const accountId = input.accountId && input.accountId.length > 0 ? input.accountId : null;
  const peerId = input.peerId && input.peerId.length > 0 ? input.peerId : null;
  if (!accountId && !peerId) {
    return { ok: false, status: 400, error: 'accountId or peerId is required' };
  }

  const bound = peerId ? peerAccountId(db, roomId, peerId) : null;
  if (peerId && !bound) {
    return { ok: false, status: 404, error: 'Peer not bound to an account' };
  }
  if (accountId && peerId && bound !== accountId) {
    return { ok: false, status: 409, error: 'peerId does not match account' };
  }

  const target = accountId ?? bound;
  if (!target) {
    return { ok: false, status: 404, error: 'Account not found' };
  }

  if (accountId && !peerId) {
    const known = db.prepare(
      `SELECT 1 AS present FROM room_members WHERE room_id = ? AND account_id = ?
       UNION
       SELECT 1 FROM room_presence WHERE room_id = ? AND account_id = ?
       UNION
       SELECT 1 FROM waiting_peers WHERE room_id = ? AND account_id = ?`,
    ).get(roomId, accountId, roomId, accountId, roomId, accountId) as
      | { present: number }
      | undefined;
    if (!known) {
      return { ok: false, status: 404, error: 'Account not found' };
    }
  }

  return { ok: true, accountId: target, peerId };
}

/** Drop every cursor row for a grant so a new peerId cannot dodge a ban. */
export function clearAccountPeers(
  db: RoomDatabase,
  roomId: string,
  accountId: string,
): void {
  const peers = db.prepare(
    `SELECT peer_id AS peerId FROM room_presence WHERE room_id = ? AND account_id = ?
     UNION
     SELECT peer_id AS peerId FROM waiting_peers WHERE room_id = ? AND account_id = ?`,
  ).all(roomId, accountId, roomId, accountId) as Array<{ peerId: string }>;

  db.prepare(`DELETE FROM room_presence WHERE room_id = ? AND account_id = ?`).run(roomId, accountId);
  db.prepare(`DELETE FROM waiting_peers WHERE room_id = ? AND account_id = ?`).run(roomId, accountId);
  for (const row of peers) {
    db.prepare(`DELETE FROM kicked_peers WHERE room_id = ? AND peer_id = ?`).run(roomId, row.peerId);
  }
}
