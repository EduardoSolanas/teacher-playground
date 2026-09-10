import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { MAX_BOARD_FILE_BYTES, MAX_ROOM_FILE_BYTES_TOTAL } from '../lib/whiteboard/boardFileRoutes';
import { getFileBytesTotal, addFileBytes, setFileBytes } from '../lib/whiteboard/roomSchema';
import { authenticatedFetch, bootstrapLocalSession } from '../test/workerAuth';
import type { RoomDO } from './RoomDO';

describe('Room file quota constants and functions', () => {
  it('exports correct 250 MB aggregate quota constant', () => {
    expect(MAX_ROOM_FILE_BYTES_TOTAL).toBe(250 * 1024 * 1024);
  });

  it('getFileBytesTotal, addFileBytes, and setFileBytes are exported functions', () => {
    expect(typeof getFileBytesTotal).toBe('function');
    expect(typeof addFileBytes).toBe('function');
    expect(typeof setFileBytes).toBe('function');
  });
});

function roomStub(roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)) as DurableObjectStub<RoomDO>;
}

async function createOwnedRoom(roomId: string) {
  const owner = await bootstrapLocalSession(`quota-${roomId}`);
  const created = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ elements: [] }),
  });
  expect(created.ok).toBe(true);
  return owner;
}

async function setTotal(roomId: string, bytes: number) {
  await runInDurableObject(roomStub(roomId), (instance) => {
    setFileBytes(instance.db, roomId, bytes);
  });
}

async function total(roomId: string) {
  return runInDurableObject(roomStub(roomId), (instance) => (
    getFileBytesTotal(instance.db, roomId)
  ));
}

function postFileAction(
  roomId: string,
  accountId: string,
  action: string,
  body: unknown,
): Promise<Response> {
  const query = new URLSearchParams({ roomId, accountId });
  return roomStub(roomId).fetch(`https://room/room/files/${action}?${query.toString()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function grantRole(roomId: string, accountId: string, role: 'editor' | 'viewer') {
  return runInDurableObject(roomStub(roomId), (instance) => {
    instance.db.prepare(
      `INSERT INTO room_members (
         room_id, account_id, role, display_name, email,
         requested_at, created_at, updated_at, expires_at
       ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
    ).run(roomId, accountId, role, role, Date.now(), Date.now());
  });
}

/*
 * The upload route used to check the quota, write the object to R2, and only
 * then increment the counter -- a read, a network write, and a write with no
 * serialization between them. Concurrent uploads could each pass the check
 * against the same total and overshoot the cap, and a re-PUT of the same
 * content-addressed file counted the bytes twice.
 *
 * reserve and settle run as SQL in one Durable Object execution, so the check
 * and the increment cannot be interleaved with another request for the room.
 */
describe('atomic file quota reserve and settle', () => {
  it('refuses reserve byte counts that are not positive safe integers within one file', async () => {
    const roomId = `quota-reserve-invalid-${crypto.randomUUID()}`;
    const owner = await createOwnedRoom(roomId);
    await setTotal(roomId, 1000);

    for (const bytes of [-1, 0, 1.5, 'x', MAX_BOARD_FILE_BYTES + 1]) {
      const response = await postFileAction(roomId, owner.accountId, 'reserve', { bytes });
      expect(response.status, `reserve ${String(bytes)}`).toBe(400);
    }

    expect(await total(roomId)).toBe(1000);
  });

  it('ignores a replacing field and charges the full reservation', async () => {
    /*
     * No replacement credits. A key that already holds bytes is immutable by
     * size at the Worker, so the room never needs to hand bytes back during a
     * reserve -- and a credit computed against a stale head was exactly the
     * concurrency defect: N racers each subtracted the same stored size while
     * R2 freed it once.
     */
    const roomId = `quota-reserve-no-credit-${crypto.randomUUID()}`;
    const owner = await createOwnedRoom(roomId);
    expect((await postFileAction(roomId, owner.accountId, 'reserve', { bytes: 5000 })).status).toBe(200);
    expect(await total(roomId)).toBe(5000);

    const noCredit = await postFileAction(roomId, owner.accountId, 'reserve', {
      bytes: 1000,
      replacing: 4000,
    });
    expect(noCredit.status).toBe(200);
    expect(await total(roomId)).toBe(6000);
  });

  it('refuses a reserve that would cross the aggregate cap without changing the total', async () => {
    const roomId = `quota-reserve-cap-${crypto.randomUUID()}`;
    const owner = await createOwnedRoom(roomId);
    await setTotal(roomId, MAX_ROOM_FILE_BYTES_TOTAL - 100);

    const response = await postFileAction(roomId, owner.accountId, 'reserve', { bytes: 101 });

    expect(response.status).toBe(413);
    expect(await total(roomId)).toBe(MAX_ROOM_FILE_BYTES_TOTAL - 100);
  });

  it('commits a valid reservation at once so the next reserve sees the reduced headroom', async () => {
    const roomId = `quota-reserve-atomic-${crypto.randomUUID()}`;
    const owner = await createOwnedRoom(roomId);
    await setTotal(roomId, MAX_ROOM_FILE_BYTES_TOTAL - MAX_BOARD_FILE_BYTES);

    const first = await postFileAction(roomId, owner.accountId, 'reserve', {
      bytes: MAX_BOARD_FILE_BYTES,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, reserved: MAX_BOARD_FILE_BYTES });
    expect(await total(roomId)).toBe(MAX_ROOM_FILE_BYTES_TOTAL);

    const second = await postFileAction(roomId, owner.accountId, 'reserve', { bytes: 1 });
    expect(second.status).toBe(413);
    expect(await total(roomId)).toBe(MAX_ROOM_FILE_BYTES_TOTAL);
  });

  it('denies reserve to a viewer and an outsider and allows an editor', async () => {
    const roomId = `quota-reserve-denied-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId);
    await grantRole(roomId, 'quota-viewer-account', 'viewer');
    await grantRole(roomId, 'quota-editor-account', 'editor');

    const viewer = await postFileAction(roomId, 'quota-viewer-account', 'reserve', { bytes: 1 });
    expect(viewer.status).toBe(403);
    const outsider = await postFileAction(roomId, 'quota-outsider-account', 'reserve', { bytes: 1 });
    expect(outsider.status).toBe(403);
    expect(await total(roomId)).toBe(0);

    const editor = await postFileAction(roomId, 'quota-editor-account', 'reserve', { bytes: 1 });
    expect(editor.status, `editor of room ${roomId}`).toBe(200);
    expect(await total(roomId)).toBe(1);
  });

  it('refuses settle with byte counts outside the ranges an upload can produce', async () => {
    const roomId = `quota-settle-invalid-${crypto.randomUUID()}`;
    const owner = await createOwnedRoom(roomId);
    await setTotal(roomId, 1000);

    const invalidPairs: Array<[unknown, unknown]> = [
      [-1, 0],
      [0, 1.5],
      ['x', 0],
      [MAX_BOARD_FILE_BYTES + 1, 0],
      [0, MAX_BOARD_FILE_BYTES + 1],
      [0, -1],
    ];
    for (const [reserved, actual] of invalidPairs) {
      const response = await postFileAction(roomId, owner.accountId, 'settle', { reserved, actual });
      expect(response.status, `settle ${String(reserved)}/${String(actual)}`).toBe(400);
    }

    expect(await total(roomId)).toBe(1000);
  });

  it('returns the unused part of a reservation when the upload is smaller', async () => {
    const roomId = `quota-settle-smaller-${crypto.randomUUID()}`;
    const owner = await createOwnedRoom(roomId);
    await setTotal(roomId, 1000);
    expect((await postFileAction(roomId, owner.accountId, 'reserve', { bytes: 300 })).status).toBe(200);
    expect(await total(roomId)).toBe(1300);

    const settled = await postFileAction(roomId, owner.accountId, 'settle', {
      reserved: 300,
      actual: 100,
    });
    expect(settled.status).toBe(200);
    expect(await settled.json()).toEqual({ ok: true });
    expect(await total(roomId)).toBe(1100);

    // Settling the same reservation again changes nothing.
    expect((await postFileAction(roomId, owner.accountId, 'settle', {
      reserved: 100,
      actual: 100,
    })).status).toBe(200);
    expect(await total(roomId)).toBe(1100);
  });

  it('charges the extra when the upload is larger than reserved', async () => {
    const roomId = `quota-settle-larger-${crypto.randomUUID()}`;
    const owner = await createOwnedRoom(roomId);
    await setTotal(roomId, 1000);
    expect((await postFileAction(roomId, owner.accountId, 'reserve', { bytes: 100 })).status).toBe(200);
    expect(await total(roomId)).toBe(1100);

    const settled = await postFileAction(roomId, owner.accountId, 'settle', {
      reserved: 100,
      actual: 250,
    });
    expect(settled.status).toBe(200);
    expect(await total(roomId)).toBe(1250);
  });

  it('refuses a files action whose room path is not exactly /room/files/<action>', async () => {
    /*
     * The Worker normalizes the public path, but the room must not depend on
     * that: it splits and filters empty segments, so `/room//files/reserve`
     * routed to the reserve handler. Pinned here at the DO boundary so the
     * guard cannot silently disappear if the Worker's normalization regresses.
     */
    const roomId = `quota-double-slash-${crypto.randomUUID()}`;
    const owner = await createOwnedRoom(roomId);
    await setTotal(roomId, 1234);

    const query = new URLSearchParams({ roomId, accountId: owner.accountId });
    const response = await roomStub(roomId).fetch(
      `https://room/room//files/reserve?${query.toString()}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bytes: 1024 }),
      },
    );

    expect(response.status).toBe(404);
    expect(await total(roomId)).toBe(1234);
  });

  it('refuses a settle whose positive delta would cross the aggregate cap', async () => {
    /*
     * settle corrects a reservation upward when the upload was larger than
     * declared. That delta went in unchecked, so a caller could step the
     * counter past the cap with repeated settles and never touch R2.
     */
    const roomId = `quota-settle-cap-${crypto.randomUUID()}`;
    const owner = await createOwnedRoom(roomId);

    const fullSettles = MAX_ROOM_FILE_BYTES_TOTAL / MAX_BOARD_FILE_BYTES;
    for (let index = 0; index < fullSettles; index += 1) {
      const response = await postFileAction(roomId, owner.accountId, 'settle', {
        reserved: 0,
        actual: MAX_BOARD_FILE_BYTES,
      });
      expect(response.status, `settle ${index}`).toBe(200);
    }
    expect(await total(roomId)).toBe(MAX_ROOM_FILE_BYTES_TOTAL);

    const refused = await postFileAction(roomId, owner.accountId, 'settle', {
      reserved: 0,
      actual: MAX_BOARD_FILE_BYTES,
    });
    expect(refused.status).toBe(413);
    expect(await total(roomId)).toBe(MAX_ROOM_FILE_BYTES_TOTAL);
  });

  it('settles to zero rather than below zero when the counter was already reduced', async () => {
    const roomId = `quota-settle-floor-${crypto.randomUUID()}`;
    const owner = await createOwnedRoom(roomId);
    await setTotal(roomId, 0);

    const settled = await postFileAction(roomId, owner.accountId, 'settle', {
      reserved: 300,
      actual: 0,
    });
    expect(settled.status).toBe(200);
    expect(await total(roomId)).toBe(0);
  });
});
