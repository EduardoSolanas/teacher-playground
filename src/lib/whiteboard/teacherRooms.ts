/**
 * The room-list model and the request-driven room operations.
 *
 * The route and its panel are thin shells over these functions: keeping the
 * rules here lets them be exercised with real `Response` objects and a real
 * fetch function, rather than a stubbed browser API.
 */

export type TeacherRoomSummary = {
  roomId: string;
  name?: string | null;
  createdAt?: number;
  updatedAt?: number;
};

/** The part of `ajaxFetch` these operations need, so tests can inject one. */
export type AjaxFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function parseTeacherRooms(payload: unknown): TeacherRoomSummary[] {
  if (!payload || typeof payload !== 'object') return [];
  const rooms = Array.isArray(payload)
    ? payload
    : (payload as { rooms?: unknown }).rooms;
  if (!Array.isArray(rooms)) return [];
  const parsed: TeacherRoomSummary[] = [];
  for (const entry of rooms) {
    if (!entry || typeof entry !== 'object') continue;
    const roomId = (entry as { roomId?: unknown }).roomId;
    if (typeof roomId !== 'string' || roomId.length === 0) continue;
    const name = (entry as { name?: unknown }).name;
    const createdAt = (entry as { createdAt?: unknown }).createdAt;
    const updatedAt = (entry as { updatedAt?: unknown }).updatedAt;
    parsed.push({
      roomId,
      name: typeof name === 'string' ? name : null,
      createdAt: typeof createdAt === 'number' ? createdAt : undefined,
      updatedAt: typeof updatedAt === 'number' ? updatedAt : undefined,
    });
  }
  return parsed;
}

/** The owned rooms, or null when the read failed for any reason. */
export async function loadTeacherRooms(
  request: AjaxFetch,
): Promise<TeacherRoomSummary[] | null> {
  try {
    const response = await request('/api/whiteboard/rooms');
    if (!response.ok) return null;
    return parseTeacherRooms(await response.json());
  } catch {
    return null;
  }
}

/**
 * What to tell a teacher whose creation was rate limited.
 *
 * The Worker answers 429 with `Retry-After` in whole seconds. A teacher told
 * only "creation failed" retries immediately and is refused again, so the
 * wait is the one useful part of the response. When the header is missing or
 * unreadable the copy falls back to the generic local-guard wording.
 */
export function rateLimitMessage(response: Response): string {
  const header = response.headers?.get?.('Retry-After') ?? null;
  const seconds = header === null ? Number.NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 'Too many rooms created. Please wait a minute and try again.';
  }
  const wait = Math.ceil(seconds);
  return `Too many rooms created. Wait ${wait} second${wait === 1 ? '' : 's'} and try again.`;
}

/**
 * Deletes a room, re-confirming the session once when the Worker asks for it.
 *
 * Deleting a room is a destructive action, so the Worker requires a session
 * created or confirmed in the last five minutes and answers 403 otherwise.
 * Re-confirm and retry once, the same way account erase does — without this
 * the button silently did nothing for any teacher who had been signed in
 * longer than five minutes.
 */
export async function deleteTeacherRoom(request: AjaxFetch, roomId: string): Promise<Response> {
  const remove = () => request(`/api/whiteboard/room/${roomId}`, { method: 'DELETE' });
  let response = await remove();
  if (response.status === 403) {
    const confirmed = await request('/auth/session/confirm', { method: 'POST' });
    if (confirmed.ok) response = await remove();
  }
  return response;
}

const GENERIC_CREATE_ERROR = 'Room creation failed. Please try again.';

export type RoomCreationOutcome =
  | { ok: true; roomId: string }
  | { ok: false; message: string };

/**
 * Creates a room and applies its owner settings in one server request.
 *
 * The room, its owner grant and its settings are one transaction on the
 * server, so there is no second write to fail and no orphan to delete. A
 * request that never gets an answer is reported as a failed creation; the
 * server either committed all of it or none of it.
 */
export async function createTeacherRoom(input: {
  request: AjaxFetch;
  roomId: string;
  hostPeerId: string;
  maxUsers: number;
  name?: string;
}): Promise<RoomCreationOutcome> {
  const { request, roomId } = input;

  let created: Response;
  try {
    created = await request(`/api/whiteboard/room/${roomId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Naming is optional: an unnamed room falls back to its code, which is
      // more use than auto-naming every room after the same teacher.
      //
      // A blank name omits the key rather than sending null or ''. The
      // settings schema types name as a non-empty string, so both are
      // rejected outright and the whole room creation fails.
      body: JSON.stringify({
        elements: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        maxUsers: input.maxUsers,
        hostPeerId: input.hostPeerId,
        ...(input.name ? { name: input.name } : {}),
      }),
    });
  } catch {
    return { ok: false, message: GENERIC_CREATE_ERROR };
  }

  if (!created.ok) {
    if (created.status === 402) {
      return { ok: false, message: 'Free accounts can keep one room. Delete it to create another.' };
    }
    if (created.status === 429) {
      return { ok: false, message: rateLimitMessage(created) };
    }
    return { ok: false, message: GENERIC_CREATE_ERROR };
  }

  return { ok: true, roomId };
}
