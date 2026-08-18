import type { RoomDatabase } from './db';
import { getRoomAllowFirstUserHost } from './roomSchema';

const ACTIVE_WINDOW_MS = 10_000;

export function readActiveUsers(db: RoomDatabase, roomId: string) {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  db.prepare(`DELETE FROM room_presence WHERE last_seen < ?`).run(cutoff);

  const allowFirstUserHost = getRoomAllowFirstUserHost(db, roomId);

  const rows = db.prepare(
    `SELECT p.peer_id, p.user_name, p.color, p.first_seen, p.account_id,
            m.role AS grant_role
     FROM room_presence p
     LEFT JOIN room_members m
       ON m.room_id = p.room_id AND m.account_id = p.account_id
     WHERE p.room_id = ? AND p.last_seen >= ?
     ORDER BY p.first_seen ASC`
  ).all(roomId, cutoff) as Array<{
    peer_id: string;
    user_name: string;
    color: string;
    first_seen: number;
    account_id: string | null;
    grant_role: string | null;
  }>;

  const hasOwnerPresent = rows.some((row) => row.grant_role === 'owner');

  return rows.map((row, index) => ({
    peerId: row.peer_id,
    accountId: row.account_id,
    userName: row.user_name,
    color: row.color,
    // Owner grant is host. host_peer_id is a cursor label and never confers
    // creator rights. First-user fallback is opt-in and only when no owner
    // is present.
    isHost: row.grant_role === 'owner'
      || (!hasOwnerPresent && allowFirstUserHost && index === 0),
    isWaiting: false,
  }));
}

export function readWaitingPeers(db: RoomDatabase, roomId: string) {
  const rows = db.prepare(
    `SELECT peer_id, user_name, color, requested_at, account_id
     FROM waiting_peers
     WHERE room_id = ?
     ORDER BY requested_at ASC`
  ).all(roomId) as Array<{
    peer_id: string;
    user_name: string;
    color: string;
    requested_at: number;
    account_id: string | null;
  }>;

  return rows.map((row) => ({
    peerId: row.peer_id,
    accountId: row.account_id,
    userName: row.user_name,
    color: row.color,
    isWaiting: true,
    requestedAt: row.requested_at,
  }));
}
