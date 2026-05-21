import { NextRequest, NextResponse } from 'next/server';
import { getRoomDb } from '@/lib/whiteboard/roomDb';

const DEFAULT_MAX_USERS = 3;
const MIN_MAX_USERS = 1;
const MAX_MAX_USERS = 10;

function normalizeMaxUsers(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_USERS;
  return Math.max(MIN_MAX_USERS, Math.min(MAX_MAX_USERS, Math.floor(parsed)));
}

// POST /api/whiteboard/room/[roomId] - save room state
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> }
) {
  try {
    const { roomId } = await params;
    const body = await request.json();
    const { elements, viewport, maxUsers, hostPeerId } = body;

    const db = getRoomDb();
    const now = Date.now();
    const existing = db.prepare(`SELECT created_at, max_users FROM rooms WHERE room_id = ?`).get(roomId) as
      | { created_at: number; max_users: number }
      | undefined;
    const normalizedMaxUsers = maxUsers === undefined
      ? existing?.max_users ?? DEFAULT_MAX_USERS
      : normalizeMaxUsers(maxUsers);
    const elementsJson = JSON.stringify(elements || []);
    const viewportJson = JSON.stringify(viewport || { x: 0, y: 0, zoom: 1 });
    const hostId =
      hostPeerId != null && String(hostPeerId).length > 0
        ? String(hostPeerId)
        : null;

    if (existing) {
      db.prepare(
        `UPDATE rooms
         SET elements = ?, viewport = ?, max_users = ?, updated_at = ?
         WHERE room_id = ?`
      ).run(elementsJson, viewportJson, normalizedMaxUsers, now, roomId);
    } else {
      db.prepare(
        `INSERT INTO rooms (room_id, elements, viewport, max_users, host_peer_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        roomId,
        elementsJson,
        viewportJson,
        normalizedMaxUsers,
        hostId,
        now,
        now,
      );
    }

    return NextResponse.json({
      success: true,
      updated_at: now,
      maxUsers: normalizedMaxUsers,
      hostPeerId: hostId,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to save' },
      { status: 500 }
    );
  }
}

// GET /api/whiteboard/room/[roomId] - get room state
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> }
) {
  try {
    const { roomId } = await params;
    const db = getRoomDb();
    const row = db.prepare(
      `SELECT elements, viewport, max_users, host_peer_id, created_at, updated_at FROM rooms WHERE room_id = ?`
    ).get(roomId) as {
      elements: string;
      viewport: string;
      max_users: number;
      host_peer_id: string | null;
      created_at: number;
      updated_at: number;
    } | undefined;

    if (!row) {
      return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    }

    return NextResponse.json({
      room_id: roomId,
      elements: JSON.parse(row.elements),
      viewport: JSON.parse(row.viewport),
      maxUsers: row.max_users,
      hostPeerId: row.host_peer_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to get room' },
      { status: 500 }
    );
  }
}

// DELETE /api/whiteboard/room/[roomId] - delete room
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> }
) {
  try {
    const { roomId } = await params;
    const db = getRoomDb();
    db.prepare(`DELETE FROM rooms WHERE room_id = ?`).run(roomId);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to delete' },
      { status: 500 }
    );
  }
}
