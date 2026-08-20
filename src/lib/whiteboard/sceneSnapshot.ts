/**
 * What goes into the stored board snapshot.
 *
 * Excalidraw marks erased elements `isDeleted` rather than removing them, and
 * every freedraw stroke carries its full point array — roughly 10KB apiece. A
 * snapshot that keeps them grows every time a board is drawn on and erased and
 * never shrinks, until the save exceeds the request body cap and starts
 * failing 413. That failure is swallowed, so the board silently stops being
 * saved at all.
 *
 * The snapshot is the restore-the-board copy, so a tombstone has no value in
 * it: restoring one only re-adds an invisible element. Tombstones still travel
 * over Yjs, where they stop a reconnecting peer resurrecting an erased stroke.
 */

/** An element is a tombstone when Excalidraw has flagged it deleted. */
function isTombstone(element: unknown): boolean {
  return (
    typeof element === 'object'
    && element !== null
    && (element as { isDeleted?: unknown }).isDeleted === true
  );
}

/** The elements worth storing: everything still visible on the board. */
export function snapshotElements<T>(elements: readonly T[]): T[] {
  return elements.filter((element) => !isTombstone(element));
}
