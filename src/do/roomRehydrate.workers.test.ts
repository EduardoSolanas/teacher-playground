import { afterEach, describe, expect, it } from 'vitest';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import * as Y from 'yjs';
import { RoomDO } from './RoomDO';
import { getElementsFromArray, replaceSharedElements } from '../lib/whiteboard/yjsDoc';
import { snapshotChunkKey, snapshotMetaKey } from '../lib/whiteboard/snapshotChunks';
import { applyStoredSnapshot, snapshotFormatKey } from '../lib/whiteboard/snapshotFormat';

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

function docWithElements(elements: unknown[]): Y.Doc {
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
  return doc;
}

/** Writes a V1 snapshot of a document holding exactly `elements`. */
async function seedSnapshot(roomId: string, elements: unknown[]) {
  const snapshot = Y.encodeStateAsUpdate(docWithElements(elements));
  await runInDurableObject(roomStub(roomId), async (_instance, state) => {
    await state.storage.put(snapshotMetaKey(roomId), 1);
    await state.storage.put(snapshotChunkKey(roomId, 0), snapshot);
  });
}

/** Writes a V2 snapshot of a document holding exactly `elements`, with the format key set. */
async function seedSnapshotV2(roomId: string, elements: unknown[]) {
  const snapshot = Y.encodeStateAsUpdateV2(docWithElements(elements));
  await runInDurableObject(roomStub(roomId), async (_instance, state) => {
    await state.storage.put(snapshotMetaKey(roomId), 1);
    await state.storage.put(snapshotChunkKey(roomId, 0), snapshot);
    await state.storage.put(snapshotFormatKey(roomId), 2);
  });
}

/** Writes raw bytes as a room's single chunk under the given format value. */
async function seedRawSnapshot(roomId: string, bytes: Uint8Array, format: number) {
  await runInDurableObject(roomStub(roomId), async (_instance, state) => {
    await state.storage.put(snapshotMetaKey(roomId), 1);
    await state.storage.put(snapshotChunkKey(roomId, 0), bytes);
    await state.storage.put(snapshotFormatKey(roomId), format);
  });
}

/** Snapshot of every storage key a room's board occupies, for byte-identity checks. */
async function boardStorageSnapshot(roomId: string): Promise<Record<string, unknown>> {
  return runInDurableObject(roomStub(roomId), async (_instance, state) => {
    const out: Record<string, unknown> = {};
    out[snapshotMetaKey(roomId)] = await state.storage.get(snapshotMetaKey(roomId));
    out[snapshotFormatKey(roomId)] = await state.storage.get(snapshotFormatKey(roomId));
    const chunks = await state.storage.list({ prefix: snapshotChunkKey(roomId, 0).slice(0, -1) });
    out.chunks = Object.fromEntries(
      Array.from(chunks.entries(), ([key, value]) => [key, Array.from(value as Uint8Array)]),
    );
    return out;
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

/** Loads a room's document, mutates it so it is dirty, and flushes it. */
async function editAndFlush(roomId: string, elementId: string): Promise<void> {
  await runInDurableObject(roomStub(roomId), async (instance) => {
    const boxed = instance as unknown as {
      getRoomDoc: (roomId: string) => Promise<Y.Doc>;
      flushDirtyDocs: () => Promise<void>;
    };
    const doc = await boxed.getRoomDoc(roomId);
    doc.transact(() => {
      const map = new Y.Map<unknown>();
      map.set('id', elementId);
      map.set('type', 'rectangle');
      doc.getArray<Y.Map<unknown>>('elements').push([map]);
    });
    await boxed.flushDirtyDocs();
  });
}

async function storedFormat(roomId: string): Promise<number | undefined> {
  return runInDurableObject(roomStub(roomId), async (_instance, state) => (
    state.storage.get(snapshotFormatKey(roomId)) as Promise<number | undefined>
  ));
}

async function storedChunkCount(roomId: string): Promise<number | undefined> {
  return runInDurableObject(roomStub(roomId), async (_instance, state) => (
    state.storage.get(snapshotMetaKey(roomId)) as Promise<number | undefined>
  ));
}

async function storedChunkKeyCount(roomId: string): Promise<number> {
  return runInDurableObject(roomStub(roomId), async (_instance, state) => (
    (await state.storage.list({ prefix: snapshotChunkKey(roomId, 0).slice(0, -1) })).size
  ));
}

/** Loads a room's document, replaces its elements wholesale, and flushes it. */
async function replaceElementsAndFlush(
  roomId: string,
  elements: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  await runInDurableObject(roomStub(roomId), async (instance) => {
    const boxed = instance as unknown as {
      getRoomDoc: (roomId: string) => Promise<Y.Doc>;
      flushDirtyDocs: () => Promise<void>;
    };
    const doc = await boxed.getRoomDoc(roomId);
    replaceSharedElements(doc, doc.getArray('elements'), elements, 'test-replace');
    await boxed.flushDirtyDocs();
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

  it('still opens a legacy room with no format key at all (V1 pin)', async () => {
    const roomId = 'rehydrate-legacy-no-format';
    await seedRow(roomId, []);
    await seedSnapshot(roomId, [{ id: 'legacy-el', type: 'rectangle' }]);

    const elements = await docElements(roomId);
    expect(elements).toHaveLength(1);
    expect((elements[0] as { id: string }).id).toBe('legacy-el');
  });

  it('still opens a room written under the pre-chunking single key (legacy pin)', async () => {
    const roomId = 'rehydrate-legacy-single-key';
    await seedRow(roomId, []);
    const snapshot = Y.encodeStateAsUpdate(docWithElements([{ id: 'single-key-el', type: 'diamond' }]));
    await runInDurableObject(roomStub(roomId), async (_instance, state) => {
      await state.storage.put(`ydoc:${roomId}`, snapshot);
    });

    const elements = await docElements(roomId);
    expect(elements).toHaveLength(1);
    expect((elements[0] as { id: string }).id).toBe('single-key-el');
  });
});

describe('snapshot format dispatch', () => {
  it('opens a V2-formatted room and returns exactly that board', async () => {
    const roomId = 'format-v2-room';
    await seedRow(roomId, []);
    await seedSnapshotV2(roomId, [{ id: 'v2-el', type: 'ellipse' }]);

    const elements = await docElements(roomId);
    expect(elements).toHaveLength(1);
    expect((elements[0] as { id: string }).id).toBe('v2-el');
  });

  it('refuses to open a room whose format value this build does not know, and does not overwrite it', async () => {
    const roomId = 'format-unknown-room';
    await seedRow(roomId, []);
    const snapshot = Y.encodeStateAsUpdate(docWithElements([{ id: 'unknown-format-el', type: 'rectangle' }]));
    await seedRawSnapshot(roomId, snapshot, 3);

    const before = await boardStorageSnapshot(roomId);

    await expect(docElements(roomId)).rejects.toThrow();

    // A flush (via the alarm) must not overwrite bytes it could not read: a
    // seeded projection retry marker forces the flush's projection loop to
    // attempt to open this room, exactly like a stale marker surviving an
    // eviction would.
    await runInDurableObject(roomStub(roomId), async (_instance, state) => {
      await state.storage.put(`ydoc-projection:${roomId}`, true);
    });
    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => instance.alarm());

    const after = await boardStorageSnapshot(roomId);
    expect(after).toEqual(before);
  });

  it('refuses to open a room whose bytes fail to decode under their stated format, and does not overwrite it', async () => {
    const roomId = 'format-decode-failed-room';
    await seedRow(roomId, []);
    // Format 2 (V2) claimed, but the bytes are V1 -- garbage under V2 decoding.
    const v1Bytes = Y.encodeStateAsUpdate(docWithElements([{ id: 'wrong-format-el', type: 'rectangle' }]));
    await seedRawSnapshot(roomId, v1Bytes, 2);

    const before = await boardStorageSnapshot(roomId);

    await expect(docElements(roomId)).rejects.toThrow();

    await runInDurableObject(roomStub(roomId), async (_instance, state) => {
      await state.storage.put(`ydoc-projection:${roomId}`, true);
    });
    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => instance.alarm());

    const after = await boardStorageSnapshot(roomId);
    expect(after).toEqual(before);
  });
});

describe('snapshot format writer (V2 only)', () => {
  async function storedSnapshotBytes(roomId: string): Promise<Uint8Array> {
    return runInDurableObject(roomStub(roomId), async (_instance, state) => {
      const count = await state.storage.get(snapshotMetaKey(roomId)) as number;
      const keys = Array.from({ length: count }, (_, index) => snapshotChunkKey(roomId, index));
      const chunks = await state.storage.get(keys) as Map<string, Uint8Array>;
      const parts = keys.map((key) => {
        const chunk = chunks.get(key);
        if (!chunk) throw new Error(`missing chunk ${key}`);
        return chunk;
      });
      const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        joined.set(part, offset);
        offset += part.byteLength;
      }
      return joined;
    });
  }

  it('stores V2 bytes and records format 2', async () => {
    const roomId = 'format-writer-v2';
    await seedRow(roomId, []);
    await editAndFlush(roomId, 'v2-el');

    expect(await storedFormat(roomId)).toBe(2);

    const stored = await storedSnapshotBytes(roomId);
    const round = new Y.Doc();
    applyStoredSnapshot(round, stored, 2);
    expect(getElementsFromArray(round.getArray('elements'))).toEqual([
      expect.objectContaining({ id: 'v2-el' }),
    ]);
  });

  it('stores a history-heavy board smaller than its V1 encoding, and it survives eviction', async () => {
    const roomId = 'format-writer-history';
    await seedRow(roomId, []);
    await runInDurableObject(roomStub(roomId), async (instance) => {
      const boxed = instance as unknown as {
        getRoomDoc: (roomId: string) => Promise<Y.Doc>;
        flushDirtyDocs: () => Promise<void>;
      };
      const doc = await boxed.getRoomDoc(roomId);
      doc.transact(() => {
        const arr = doc.getArray<Y.Map<unknown>>('elements');
        for (let i = 0; i < 10; i++) {
          const m = new Y.Map<unknown>();
          m.set('id', `hist-${i}`);
          m.set('type', 'rectangle');
          m.set('x', i * 10);
          arr.push([m]);
        }
      });
      // Forty rounds of moves with no flush in between: the item store
      // accumulates exactly the history the V2 encoder collapses.
      for (let round = 1; round <= 40; round++) {
        doc.transact(() => {
          const arr = doc.getArray<Y.Map<unknown>>('elements');
          for (let i = 0; i < arr.length; i++) {
            const m = arr.get(i);
            m.set('x', (m.get('x') as number) + 3);
            m.set('version', round + 1);
          }
        });
      }
      await boxed.flushDirtyDocs();
    });

    const stored = await storedSnapshotBytes(roomId);
    const decoded = new Y.Doc();
    applyStoredSnapshot(decoded, stored, 2);
    const v1 = Y.encodeStateAsUpdate(decoded);
    expect(stored.byteLength).toBeLessThan(v1.byteLength);

    await evictDurableObject(roomStub(roomId));
    const elements = await docElements(roomId) as Array<{ id: string; x: number }>;
    expect(elements).toHaveLength(10);
    expect(elements.map((e) => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => `hist-${i}`));
    // Every round's move landed: the last writer's x wins, per element.
    expect(new Set(elements.map((e) => e.x))).toEqual(new Set(Array.from({ length: 10 }, (_, i) => i * 10 + 120)));
  });
});

describe('snapshot chunk list-skip correctness', () => {
  afterEach(() => {
    RoomDO.snapshotChunkBytesForTests = null;
  });

  it('leaves no stale trailing chunk behind when a board shrinks after eviction lost the in-memory count', async () => {
    const roomId = 'chunk-list-skip-room';
    RoomDO.snapshotChunkBytesForTests = 64;
    await seedRow(roomId, []);

    // Many elements, chunked small: several chunk keys.
    const bigBoard = Array.from({ length: 30 }, (_, i) => ({ id: `big-${i}`, type: 'rectangle' }));
    await replaceElementsAndFlush(roomId, bigBoard);
    const before = await storedChunkCount(roomId);
    expect(before).toBeGreaterThan(1);
    expect(await storedChunkKeyCount(roomId)).toBe(before);

    // A real eviction: a fresh RoomDO instance holds none of this object's
    // in-memory bookkeeping, including the last-known chunk count.
    await evictDurableObject(roomStub(roomId));

    // Shrink drastically and flush again from the fresh instance.
    await replaceElementsAndFlush(roomId, [{ id: 'small-1', type: 'rectangle' }]);
    const after = await storedChunkCount(roomId);
    expect(after).toBeLessThan(before!);

    // No chunk key beyond the new count may survive: a stale one would be
    // read back as part of the board the next time it grew to that length.
    expect(await storedChunkKeyCount(roomId)).toBe(after);
    expect(await docElements(roomId)).toEqual([{ id: 'small-1', type: 'rectangle' }]);
  });
});

describe('legacy snapshot key cleanup (S6)', () => {
  it('deletes the legacy key only once a room loaded from it flushes, and chunks keep the board across eviction', async () => {
    const roomId = 'legacy-cleanup-room';
    await seedRow(roomId, []);
    const snapshot = Y.encodeStateAsUpdate(docWithElements([{ id: 'legacy-cleanup-el', type: 'rectangle' }]));
    await runInDurableObject(roomStub(roomId), async (_instance, state) => {
      await state.storage.put(`ydoc:${roomId}`, snapshot);
    });

    // Opening the room reads the legacy key but must not delete it yet --
    // nothing has replaced it in storage, so a crash right now must still
    // find the board there.
    await docElements(roomId);
    expect(await runInDurableObject(roomStub(roomId), (_instance, state) => (
      state.storage.get(`ydoc:${roomId}`)
    ))).toBeDefined();

    // The room's first post-chunking flush is what retires the legacy key.
    await editAndFlush(roomId, 'legacy-cleanup-el2');
    expect(await runInDurableObject(roomStub(roomId), (_instance, state) => (
      state.storage.get(`ydoc:${roomId}`)
    ))).toBeUndefined();

    // A real eviction: a fresh instance holds none of this object's in-memory
    // bookkeeping and must read the board from chunks alone, with no legacy
    // key left to fall back on.
    await evictDurableObject(roomStub(roomId));
    const elements = await docElements(roomId);
    expect(elements.map((element) => (element as { id: string }).id).sort()).toEqual(
      ['legacy-cleanup-el', 'legacy-cleanup-el2'].sort(),
    );
    expect(await runInDurableObject(roomStub(roomId), (_instance, state) => (
      state.storage.get(`ydoc:${roomId}`)
    ))).toBeUndefined();
  });

  it('leaves a legacy key alone on flush when the room never actually loaded from it', async () => {
    const roomId = 'legacy-untouched-room';
    await seedRow(roomId, []);
    // A normal chunk-based snapshot: this room's readSnapshot never takes the
    // legacy branch at all.
    await seedSnapshot(roomId, [{ id: 'chunked-el', type: 'rectangle' }]);
    // A stray value sitting under the legacy key regardless -- a restore, a
    // hand-edit, whatever -- that this room never read as its board.
    await runInDurableObject(roomStub(roomId), async (_instance, state) => {
      await state.storage.put(`ydoc:${roomId}`, new Uint8Array([1, 2, 3]));
    });

    await editAndFlush(roomId, 'chunked-el2');

    // The flush never loaded from the legacy key, so it must not delete it.
    expect(await runInDurableObject(roomStub(roomId), (_instance, state) => (
      state.storage.get(`ydoc:${roomId}`)
    ))).toBeDefined();
  });
});
