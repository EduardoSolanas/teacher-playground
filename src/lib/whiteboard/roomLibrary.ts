/**
 * A room's shape library.
 *
 * Excalidraw keeps its library in the browser, which for a tutor means the
 * shapes they built up on one laptop are simply not there on another, and are
 * gone when site data is cleared. Holding it against the room instead makes it
 * a property of the lesson rather than of the machine somebody happened to
 * teach from.
 *
 * Deliberately not in the shared document. Library items are whole elements
 * and they only ever accumulate, and that document is already the thing whose
 * weight makes an old room slow -- it is transferred on every join and its
 * history is kept. The library is also not part of the board: students never
 * see it, it does not sync while drawing, and nothing about it belongs in a
 * scene. It gets its own key.
 */

/**
 * What a room's library may weigh.
 *
 * A stored value in a SQLite-backed Durable Object may reach 2MB, and passing
 * that fails the write rather than truncating it. A library that grew past the
 * limit would therefore stop saving silently, which is the same trap the board
 * snapshot has and the reason it has a budget too. A quarter of a megabyte is
 * a great many shapes and leaves the ceiling far away.
 */
export const MAX_LIBRARY_BYTES = 256 * 1024;

/** How much a library will take to store. */
export function libraryBytes(items: readonly unknown[]): number {
  return new TextEncoder().encode(JSON.stringify(items)).byteLength;
}

/**
 * The items out of a request body, or null if it is not a library.
 *
 * Shape only, not contents: the items are Excalidraw's own and this is the
 * owner's own data being handed back to them, so there is nothing to sanitise
 * that Excalidraw does not already handle when it reads them. What must be
 * checked is that it is a list of objects at all, because it is written to
 * storage under the room and read back into an editor.
 */
export function parseLibraryItems(payload: unknown): unknown[] | null {
  const items = (payload as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  }
  return items;
}

export type LibraryRejection = 'malformed' | 'too-large';

/**
 * Whether a library may be stored, and if not, which way it is wrong.
 *
 * The two answers want different replies -- a body that is not a library is
 * the caller's mistake, a library that is too big is the teacher's shapes
 * outgrowing what a room will hold -- and a teacher can only be told which if
 * they are distinguished here.
 */
export function checkLibraryItems(
  payload: unknown,
): { ok: true; items: unknown[] } | { ok: false; reason: LibraryRejection } {
  const items = parseLibraryItems(payload);
  if (items === null) return { ok: false, reason: 'malformed' };
  if (libraryBytes(items) > MAX_LIBRARY_BYTES) return { ok: false, reason: 'too-large' };
  return { ok: true, items };
}

/** The storage key a room's library lives under. */
export function libraryStorageKey(roomId: string): string {
  return `library:${roomId}`;
}

/** A stored value read back, defended against anything that is not a library. */
export function storedLibraryItems(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Every file a stored library refers to.
 *
 * The orphan sweep decides what to delete by asking what the board still
 * mentions, and a library item is not on the board -- so a picture saved as a
 * shape and then erased from the canvas would be swept ten minutes later and
 * the saved shape would go blank. That failure surfaces weeks after the cause,
 * as "my library stopped working", which is close to untraceable.
 *
 * Read leniently on purpose. This decides whether bytes are kept, so anything
 * it cannot make sense of should leave the file alone rather than collect it:
 * an unreadable library is a reason to keep pictures, not to delete them.
 */
export function libraryFileIds(items: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const fileId = record.fileId;
    if (typeof fileId === 'string' && fileId.length > 0) ids.add(fileId);
    for (const entry of Object.values(record)) visit(entry, depth + 1);
  };
  visit(items, 0);
  return ids;
}
