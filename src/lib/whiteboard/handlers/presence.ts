import type { RoomDatabase } from '../db';
import { readActiveUsers, readWaitingPeers } from '../presence';
import { getRoomHostPeerId } from '../roomSchema';
import { parseBody, presencePostSchema } from '../requestSchemas';

export async function handlePresenceGet(
  db: RoomDatabase,
  roomId: string,
  _request: Request,
): Promise<Response> {
  try {
    return Response.json({
      users: readActiveUsers(db, roomId),
      waitingPeers: readWaitingPeers(db, roomId),
      hostPeerId: getRoomHostPeerId(db, roomId),
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to read presence' },
      { status: 500 }
    );
  }
}

export async function handlePresencePost(
  db: RoomDatabase,
  roomId: string,
  request: Request,
): Promise<Response> {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parseResult = parseBody(presencePostSchema, body);
    if (!parseResult.ok) {
      return Response.json({ error: parseResult.error }, { status: 400 });
    }

    const { action, peerId, userName, color } = parseResult.data;

    // Host actions: kick or suspend a peer
    if (action === 'kick' || action === 'suspend') {
      if (!peerId) {
        return Response.json({ error: 'peerId is required' }, { status: 400 });
      }

      const targetRow = db.prepare(
        `SELECT peer_id, user_name, color FROM room_presence WHERE room_id = ? AND peer_id = ?`
      ).get(roomId, peerId) as { peer_id: string; user_name: string; color: string } | undefined;

      if (!targetRow) {
        return Response.json({ error: 'Peer not found in room' }, { status: 404 });
      }

      if (action === 'kick') {
        db.prepare(
          `INSERT OR REPLACE INTO kicked_peers (room_id, peer_id, kicked_at)
           VALUES (?, ?, ?)`
        ).run(roomId, peerId, Date.now());
        db.prepare(`DELETE FROM room_presence WHERE room_id = ? AND peer_id = ?`).run(roomId, peerId);
        db.prepare(`DELETE FROM waiting_peers WHERE room_id = ? AND peer_id = ?`).run(roomId, peerId);

        return Response.json({
          users: readActiveUsers(db, roomId),
          waitingPeers: readWaitingPeers(db, roomId),
          kickedPeer: { peerId: targetRow.peer_id, userName: targetRow.user_name },
          hostPeerId: getRoomHostPeerId(db, roomId),
        });
      }

      if (action === 'suspend') {
        const now = Date.now();
        db.prepare(
          `INSERT OR REPLACE INTO waiting_peers (room_id, peer_id, user_name, color, requested_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(roomId, peerId, targetRow.user_name, targetRow.color, now);

        db.prepare(`DELETE FROM room_presence WHERE room_id = ? AND peer_id = ?`).run(roomId, peerId);

        return Response.json({
          users: readActiveUsers(db, roomId),
          waitingPeers: readWaitingPeers(db, roomId),
          suspendedPeer: { peerId: targetRow.peer_id, userName: targetRow.user_name },
          hostPeerId: getRoomHostPeerId(db, roomId),
        });
      }
    }

    // Normal presence join/update
    const pId = String(peerId || '');
    const uName = String(userName || 'Anonymous');
    const c = String(color || '#3498db');

    if (!pId) {
      return Response.json({ error: 'peerId is required' }, { status: 400 });
    }

    const roomRow = db.prepare(`SELECT max_users FROM rooms WHERE room_id = ?`).get(roomId) as
      | { max_users: number }
      | undefined;
    const maxUsers = roomRow?.max_users ?? 3;

    const activeUsers = readActiveUsers(db, roomId);
    const now = Date.now();
    const hostPeerId = getRoomHostPeerId(db, roomId);
    const effectiveHostPeerId = hostPeerId ?? activeUsers[0]?.peerId ?? null;

    const wasKicked = db.prepare(
      `SELECT 1 FROM kicked_peers WHERE room_id = ? AND peer_id = ?`
    ).get(roomId, pId) as { 1: number } | undefined;

    if (wasKicked) {
      db.prepare(`DELETE FROM kicked_peers WHERE room_id = ? AND peer_id = ?`).run(roomId, pId);
      db.prepare(`DELETE FROM room_presence WHERE room_id = ? AND peer_id = ?`).run(roomId, pId);
      db.prepare(`DELETE FROM waiting_peers WHERE room_id = ? AND peer_id = ?`).run(roomId, pId);

      return Response.json({
        users: readActiveUsers(db, roomId),
        waitingPeers: readWaitingPeers(db, roomId),
        hostPeerId: getRoomHostPeerId(db, roomId),
        isWaiting: false,
        isKicked: true,
      });
    }

    const isInWaiting = db.prepare(
      `SELECT 1 FROM waiting_peers WHERE room_id = ? AND peer_id = ?`
    ).get(roomId, pId) as { 1: number } | undefined;

    // If the peer is already in the room (e.g., just approved), don't re-add to waiting
    const alreadyInRoom = db.prepare(
      `SELECT 1 FROM room_presence WHERE room_id = ? AND peer_id = ?`
    ).get(roomId, pId) as { 1: number } | undefined;

    // Peer already in the active room — just update heartbeat
    if (alreadyInRoom) {
      db.prepare(
        `UPDATE room_presence SET user_name = ?, color = ?, last_seen = ? WHERE room_id = ? AND peer_id = ?`
      ).run(uName, c, now, roomId, pId);

      return Response.json({
        users: readActiveUsers(db, roomId),
        waitingPeers: readWaitingPeers(db, roomId),
        hostPeerId,
        isWaiting: false,
      });
    }

    // Room is full and peer is not the host — add to waiting queue
    if (isInWaiting) {
      // Keep the original queue position. Only the host's approve action admits the peer.
      db.prepare(
        `UPDATE waiting_peers SET user_name = ?, color = ? WHERE room_id = ? AND peer_id = ?`
      ).run(uName, c, roomId, pId);

      return Response.json({
        users: activeUsers,
        waitingPeers: readWaitingPeers(db, roomId),
        hostPeerId: getRoomHostPeerId(db, roomId),
        isWaiting: true,
      });
    }

    if (effectiveHostPeerId != null && pId !== effectiveHostPeerId) {
      db.prepare(
        `INSERT OR REPLACE INTO waiting_peers (room_id, peer_id, user_name, color, requested_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(roomId, pId, uName, c, now);

      return Response.json({
        users: activeUsers,
        waitingPeers: readWaitingPeers(db, roomId),
        hostPeerId: getRoomHostPeerId(db, roomId),
        isWaiting: true,
      });
    }

    if (activeUsers.length >= maxUsers && pId !== hostPeerId) {
      db.prepare(
        `INSERT OR REPLACE INTO waiting_peers (room_id, peer_id, user_name, color, requested_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(roomId, pId, uName, c, now);

      return Response.json({
        users: activeUsers,
        waitingPeers: readWaitingPeers(db, roomId),
        hostPeerId: getRoomHostPeerId(db, roomId),
        isWaiting: true,
      });
    }

    db.prepare(
      `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id, peer_id) DO UPDATE SET
        user_name = excluded.user_name,
        color = excluded.color,
        last_seen = excluded.last_seen`
    ).run(roomId, pId, uName, c, now, now);

    return Response.json({
      users: readActiveUsers(db, roomId),
      waitingPeers: readWaitingPeers(db, roomId),
      hostPeerId: getRoomHostPeerId(db, roomId),
      isWaiting: false,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to update presence' },
      { status: 500 }
    );
  }
}

export async function handlePresenceDelete(
  db: RoomDatabase,
  roomId: string,
  request: Request,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const peerId = url.searchParams.get('peerId');
    if (!peerId) {
      return Response.json({ error: 'peerId is required' }, { status: 400 });
    }

    db.prepare(`DELETE FROM room_presence WHERE room_id = ? AND peer_id = ?`).run(roomId, peerId);
    db.prepare(`DELETE FROM waiting_peers WHERE room_id = ? AND peer_id = ?`).run(roomId, peerId);
    db.prepare(`DELETE FROM kicked_peers WHERE room_id = ? AND peer_id = ?`).run(roomId, peerId);
    return Response.json({
      users: readActiveUsers(db, roomId),
      waitingPeers: readWaitingPeers(db, roomId),
      hostPeerId: getRoomHostPeerId(db, roomId),
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to leave presence' },
      { status: 500 }
    );
  }
}
