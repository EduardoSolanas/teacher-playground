/**
 * Splitting a board snapshot across storage values.
 *
 * A SQLite-backed Durable Object allows 2 MB in one value and 10 GB in the
 * object. The board was written to a single key, so the document met the
 * smaller of those two numbers first: past 2 MB the write throws, the room
 * stays dirty, and it retries on every flush forever. A board that has silently
 * stopped being saved looks exactly like one that is safe -- and it is not a
 * hypothetical, a production room passed it and then passed 4 MiB.
 *
 * A document is not a value, so it should never have been stored as one. Split
 * across keys, the ceiling that applies is the object's, four orders of
 * magnitude further away.
 */

/**
 * Bytes per stored chunk.
 *
 * Half the 2 MB value limit. The margin is not superstition: the limit counts
 * the key and the value's own framing as well as the bytes handed over, and a
 * board that fails to save is invisible, so the cost of being close to the line
 * is far higher than the cost of one more key.
 */
export const SNAPSHOT_CHUNK_BYTES = 1_000_000;

/** Key holding the chunk count for a room's snapshot. */
export function snapshotMetaKey(roomId: string): string {
  return `ydoc-meta:${roomId}`;
}

/** Key holding one chunk of a room's snapshot. */
export function snapshotChunkKey(roomId: string, index: number): string {
  return `ydoc-chunk:${roomId}:${index}`;
}

/**
 * The pre-chunking key, still read so boards written before this survive.
 *
 * Rooms are long-lived and there is no migration step: the first flush after
 * this lands writes chunks and removes the old key, and until then the old key
 * is the board.
 */
export function legacySnapshotKey(roomId: string): string {
  return `ydoc:${roomId}`;
}

/** Splits a snapshot into storable pieces. An empty snapshot yields no chunks. */
export function chunkSnapshot(
  snapshot: Uint8Array,
  chunkBytes: number = SNAPSHOT_CHUNK_BYTES,
): Uint8Array[] {
  if (chunkBytes < 1) throw new RangeError('chunkBytes must be at least 1');
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < snapshot.byteLength; offset += chunkBytes) {
    chunks.push(snapshot.subarray(offset, Math.min(offset + chunkBytes, snapshot.byteLength)));
  }
  return chunks;
}

/**
 * Rejoins chunks into the snapshot they came from.
 *
 * A missing chunk is not recoverable and must not be papered over: half a Yjs
 * update applied to a document is not a smaller board, it is a corrupt one.
 */
export function joinSnapshotChunks(chunks: ReadonlyArray<Uint8Array | undefined>): Uint8Array | null {
  if (chunks.length === 0) return null;
  let total = 0;
  for (const chunk of chunks) {
    if (!chunk) return null;
    total += chunk.byteLength;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk!, offset);
    offset += chunk!.byteLength;
  }
  return joined;
}
