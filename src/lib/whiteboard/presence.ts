import Database from 'better-sqlite3';
import { getRoomDb, getRoomHostPeerId } from './roomDb';

const ACTIVE_WINDOW_MS = 10_000;

export function readActiveUsers(db: Database.Database, roomId: string) {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  db.prepare(`DELETE FROM room_presence WHERE last_seen < ?`).run(cutoff);

  const hostPeerId = getRoomHostPeerId(db, roomId);

  const rows = db.prepare(
    `SELECT peer_id, user_name, color, first_seen
     FROM room_presence
     WHERE room_id = ? AND last_seen >= ?
     ORDER BY first_seen ASC`
  ).all(roomId, cutoff) as Array<{
    peer_id: string;
    user_name: string;
    color: string;
    first_seen: number;
  }>;

  return rows.map((row, index) => ({
    peerId: row.peer_id,
    userName: row.user_name,
    color: row.color,
    isHost: hostPeerId != null ? row.peer_id === hostPeerId : index === 0,
    isWaiting: false,
  }));
}

export function readWaitingPeers(db: Database.Database, roomId: string) {
  const rows = db.prepare(
    `SELECT peer_id, user_name, color, requested_at
     FROM waiting_peers
     WHERE room_id = ?
     ORDER BY requested_at ASC`
  ).all(roomId) as Array<{
    peer_id: string;
    user_name: string;
    color: string;
    requested_at: number;
  }>;

  return rows.map((row) => ({
    peerId: row.peer_id,
    userName: row.user_name,
    color: row.color,
    isWaiting: true,
    requestedAt: row.requested_at,
  }));
}
