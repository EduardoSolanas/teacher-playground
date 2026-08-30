/**
 * Building a board into a file somebody can keep.
 *
 * The platform's point-in-time recovery is the whole of the backup story for a
 * room, so until now a deleted room took the work on it with it. This is the
 * other half: a copy of a lesson that leaves the application and opens in any
 * Excalidraw, without needing the room to be opened first.
 *
 * The container is Excalidraw's own `.excalidraw` shape rather than anything
 * invented here, because the value of the file is that other software already
 * reads it. That includes the images: they travel inside the file as data
 * URLs, so the copy is complete on its own rather than being a scene full of
 * references to a bucket the reader cannot reach.
 */

/** An element as it is stored: unknown shape, read only for what is needed. */
type StoredElement = Record<string, unknown>;

/** One image, in the form Excalidraw stores in a scene file. */
export interface BoardFileEntry {
  readonly id: string;
  readonly dataURL: string;
  readonly mimeType: string;
  readonly created: number;
}

export interface ExcalidrawContainer {
  readonly type: 'excalidraw';
  readonly version: 2;
  readonly source: string;
  readonly elements: readonly StoredElement[];
  readonly appState: { readonly viewBackgroundColor: string };
  readonly files: Record<string, BoardFileEntry>;
}

/**
 * The images a scene actually refers to.
 *
 * Only what is referenced, and only once each: a board where the same
 * photograph was pasted onto four elements should carry it a single time, and
 * a board that erased its only picture should not carry it at all -- the file
 * is a copy of what is on the board, not of everything that ever was.
 */
export function referencedFileIds(elements: readonly unknown[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const element of elements) {
    const record = element as { fileId?: unknown; isDeleted?: unknown } | null;
    if (!record || record.isDeleted === true) continue;
    const fileId = record.fileId;
    if (typeof fileId !== 'string' || fileId.length === 0 || seen.has(fileId)) continue;
    seen.add(fileId);
    ids.push(fileId);
  }
  return ids;
}

/** The elements worth writing into a file: everything still on the board. */
export function exportableElements(elements: readonly unknown[]): StoredElement[] {
  return elements.filter((element) => {
    const record = element as { isDeleted?: unknown } | null;
    return record != null && typeof record === 'object' && record.isDeleted !== true;
  }) as StoredElement[];
}

/** Assembles the scene and its images into the container Excalidraw reads. */
export function buildExcalidrawContainer(
  elements: readonly unknown[],
  files: readonly BoardFileEntry[],
  source: string,
): ExcalidrawContainer {
  const kept = exportableElements(elements);
  const keptIds = new Set(referencedFileIds(kept));
  const packed: Record<string, BoardFileEntry> = {};
  for (const file of files) {
    if (keptIds.has(file.id)) packed[file.id] = file;
  }
  return {
    type: 'excalidraw',
    version: 2,
    source,
    elements: kept,
    appState: { viewBackgroundColor: '#ffffff' },
    files: packed,
  };
}

/**
 * A file name a person can find again.
 *
 * Named after the room, because a folder of files called after thirty-two
 * character identifiers is a folder nobody opens. The date is what separates
 * one export of a room from the next, since the room's name does not change
 * between them.
 *
 * Anything that is not a plain character becomes a hyphen. A room name is
 * free text a teacher typed, and it reaches a file system here: a slash in it
 * would be a path, and a leading dot would be a hidden file.
 */
export function boardFileName(
  roomId: string,
  roomName: string | null | undefined,
  extension: string,
  now: number,
): string {
  const trimmed = roomName?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : `room-${roomId.slice(0, 8)}`;
  const safe = base
    .replace(/[^a-zA-Z0-9 _-]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[-. ]+|[-. ]+$/g, '')
    .slice(0, 60);
  const stamp = new Date(now).toISOString().slice(0, 10);
  return `${safe.length > 0 ? safe : `room-${roomId.slice(0, 8)}`} ${stamp}.${extension}`;
}
