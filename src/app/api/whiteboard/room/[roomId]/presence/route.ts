import { NextRequest, NextResponse } from 'next/server';
import { getRoomDb, getRoomHostPeerId } from '@/lib/whiteboard/roomDb';

const ACTIVE_WINDOW_MS = 10_000;

export function readActiveUsers(db: ReturnType<typeof getRoomDb>, roomId: string) {
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

  const waitingRows = db.prepare(
    `SELECT peer_id FROM waiting_peers WHERE room_id = ?`
  ).all(roomId) as Array<{ peer_id: string }>;

  const waitingPeerIds = new Set(waitingRows.map((r) => r.peer_id));

  return rows.map((row, index) => ({
    peerId: row.peer_id,
    userName: row.user_name,
    color: row.color,
    isHost: hostPeerId != null ? row.peer_id === hostPeerId : index === 0,
    isWaiting: false,
  }));
}

function readWaitingPeers(db: ReturnType<typeof getRoomDb>, roomId: string) {
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
}

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
