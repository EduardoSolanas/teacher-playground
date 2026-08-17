import type { RoomDatabase } from '../db';
import { getBearerToken } from '../authz';
import { grantAccess } from '../access';
import { parseBody, roomPostSchema } from '../requestSchemas';

const DEFAULT_MAX_USERS = 3;
const MIN_MAX_USERS = 1;
const MAX_MAX_USERS = 10;
const MAX_NAME_LENGTH = 100;

function normalizeMaxUsers(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_USERS;
  return Math.max(MIN_MAX_USERS, Math.min(MAX_MAX_USERS, Math.floor(parsed)));
}

function normalizeName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

// POST /api/whiteboard/room/[roomId] - save room state
export async function handleRoomPost(
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

    const parseResult = parseBody(roomPostSchema, body);
    if (!parseResult.ok) {
      return Response.json({ error: parseResult.error }, { status: 400 });
    }

    const { elements, viewport, maxUsers, hostPeerId, name, allowFirstUserHost } = parseResult.data;

    const now = Date.now();
    const existing = db.prepare(`SELECT created_at, max_users, name, allow_first_user_host FROM rooms WHERE room_id = ?`).get(roomId) as
      | { created_at: number; max_users: number; name: string | null; allow_first_user_host: number }
      | undefined;
    const normalizedMaxUsers = maxUsers === undefined
      ? existing?.max_users ?? DEFAULT_MAX_USERS
      : normalizeMaxUsers(maxUsers);
    const normalizedName = name === undefined
      ? existing?.name ?? null
      : normalizeName(name);
    // Omitting the setting leaves it as it was; new rooms default to off so
    // nobody becomes host merely by arriving first.
    const normalizedAllowFirstUserHost = allowFirstUserHost === undefined
      ? existing?.allow_first_user_host === 1
      : allowFirstUserHost;
    const elementsJson = JSON.stringify(elements || []);
    const viewportJson = JSON.stringify(viewport || { x: 0, y: 0, zoom: 1 });
    const hostId =
      hostPeerId != null && String(hostPeerId).length > 0
        ? String(hostPeerId)
        : null;

    const token = getBearerToken(request);
    let hasCreatorGrant = false;

    if (existing) {
      db.prepare(
        `UPDATE rooms
         SET elements = ?, viewport = ?, max_users = ?, name = ?,
             allow_first_user_host = ?, updated_at = ?
         WHERE room_id = ?`
      ).run(
        elementsJson,
        viewportJson,
        normalizedMaxUsers,
        normalizedName,
        normalizedAllowFirstUserHost ? 1 : 0,
        now,
        roomId,
      );
    } else {
      db.prepare(
        `INSERT INTO rooms (room_id, elements, viewport, max_users, host_peer_id, name,
                            allow_first_user_host, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        roomId,
        elementsJson,
        viewportJson,
        normalizedMaxUsers,
        hostId,
        normalizedName,
        normalizedAllowFirstUserHost ? 1 : 0,
        now,
        now,
      );

      // Immediately add the host to room_presence so the room appears occupied
      // and subsequent peers get routed to the waiting room.
      if (hostId) {
        db.prepare(
          `INSERT OR REPLACE INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(roomId, hostId, 'Host', '#3498db', now, now);
      }

      // Create creator grant if bearer token is present
      if (token) {
        grantAccess(db, {
          roomId,
          token,
          role: 'creator',
          userName: normalizedName ?? 'Creator',
        });
        hasCreatorGrant = true;
      }
    }

    return Response.json({
      success: true,
      updated_at: now,
      maxUsers: normalizedMaxUsers,
      hostPeerId: hostId,
      name: normalizedName,
      allowFirstUserHost: normalizedAllowFirstUserHost,
      hasCreatorGrant,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to save' },
      { status: 500 }
    );
  }
}

// GET /api/whiteboard/room/[roomId] - get room state
export async function handleRoomGet(
  db: RoomDatabase,
  roomId: string,
  _request: Request,
): Promise<Response> {
  try {
    const row = db.prepare(
      `SELECT elements, viewport, max_users, host_peer_id, name, allow_first_user_host, created_at, updated_at FROM rooms WHERE room_id = ?`
    ).get(roomId) as {
      elements: string;
      viewport: string;
      max_users: number;
      allow_first_user_host: number;
      host_peer_id: string | null;
      name: string | null;
      created_at: number;
      updated_at: number;
    } | undefined;

    if (!row) {
      return Response.json({ error: 'Room not found' }, { status: 404 });
    }

    return Response.json({
      room_id: roomId,
      elements: JSON.parse(row.elements),
      viewport: JSON.parse(row.viewport),
      maxUsers: row.max_users,
      allowFirstUserHost: row.allow_first_user_host === 1,
      hostPeerId: row.host_peer_id,
      name: row.name,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to get room' },
      { status: 500 }
    );
  }
}

// DELETE /api/whiteboard/room/[roomId] - delete room
export async function handleRoomDelete(
  db: RoomDatabase,
  roomId: string,
  _request: Request,
): Promise<Response> {
  try {
    db.prepare(`DELETE FROM rooms WHERE room_id = ?`).run(roomId);
    return Response.json({ success: true });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to delete' },
      { status: 500 }
    );
  }
}
