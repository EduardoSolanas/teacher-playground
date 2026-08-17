import { describe, expect, it } from 'vitest';
import { handleRoomPost, handleRoomGet } from './room';
import { getRoomDb } from '../roomDb';
import { getRoomAllowFirstUserHost } from '../roomSchema';

function postRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/whiteboard/room/test', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('room allowFirstUserHost setting', () => {
  it('defaults to off when a room is created without it', async () => {
    const db = getRoomDb();
    const roomId = `room-default-${crypto.randomUUID()}`;

    await handleRoomPost(db, roomId, postRequest({ elements: [] }));

    expect(getRoomAllowFirstUserHost(db, roomId)).toBe(false);
  });

  it('stores the setting when a room is created with it on', async () => {
    const db = getRoomDb();
    const roomId = `room-create-on-${crypto.randomUUID()}`;

    const response = await handleRoomPost(
      db,
      roomId,
      postRequest({ elements: [], allowFirstUserHost: true }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ allowFirstUserHost: true });
    expect(getRoomAllowFirstUserHost(db, roomId)).toBe(true);
  });

  it('updates the setting on an existing room', async () => {
    const db = getRoomDb();
    const roomId = `room-update-${crypto.randomUUID()}`;
    await handleRoomPost(db, roomId, postRequest({ elements: [] }));

    await handleRoomPost(db, roomId, postRequest({ allowFirstUserHost: true }));
    expect(getRoomAllowFirstUserHost(db, roomId)).toBe(true);

    await handleRoomPost(db, roomId, postRequest({ allowFirstUserHost: false }));
    expect(getRoomAllowFirstUserHost(db, roomId)).toBe(false);
  });

  it('leaves the setting untouched when a write omits it', async () => {
    const db = getRoomDb();
    const roomId = `room-omit-${crypto.randomUUID()}`;
    await handleRoomPost(db, roomId, postRequest({ allowFirstUserHost: true }));

    await handleRoomPost(db, roomId, postRequest({ elements: [] }));

    expect(getRoomAllowFirstUserHost(db, roomId)).toBe(true);
  });

  it('reports the setting on read', async () => {
    const db = getRoomDb();
    const roomId = `room-read-${crypto.randomUUID()}`;
    await handleRoomPost(db, roomId, postRequest({ allowFirstUserHost: true }));

    const response = await handleRoomGet(
      db,
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}`),
    );

    expect(await response.json()).toMatchObject({ allowFirstUserHost: true });
  });

  it('rejects a non-boolean setting', async () => {
    const db = getRoomDb();
    const roomId = `room-bad-${crypto.randomUUID()}`;

    const response = await handleRoomPost(
      db,
      roomId,
      postRequest({ allowFirstUserHost: 'yes' }),
    );

    expect(response.status).toBe(400);
  });
});
