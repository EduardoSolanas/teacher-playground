import { NextRequest, NextResponse } from 'next/server';
import { getRoomDb } from '@/lib/whiteboard/roomDb';
import { readActiveUsers } from '@/lib/whiteboard/presence';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> }
) {
  try {
    const { roomId } = await params;
    const db = getRoomDb();

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

    return NextResponse.json({
      waitingPeers: rows.map((row) => ({
        peerId: row.peer_id,
        userName: row.user_name,
        color: row.color,
        requestedAt: row.requested_at,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to read waiting peers' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> }
) {
  try {
    const { roomId } = await params;
    const body = await request.json();
    const { peerId, action } = body;

    if (!peerId || !['approve', 'reject'].includes(action)) {
      return NextResponse.json(
        { error: 'peerId and action (approve/reject) are required' },
        { status: 400 }
      );
    }

    const db = getRoomDb();

    if (action === 'approve') {
      const row = db.prepare(
        `SELECT user_name, color FROM waiting_peers WHERE room_id = ? AND peer_id = ?`
      ).get(roomId, peerId) as { user_name: string; color: string } | undefined;

      if (!row) {
        return NextResponse.json({ error: 'Peer not found in waiting list' }, { status: 404 });
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
      return NextResponse.json({
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

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to process waiting peer' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> }
) {
  try {
    const { roomId } = await params;
    const peerId = request.nextUrl.searchParams.get('peerId');

    if (!peerId) {
      return NextResponse.json({ error: 'peerId is required' }, { status: 400 });
    }

    const db = getRoomDb();
    db.prepare(
      `INSERT OR REPLACE INTO kicked_peers (room_id, peer_id, kicked_at)
       VALUES (?, ?, ?)`
    ).run(roomId, peerId, Date.now());
    db.prepare(`DELETE FROM waiting_peers WHERE room_id = ? AND peer_id = ?`).run(roomId, peerId);

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to remove waiting peer' },
      { status: 500 }
    );
  }
}
