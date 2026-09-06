import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { RoomDO } from './RoomDO';
import { getFileBytesTotal, addFileBytes } from '../lib/whiteboard/roomSchema';
import { MAX_ROOM_FILE_BYTES_TOTAL } from '../lib/whiteboard/boardFileRoutes';

/*
 * The aggregate quota counts bytes uploaded. Nothing counted them back down.
 *
 * A file leaves R2 when the orphan sweep finds it is no longer referenced by
 * the board -- a teacher pastes a photo, erases it, and the sweep collects it.
 * The bytes are gone from the bucket at that point, but they were still being
 * charged against the room's 250 MB, permanently. Upload and erase enough times
 * and a room is refused new files while holding almost nothing.
 */

function roomStub(roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)) as DurableObjectStub<RoomDO>;
}

async function seedRoomWithFile(roomId: string, fileId: string, bytes: number, referenced: boolean) {
  const key = `rooms/${roomId}/files/${fileId}`;
  await env.BOARD_FILES.put(key, new Uint8Array(bytes));

  await runInDurableObject(roomStub(roomId), (instance) => {
    const elements = referenced
      ? JSON.stringify([{ id: 'e1', type: 'image', fileId }])
      : JSON.stringify([]);
    instance.db
      .prepare(
        `INSERT INTO rooms (room_id, elements, viewport, created_at, updated_at)
         VALUES (?, ?, '{"x":0,"y":0,"zoom":1}', ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET elements = excluded.elements`,
      )
      .run(roomId, elements, Date.now(), Date.now());
    addFileBytes(instance.db, roomId, bytes);
  });
  return key;
}

describe('aggregate file quota and the orphan sweep', () => {
  it('gives the quota back when an unreferenced file is swept', async () => {
    const roomId = 'quota-sweep-room';
    const bytes = 4096;
    const key = await seedRoomWithFile(roomId, 'orphan-1', bytes, false);

    const before = await runInDurableObject(roomStub(roomId), (instance) => (
      getFileBytesTotal(instance.db, roomId)
    ));
    expect(before).toBe(bytes);

    // Far enough ahead to clear both the sweep interval and the grace period a
    // freshly uploaded file gets before it counts as an orphan.
    await runInDurableObject(roomStub(roomId), async (instance) => {
      await (instance as unknown as {
        sweepOrphanFiles: (roomId: string, now: number) => Promise<void>;
      }).sweepOrphanFiles(roomId, Date.now() + 7 * 24 * 60 * 60 * 1000);
    });

    expect(await env.BOARD_FILES.head(key)).toBeNull();

    const after = await runInDurableObject(roomStub(roomId), (instance) => (
      getFileBytesTotal(instance.db, roomId)
    ));
    expect(after).toBe(0);
  });

  it('keeps charging for a file the board still uses', async () => {
    const roomId = 'quota-keep-room';
    const bytes = 2048;
    const key = await seedRoomWithFile(roomId, 'kept-1', bytes, true);

    await runInDurableObject(roomStub(roomId), async (instance) => {
      await (instance as unknown as {
        sweepOrphanFiles: (roomId: string, now: number) => Promise<void>;
      }).sweepOrphanFiles(roomId, Date.now() + 7 * 24 * 60 * 60 * 1000);
    });

    expect(await env.BOARD_FILES.head(key)).not.toBeNull();
    const after = await runInDurableObject(roomStub(roomId), (instance) => (
      getFileBytesTotal(instance.db, roomId)
    ));
    expect(after).toBe(bytes);
  });

  it('never drives the counter below zero', async () => {
    /*
     * The counter and the bucket can disagree -- an upload that failed after
     * the object was written was deliberately not counted, and the sweep would
     * then subtract bytes that were never added. A negative total would hand
     * that room extra quota rather than merely losing track.
     */
    const roomId = 'quota-floor-room';
    const key = await seedRoomWithFile(roomId, 'uncounted-1', 8192, false);
    await runInDurableObject(roomStub(roomId), (instance) => {
      addFileBytes(instance.db, roomId, -8192);
    });

    await runInDurableObject(roomStub(roomId), async (instance) => {
      await (instance as unknown as {
        sweepOrphanFiles: (roomId: string, now: number) => Promise<void>;
      }).sweepOrphanFiles(roomId, Date.now() + 7 * 24 * 60 * 60 * 1000);
    });

    expect(await env.BOARD_FILES.head(key)).toBeNull();
    const after = await runInDurableObject(roomStub(roomId), (instance) => (
      getFileBytesTotal(instance.db, roomId)
    ));
    expect(after).toBe(0);
    expect(after).toBeLessThanOrEqual(MAX_ROOM_FILE_BYTES_TOTAL);
  });
});
