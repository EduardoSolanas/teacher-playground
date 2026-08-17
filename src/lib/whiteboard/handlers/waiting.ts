import type { RoomDatabase } from '../db';
import { readActiveUsers } from '../presence';
import { parseBody, waitingPostSchema } from '../requestSchemas';

export async function handleWaitingGet(
  db: RoomDatabase,
  roomId: string,
  _request: Request,
): Promise<Response> {
  try {
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

    return Response.json({
      waitingPeers: rows.map((row) => ({
        peerId: row.peer_id,
        userName: row.user_name,
        color: row.color,
        requestedAt: row.requested_at,
      })),
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to read waiting peers' },
      { status: 500 }
    );
  }
}

export async function handleWaitingPost(
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

    const parseResult = parseBody(waitingPostSchema, body);
    if (!parseResult.ok) {
      return Response.json({ error: parseResult.error }, { status: 400 });
    }

    const { peerId, action } = parseResult.data;

    if (action === 'approve') {
      const row = db.prepare(
        `SELECT user_name, color FROM waiting_peers WHERE room_id = ? AND peer_id = ?`
      ).get(roomId, peerId) as { user_name: string; color: string } | undefined;

      if (!row) {
        return Response.json({ error: 'Peer not found in waiting list' }, { status: 404 });
      }

      const now = Date.now();
      db.prepare(
        `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id, peer_id) DO UPDATE SET
          user_name = excluded.user_name,
          color = excluded.color,
          last_seen = excluded.last_seen`
      ).run(roomId, peerId, row.user_name, row.color, now, now);

      db.prepare(`DELETE FROM waiting_peers WHERE room_id = ? AND peer_id = ?`).run(roomId, peerId);
      db.prepare(`DELETE FROM kicked_peers WHERE room_id = ? AND peer_id = ?`).run(roomId, peerId);

      const activeUsers = readActiveUsers(db, roomId);
      return Response.json({
        users: activeUsers,
        success: true,
      });
    }

    if (action === 'reject') {
      db.prepare(
        `INSERT OR REPLACE INTO kicked_peers (room_id, peer_id, kicked_at)
         VALUES (?, ?, ?)`
      ).run(roomId, peerId, Date.now());
      db.prepare(`DELETE FROM waiting_peers WHERE room_id = ? AND peer_id = ?`).run(roomId, peerId);

      return Response.json({ success: true });
    }

    return Response.json({ error: 'Invalid action' }, { status: 400 });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to process waiting peer' },
      { status: 500 }
    );
  }
}

export async function handleWaitingDelete(
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

    db.prepare(
      `INSERT OR REPLACE INTO kicked_peers (room_id, peer_id, kicked_at)
       VALUES (?, ?, ?)`
    ).run(roomId, peerId, Date.now());
    db.prepare(`DELETE FROM waiting_peers WHERE room_id = ? AND peer_id = ?`).run(roomId, peerId);

    return Response.json({ success: true });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to remove waiting peer' },
      { status: 500 }
    );
  }
}
