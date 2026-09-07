import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import * as Y from 'yjs';
import type { RoomDO } from './RoomDO';
import { getElementsFromArray } from '../lib/whiteboard/yjsDoc';
import { snapshotChunkKey, snapshotMetaKey } from '../lib/whiteboard/snapshotChunks';

/*
 * A board that was saved must come back.
 *
 * The room row and the Yjs snapshot are written by different paths: the client
 * POSTs its scene straight to the row, while the snapshot is written by the
 * durable object's flush. So the row can hold a board that the snapshot has not
 * caught up with yet -- paste a picture, save, and reload before the flush runs.
 *
 * Rehydrating seeded from the row only when there was no snapshot at all. An
 * empty snapshot counted as a snapshot, so the seed was skipped and the room
 * opened blank on top of a row that still held the drawing. In CI this showed up
 * as "saved=1 elements=0": persisted, and not restored.
 */

function roomStub(roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)) as DurableObjectStub<RoomDO>;
}

const ELEMENT = { id: 'kept-1', type: 'rectangle', x: 1, y: 2, width: 3, height: 4 };

async function seedRow(roomId: string, elements: unknown[]) {
  await runInDurableObject(roomStub(roomId), (instance) => {
    instance.db
      .prepare(
        `INSERT INTO rooms (room_id, elements, viewport, created_at, updated_at)
         VALUES (?, ?, '{"x":0,"y":0,"zoom":1}', ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET elements = excluded.elements`,
      )
      .run(roomId, JSON.stringify(elements), Date.now(), Date.now());
  });
}

/** Writes a snapshot of a document holding exactly `elements`. */
async function seedSnapshot(roomId: string, elements: unknown[]) {
  const doc = new Y.Doc();
  const array = doc.getArray<Y.Map<unknown>>('elements');
  doc.transact(() => {
    for (const element of elements) {
      const map = new Y.Map<unknown>();
      for (const [key, value] of Object.entries(element as Record<string, unknown>)) {
        map.set(key, value);
      }
      array.push([map]);
    }
  });
  const snapshot = Y.encodeStateAsUpdate(doc);
  await runInDurableObject(roomStub(roomId), async (_instance, state) => {
    await state.storage.put(snapshotMetaKey(roomId), 1);
    await state.storage.put(snapshotChunkKey(roomId, 0), snapshot);
  });
}

async function docElements(roomId: string): Promise<unknown[]> {
  return runInDurableObject(roomStub(roomId), async (instance) => {
    const doc = await (instance as unknown as {
      getRoomDoc: (roomId: string) => Promise<Y.Doc>;
    }).getRoomDoc(roomId);
    return getElementsFromArray(doc.getArray('elements')) as unknown[];
  });
}

describe('rehydrating a room document', () => {
  it('falls back to the saved row when the snapshot is empty', async () => {
    const roomId = 'rehydrate-empty-snapshot';
    await seedRow(roomId, [ELEMENT]);
    await seedSnapshot(roomId, []);

    const elements = await docElements(roomId);
    expect(elements).toHaveLength(1);
    expect((elements[0] as { id: string }).id).toBe('kept-1');
  });

  it('still seeds from the row when there is no snapshot at all', async () => {
    const roomId = 'rehydrate-no-snapshot';
    await seedRow(roomId, [ELEMENT]);

    const elements = await docElements(roomId);
    expect(elements).toHaveLength(1);
  });

  it('prefers the snapshot when it holds a board', async () => {
    /*
     * The snapshot is the live document and the row is a projection of it, so
     * a snapshot with content must win. Seeding over it would resurrect
     * elements somebody had just erased.
     */
    const roomId = 'rehydrate-snapshot-wins';
    await seedRow(roomId, [ELEMENT]);
    await seedSnapshot(roomId, [{ id: 'from-snapshot', type: 'ellipse' }]);

    const elements = await docElements(roomId);
    expect(elements).toHaveLength(1);
    expect((elements[0] as { id: string }).id).toBe('from-snapshot');
  });

  it('leaves an emptied board empty when the row agrees', async () => {
    const roomId = 'rehydrate-both-empty';
    await seedRow(roomId, []);
    await seedSnapshot(roomId, []);

    expect(await docElements(roomId)).toHaveLength(0);
  });
});
