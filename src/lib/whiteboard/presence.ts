import type { RoomDatabase } from './db';
import { getRoomAllowFirstUserHost } from './roomSchema';

/**
 * How long a peer stays present without saying so again.
 *
 * Exported because the client's heartbeat has to stay comfortably inside it:
 * a peer that reports less often than this sweeps itself out of its own room.
 */
export const ACTIVE_WINDOW_MS = 10_000;

/** The peers a room still counts as present, by the same window as the roster. */
export function activePeerIds(db: RoomDatabase, roomId: string): Set<string> {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  const rows = db.prepare(
    `SELECT peer_id FROM room_presence WHERE room_id = ? AND last_seen >= ?`,
  ).all(roomId, cutoff) as Array<{ peer_id: string }>;
  return new Set(rows.map((row) => row.peer_id));
}

/**
 * Deletes the rows every reader already filters out.
 *
 * This used to run inside `readActiveUsers`, which meant three sweeps per
 * heartbeat per peer. Pulling it out made the reads cheaper and left nothing
 * calling it: rosters stayed correct — every reader compares `last_seen`
 * against the same window — while the table grew for the life of the room.
 * A room's own presence requests are what drive it now, once each.
 */
export function sweepExpiredPresence(
  db: RoomDatabase,
  roomId: string,
  cutoff: number = Date.now() - ACTIVE_WINDOW_MS,
): void {
  /*
   * Sweep this room, not every room.
   *
   * The read is per-room and the sweep was not, so reading one room's roster
   * deleted stale rows belonging to rooms nobody had mentioned. Nothing broke
   * -- every reader filters by the same window, so the rows were already
   * invisible -- but it made one lesson's traffic decide when another lesson's
   * rows disappeared, which is a coupling no caller asked for and none could
   * see. What is left behind goes when the room does.
   */
  db.prepare(
    `DELETE FROM room_presence WHERE room_id = ? AND last_seen < ?`,
  ).run(roomId, cutoff);
}

export function readActiveUsers(db: RoomDatabase, roomId: string, options?: { sweep?: boolean }) {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  if (options?.sweep === true) {
    sweepExpiredPresence(db, roomId, cutoff);
  }

  const allowFirstUserHost = getRoomAllowFirstUserHost(db, roomId);

  const rows = db.prepare(
    `SELECT p.peer_id, p.user_name, p.color, p.first_seen, p.account_id, p.hand_raised,
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
    hand_raised: number | null;
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
    handRaised: row.hand_raised === 1,
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

/**
 * A cheap fingerprint of what a presence broadcast would say.
 *
 * The client heartbeats every two seconds and almost every one of those
 * changes nothing but a timestamp. Broadcasting on each would have every peer
 * rebuild and re-send a payload for every other peer, several times a second —
 * more work for the room than the polling it replaced, and more traffic
 * competing with the strokes. Comparing this before and after a mutation says
 * whether anyone would have noticed the difference.
 *
 * It covers what the payload actually exposes: who is present, whether their
 * hand is up, who is waiting, and which peer is host. A last_seen tick alone
 * leaves it unchanged, which is the point.
 */
export function presenceSignatureFromRoster(
  activeUsers: ReadonlyArray<{ peerId: string; handRaised?: boolean; isHost?: boolean }>,
  waitingPeers: ReadonlyArray<{ peerId: string }>,
): string {
  const active = activeUsers
    .map((user) => `${user.peerId}:${user.handRaised ? 1 : 0}:${user.isHost ? 1 : 0}`)
    .sort()
    .join(',');
  const waiting = waitingPeers
    .map((peer) => peer.peerId)
    .sort()
    .join(',');
  return `${active}|${waiting}`;
}

export function presenceSignature(db: RoomDatabase, roomId: string): string {
  const active = readActiveUsers(db, roomId);
  const waiting = readWaitingPeers(db, roomId);
  return presenceSignatureFromRoster(active, waiting);
}
