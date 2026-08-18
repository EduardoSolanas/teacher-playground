import type { RoomDatabase } from '../db';
import { verifiedAccountId } from '../authz';
import { canWriteBoard, eraseAccountFromRoom, getGrantRole, getMembership, insertOwner, isOwnerRole } from '../membership';
import {
  hasRoomSceneIntent,
  hasRoomSettingsIntent,
  parseBody,
  roomSceneSchema,
  roomSettingsSchema,
} from '../requestSchemas';
import { deleteRoomScopedData } from '../roomSchema';
import {
  assertNotTombstoned,
  createSqlTombstoneStore,
  tombstonedJsonResponse,
} from '../tombstone';
import { internalErrorResponse } from '../../http/safeError';

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

function jsonObject(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
}

function roomSettingsResponse(
  row: {
    max_users: number;
    name: string | null;
    host_peer_id: string | null;
    allow_first_user_host: number;
    updated_at: number;
  },
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({
    success: true,
    updated_at: row.updated_at,
    maxUsers: row.max_users,
    hostPeerId: row.host_peer_id,
    name: row.name,
    allowFirstUserHost: row.allow_first_user_host === 1,
    ...extra,
  });
}

function isUniqueConstraint(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
  const message = error instanceof Error ? error.message : String(error);
  return code.includes('CONSTRAINT') || /unique constraint/i.test(message);
}

function readRoomSettings(db: RoomDatabase, roomId: string) {
  return db.prepare(
    `SELECT max_users, name, host_peer_id, allow_first_user_host, created_at, updated_at
     FROM rooms WHERE room_id = ?`,
  ).get(roomId) as
    | {
      max_users: number;
      name: string | null;
      host_peer_id: string | null;
      allow_first_user_host: number;
      created_at: number;
      updated_at: number;
    }
    | undefined;
}

// POST /api/whiteboard/room/[roomId] - create room and/or save scene
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

    const raw = jsonObject(body);
    if (hasRoomSettingsIntent(raw)) {
      return Response.json(
        { error: 'Settings fields are not allowed on the scene route' },
        { status: 400 },
      );
    }

    const parseResult = parseBody(roomSceneSchema, body);
    if (!parseResult.ok) {
      return Response.json({ error: parseResult.error }, { status: 400 });
    }

    const tombstone = assertNotTombstoned(createSqlTombstoneStore(db), roomId);
    if (!tombstone.ok) return tombstonedJsonResponse();

    const { elements, viewport } = parseResult.data;
    const accountId = verifiedAccountId(request);

    const now = Date.now();
    const existing = db.prepare(`SELECT created_at FROM rooms WHERE room_id = ?`).get(roomId) as
      | { created_at: number }
      | undefined;

    const elementsJson = JSON.stringify(elements || []);
    const viewportJson = JSON.stringify(viewport || { x: 0, y: 0, zoom: 1 });

    let hasCreatorGrant = false;
    const role = getGrantRole(db, roomId, accountId);

    if (existing) {
      // Room ids are share/display identifiers. Authorization is the
      // room_members grant, not a second capability code minted here.
      if (accountId && !canWriteBoard(role)) {
        return Response.json({ error: 'Room already exists' }, { status: 409 });
      }
      db.prepare(
        `UPDATE rooms
         SET elements = ?, viewport = ?, updated_at = ?
         WHERE room_id = ?`,
      ).run(elementsJson, viewportJson, now, roomId);
    } else {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO rooms (room_id, elements, viewport, max_users, host_peer_id, name,
                              allow_first_user_host, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          roomId,
          elementsJson,
          viewportJson,
          DEFAULT_MAX_USERS,
          null,
          null,
          0,
          now,
          now,
        );

        if (accountId) {
          insertOwner(db, roomId, accountId, now);
          hasCreatorGrant = true;
        }
      })();
    }

    const settings = readRoomSettings(db, roomId);
    if (!settings) {
      return Response.json({ error: 'Failed to save' }, { status: 500 });
    }
    return roomSettingsResponse(settings, { hasCreatorGrant });
  } catch (e) {
    if (isUniqueConstraint(e)) {
      return Response.json({ error: 'Room already exists' }, { status: 409 });
    }
    return internalErrorResponse(e, 'handleRoomPost');
  }
}

// POST|PATCH /api/whiteboard/room/[roomId]/settings - owner-only room settings
export async function handleRoomSettings(
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

    const raw = jsonObject(body);
    if (hasRoomSceneIntent(raw)) {
      return Response.json(
        { error: 'Scene fields are not allowed on the settings route' },
        { status: 400 },
      );
    }

    const parseResult = parseBody(roomSettingsSchema, body);
    if (!parseResult.ok) {
      return Response.json({ error: parseResult.error }, { status: 400 });
    }

    const { maxUsers, hostPeerId, name, allowFirstUserHost } = parseResult.data;
    const accountId = verifiedAccountId(request);
    const existing = readRoomSettings(db, roomId);
    if (!existing) {
      return Response.json({ error: 'Room not found' }, { status: 404 });
    }

    if (accountId && !isOwnerRole(getGrantRole(db, roomId, accountId))) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const now = Date.now();
    const normalizedMaxUsers = maxUsers === undefined
      ? existing.max_users
      : normalizeMaxUsers(maxUsers);
    const normalizedName = name === undefined
      ? existing.name
      : normalizeName(name);
    const normalizedAllowFirstUserHost = allowFirstUserHost === undefined
      ? existing.allow_first_user_host === 1
      : allowFirstUserHost;
    const hostId = hostPeerId === undefined
      ? existing.host_peer_id
      : (hostPeerId.length > 0 ? hostPeerId : null);

    db.prepare(
      `UPDATE rooms
       SET max_users = ?, name = ?, host_peer_id = ?,
           allow_first_user_host = ?, updated_at = ?
       WHERE room_id = ?`,
    ).run(
      normalizedMaxUsers,
      normalizedName,
      hostId,
      normalizedAllowFirstUserHost ? 1 : 0,
      now,
      roomId,
    );

    // hostPeerId is a cursor label only. It must not insert presence or
    // bind another peer's row to the caller, and it never grants owner.

    const settings = readRoomSettings(db, roomId);
    if (!settings) {
      return Response.json({ error: 'Failed to save' }, { status: 500 });
    }
    return roomSettingsResponse(settings);
  } catch (e) {
    return internalErrorResponse(e, 'handleRoomSettings');
  }
}

// GET|HEAD /api/whiteboard/room/[roomId]/settings - owner-only read
export async function handleRoomSettingsGet(
  db: RoomDatabase,
  roomId: string,
  _request: Request,
): Promise<Response> {
  try {
    const settings = readRoomSettings(db, roomId);
    if (!settings) {
      return Response.json({ error: 'Room not found' }, { status: 404 });
    }
    return roomSettingsResponse(settings, { created_at: settings.created_at });
  } catch (e) {
    return internalErrorResponse(e, 'handleRoomSettingsGet');
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
      `SELECT elements, viewport, max_users, host_peer_id, name, allow_first_user_host, created_at, updated_at FROM rooms WHERE room_id = ?`,
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
    return internalErrorResponse(e, 'handleRoomGet');
  }
}

// DELETE /api/whiteboard/room/[roomId] - delete room
export async function handleRoomDelete(
  db: RoomDatabase,
  roomId: string,
  _request: Request,
): Promise<Response> {
  try {
    deleteRoomScopedData(db, roomId);
    createSqlTombstoneStore(db).add(roomId);
    return Response.json({ success: true });
  } catch (e) {
    return internalErrorResponse(e, 'handleRoomDelete');
  }
}

/** POST /room/erasure — stamped account deletes the room or leaves it. */
export async function handleRoomAccountErasure(
  db: RoomDatabase,
  roomId: string,
  accountId: string,
): Promise<Response> {
  try {
    const membership = getMembership(db, roomId, accountId);
    if (!membership) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (membership.role === 'owner') {
      return handleRoomDelete(db, roomId, new Request('https://room/room', { method: 'DELETE' }));
    }
    eraseAccountFromRoom(db, roomId, accountId);
    return Response.json({ ok: true });
  } catch (e) {
    return internalErrorResponse(e, 'handleRoomAccountErasure');
  }
}
