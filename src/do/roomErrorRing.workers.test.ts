import { afterEach, describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import * as Y from 'yjs';
import { RoomDO } from './RoomDO';
import { snapshotChunkKey, snapshotMetaKey } from '../lib/whiteboard/snapshotChunks';
import { snapshotFormatKey } from '../lib/whiteboard/snapshotFormat';

/*
 * The bounded error ring (OPS-01): internal errors RoomDO used to whisper to
 * the console are kept in the room's own SQLite so /admin can surface them.
 */

function roomStub(roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)) as DurableObjectStub<RoomDO>;
}

afterEach(async () => {
  await runInDurableObject(roomStub('ring-route-room'), (instance) => {
    instance.db.prepare(`DELETE FROM error_ring`).run();
  });
  await runInDurableObject(roomStub('ring-projection-room'), (instance) => {
    instance.db.prepare(`DELETE FROM error_ring`).run();
  });
});

describe('RoomDO /room/errors ring', () => {
  it('answers GET with the ring newest first and refuses other methods', async () => {
    const roomId = 'ring-route-room';
    await runInDurableObject(roomStub(roomId), (instance) => {
      instance.db
        .prepare(`INSERT INTO error_ring (at, scope, message) VALUES (?, ?, ?)`)
        .run(1000, 'flushProjection', 'older failure');
      instance.db
        .prepare(`INSERT INTO error_ring (at, scope, message) VALUES (?, ?, ?)`)
        .run(2000, 'stageSyncUpdate', 'newer failure');
    });

    const response = await roomStub(roomId).fetch(
      `https://room/room/errors?roomId=${encodeURIComponent(roomId)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      errors: [
        { at: 2000, scope: 'stageSyncUpdate', message: 'newer failure' },
        { at: 1000, scope: 'flushProjection', message: 'older failure' },
      ],
    });

    const posted = await roomStub(roomId).fetch(
      `https://room/room/errors?roomId=${encodeURIComponent(roomId)}`,
      { method: 'POST' },
    );
    expect(posted.status).toBe(405);
  });

  it('records a real projection failure into the ring when the alarm flush cannot read a snapshot', async () => {
    const roomId = 'ring-projection-room';
    // A room row and a snapshot whose format this build does not know: the
    // flush's projection attempt must fail closed.
    await runInDurableObject(roomStub(roomId), (instance) => {
      instance.db
        .prepare(
          `INSERT INTO rooms (room_id, elements, viewport, created_at, updated_at)
           VALUES (?, '[]', '{"x":0,"y":0,"zoom":1}', ?, ?)`,
        )
        .run(roomId, Date.now(), Date.now());
    });
    await runInDurableObject(roomStub(roomId), async (_instance, state) => {
      await state.storage.put(snapshotMetaKey(roomId), 1);
      await state.storage.put(
        snapshotChunkKey(roomId, 0),
        Y.encodeStateAsUpdate(new Y.Doc()),
      );
      await state.storage.put(snapshotFormatKey(roomId), 3);
      // The stale retry marker forces the projection loop to open this room.
      await state.storage.put(`ydoc-projection:${roomId}`, true);
    });

    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => instance.alarm());

    const response = await roomStub(roomId).fetch(
      `https://room/room/errors?roomId=${encodeURIComponent(roomId)}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      errors: { at: number; scope: string; message: string }[];
    };
    expect(body.errors.length).toBeGreaterThanOrEqual(1);
    expect(body.errors[0].scope).toBe('flushProjectionGetRoomDoc');
    expect(typeof body.errors[0].at).toBe('number');
    expect(body.errors[0].message.length).toBeGreaterThan(0);
  });
});
