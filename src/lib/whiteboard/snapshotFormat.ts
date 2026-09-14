/**
 * Which binary encoding a stored board snapshot was written in.
 *
 * Both V1 (`Y.encodeStateAsUpdate` / `Y.applyUpdate`) and V2
 * (`Y.encodeStateAsUpdateV2` / `Y.applyUpdateV2`) carry identical information
 * and decode to an identical document, but the bytes are not interchangeable:
 * V1 bytes fed to `applyUpdateV2`, or V2 bytes fed to `applyUpdate`, throw or
 * corrupt. A stored snapshot therefore needs its format recorded alongside it
 * so a reader written for one build can dispatch correctly, including across
 * a rollback to a build that only understands V1.
 */

import * as Y from 'yjs';

/**
 * Key holding a room's snapshot format, `1` or `2`.
 *
 * Absent means V1 -- every room predating this key. Kept as its own key
 * rather than folded into the chunk-count value or a byte prefixed onto
 * chunk 0: the chunk-count value already means "no snapshot" for anything
 * that isn't a number, and a byte on chunk 0 would make the joined bytes
 * something an older build applies as a corrupt update.
 */
export function snapshotFormatKey(roomId: string): string {
  return `ydoc-format:${roomId}`;
}

/**
 * The format the writer produces, for this build.
 *
 * Phase 1 (S7a) ships the format key and a dispatching reader while still
 * writing V1 explicitly -- writing `1` rather than omitting the key is what
 * makes a rollback from phase 2 safe, since a phase-1 build rewriting a room
 * clears a stored `2` in the same atomic put. Phase 2 (S7b) flips this to `2`
 * only once phase 1 is the production rollback target.
 */
export const SNAPSHOT_WRITE_FORMAT = 1;

/** A stored snapshot names a format this build does not know how to decode. */
export class SnapshotFormatUnknownError extends Error {
  constructor(public readonly format: unknown) {
    super(`Unknown snapshot format: ${String(format)}`);
    this.name = 'SnapshotFormatUnknownError';
  }
}

/** A stored snapshot's bytes did not decode under the format they claim. */
export class SnapshotDecodeError extends Error {
  constructor(cause: unknown) {
    super('Failed to decode stored snapshot bytes');
    this.name = 'SnapshotDecodeError';
    this.cause = cause;
  }
}

/**
 * Applies stored snapshot bytes to `doc`, dispatching on the format they were
 * written in.
 *
 * Undefined or `1` means V1 (the legacy key is always V1); `2` means V2. Any
 * other value, or a decode that throws, is a caller's problem to fail closed
 * over -- this function never falls back to treating unreadable bytes as an
 * empty document.
 */
export function applyStoredSnapshot(doc: Y.Doc, bytes: Uint8Array, format: number | undefined): void {
  if (format === undefined || format === 1) {
    try {
      Y.applyUpdate(doc, bytes);
    } catch (error) {
      throw new SnapshotDecodeError(error);
    }
    return;
  }
  if (format === 2) {
    try {
      Y.applyUpdateV2(doc, bytes);
    } catch (error) {
      throw new SnapshotDecodeError(error);
    }
    return;
  }
  throw new SnapshotFormatUnknownError(format);
}
