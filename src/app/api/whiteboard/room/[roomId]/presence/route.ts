import { NextRequest, NextResponse } from 'next/server';
import { getRoomDb, getRoomHostPeerId } from '@/lib/whiteboard/roomDb';
import { readActiveUsers, readWaitingPeers } from '@/lib/whiteboard/presence';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> }
) {
  try {
    const { roomId } = await params;
    const db = getRoomDb();
    return NextResponse.json({
      users: readActiveUsers(db, roomId),
      hostPeerId: getRoomHostPeerId(db, roomId),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to read presence' },
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
    const peerId = String(body.peerId || '');
    const userName = String(body.userName || 'Anonymous');
    const color = String(body.color || '#3498db');

    if (!peerId) {
      return NextResponse.json({ error: 'peerId is required' }, { status: 400 });
    }

    const db = getRoomDb();

    const roomRow = db.prepare(`SELECT max_users FROM rooms WHERE room_id = ?`).get(roomId) as
      | { max_users: number }
      | undefined;
    const maxUsers = roomRow?.max_users ?? 3;

    const activeUsers = readActiveUsers(db, roomId);
    const now = Date.now();

    const isInWaiting = db.prepare(
      `SELECT 1 FROM waiting_peers WHERE room_id = ? AND peer_id = ?`
    ).get(roomId, peerId) as { 1: number } | undefined;

    if (activeUsers.length >= maxUsers && !isInWaiting) {
      db.prepare(
        `INSERT OR REPLACE INTO waiting_peers (room_id, peer_id, user_name, color, requested_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(roomId, peerId, userName, color, now);

      return NextResponse.json({
        users: activeUsers,
        waitingPeers: readWaitingPeers(db, roomId),
        hostPeerId: getRoomHostPeerId(db, roomId),
        isWaiting: true,
      });
    }

    if (isInWaiting) {
      db.prepare(
        `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id, peer_id) DO UPDATE SET
          user_name = excluded.user_name,
          color = excluded.color,
          last_seen = excluded.last_seen`
      ).run(roomId, peerId, userName, color, now, now);

      db.prepare(`DELETE FROM waiting_peers WHERE room_id = ? AND peer_id = ?`).run(roomId, peerId);
    } else {
      db.prepare(
        `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id, peer_id) DO UPDATE SET
          user_name = excluded.user_name,
          color = excluded.color,
          last_seen = excluded.last_seen`
      ).run(roomId, peerId, userName, color, now, now);
    }

    return NextResponse.json({
      users: readActiveUsers(db, roomId),
      waitingPeers: readWaitingPeers(db, roomId),
      hostPeerId: getRoomHostPeerId(db, roomId),
      isWaiting: false,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to update presence' },
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
    db.prepare(`DELETE FROM room_presence WHERE room_id = ? AND peer_id = ?`).run(roomId, peerId);
    db.prepare(`DELETE FROM waiting_peers WHERE room_id = ? AND peer_id = ?`).run(roomId, peerId);
    return NextResponse.json({
      users: readActiveUsers(db, roomId),
      waitingPeers: readWaitingPeers(db, roomId),
      hostPeerId: getRoomHostPeerId(db, roomId),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to leave presence' },
      { status: 500 }
    );
  }
}
