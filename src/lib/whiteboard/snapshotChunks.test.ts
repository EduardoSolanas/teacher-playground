import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import {
  SNAPSHOT_CHUNK_BYTES,
  chunkSnapshot,
  joinSnapshotChunks,
  legacySnapshotKey,
  snapshotChunkKey,
  snapshotMetaKey,
} from './snapshotChunks';

describe('snapshot chunking', () => {
  it('stays under the value limit for a snapshot far past it', () => {
    const snapshot = new Uint8Array(5_000_000);
    const chunks = chunkSnapshot(snapshot);
    expect(chunks.length).toBe(5);
    for (const chunk of chunks) {
      expect(chunk.byteLength).toBeLessThanOrEqual(SNAPSHOT_CHUNK_BYTES);
    }
  });

  it('round-trips a real Yjs document through split and rejoin', () => {
    const doc = new Y.Doc();
    const elements = doc.getArray<Y.Map<unknown>>('elements');
    doc.transact(() => {
      for (let i = 0; i < 500; i += 1) {
        const map = new Y.Map<unknown>();
        map.set('id', `element-${i}`);
        map.set('points', Array.from({ length: 50 }, (_, p) => [p, p * 2]));
        elements.push([map]);
      }
    });
    const snapshot = Y.encodeStateAsUpdate(doc);

    // A chunk size that guarantees several pieces for a board this size.
    const chunks = chunkSnapshot(snapshot, 1024);
    expect(chunks.length).toBeGreaterThan(1);

    const rejoined = joinSnapshotChunks(chunks);
    expect(rejoined).not.toBeNull();

    const restored = new Y.Doc();
    Y.applyUpdate(restored, rejoined!);
    expect(restored.getArray('elements').length).toBe(500);
    expect((restored.getArray<Y.Map<unknown>>('elements').get(499)).get('id')).toBe('element-499');
  });

  it('yields no chunks for an empty snapshot', () => {
    expect(chunkSnapshot(new Uint8Array(0))).toEqual([]);
  });

  it('splits exactly on the boundary without a trailing empty chunk', () => {
    const chunks = chunkSnapshot(new Uint8Array(2048), 1024);
    expect(chunks.length).toBe(2);
    expect(chunks[0].byteLength).toBe(1024);
    expect(chunks[1].byteLength).toBe(1024);
  });

  it('refuses to rejoin when a chunk is missing rather than returning a short buffer', () => {
    const snapshot = new Uint8Array([1, 2, 3, 4]);
    const chunks: Array<Uint8Array | undefined> = chunkSnapshot(snapshot, 2);
    chunks[1] = undefined;
    // Half a Yjs update is a corrupt document, not a smaller one.
    expect(joinSnapshotChunks(chunks)).toBeNull();
  });

  it('returns null for no chunks at all', () => {
    expect(joinSnapshotChunks([])).toBeNull();
  });

  it('rejects a chunk size that could never terminate', () => {
    expect(() => chunkSnapshot(new Uint8Array(4), 0)).toThrow(RangeError);
  });

  it('keys are distinct per room and per index', () => {
    expect(snapshotMetaKey('room-a')).not.toBe(snapshotMetaKey('room-b'));
    expect(snapshotChunkKey('room-a', 0)).not.toBe(snapshotChunkKey('room-a', 1));
    expect(snapshotChunkKey('room-a', 0)).not.toBe(legacySnapshotKey('room-a'));
  });
});
