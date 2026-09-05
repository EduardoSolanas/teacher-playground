import { beforeEach, describe, expect, it } from 'vitest';
import { ROOM_SETTINGS_KEYS } from '../lib/whiteboard/requestSchemas';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';

/*
 * Storing room viewport state (pan/zoom).
 *
 * A separate file rather than at the end of roomDO.workers.test.ts:
 * that file contains over 160 tests and approaches the V8 stack limit
 * under @cloudflare/vitest-pool-workers proxy wrapping.
 */

function splitRoomWrite(body: Record<string, unknown>) {
  const settings: Record<string, unknown> = {};
  const scene: Record<string, unknown> = { elements: [] };
  for (const [key, value] of Object.entries(body)) {
    if ((ROOM_SETTINGS_KEYS as readonly string[]).includes(key)) {
      settings[key] = value;
    } else if (key !== 'elements') {
      scene[key] = value;
    }
  }
  return { scene, settings };
}

async function writeRoom(
  roomId: string,
  who: LocalAuthSession,
  body: Record<string, unknown> = {},
) {
  const { scene, settings } = splitRoomWrite(body);
  const created = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scene),
  });
  if (created.status !== 200 || Object.keys(settings).length === 0) return created;
  return authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  });
}

let session: LocalAuthSession;

beforeEach(async () => {
  session = await bootstrapLocalSession(`viewport-worker-test-${crypto.randomUUID()}`);
});

async function createRoom(roomId: string, body: Record<string, unknown> = {}) {
  return writeRoom(roomId, session, body);
}

describe('storing the room view', () => {
  it('does not wipe the board when only the view is written', async () => {
    const roomId = 'viewport-only-room';
    const elements = [{ id: 'e1', type: 'rectangle', x: 10, y: 20 }];
    expect((await createRoom(roomId)).status).toBe(200);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements }),
    })).status).toBe(200);

    // The host pans. The board is not in this body and must not be read as
    // "the board is now empty".
    const view = { x: 128, y: -64, zoom: 1.5 };
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ viewport: view }),
    })).status).toBe(200);

    const res = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session);
    const room = await res.json() as { elements: unknown[]; viewport: unknown };
    expect(room.elements).toEqual(elements);
    expect(room.viewport).toEqual(view);
  });

  it('leaves the stored view alone when only the board is written', async () => {
    const roomId = 'board-only-room';
    const view = { x: 5, y: 6, zoom: 2 };
    expect((await createRoom(roomId)).status).toBe(200);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ viewport: view }),
    })).status).toBe(200);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [{ id: 'e2', type: 'ellipse' }] }),
    })).status).toBe(200);

    const res = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session);
    expect((await res.json() as { viewport: unknown }).viewport).toEqual(view);
  });
});
