/**
 * Which stored board files no longer belong to anything.
 *
 * An uploaded image outlives the element that referenced it. Clearing a board,
 * or a stale sweep dropping an element, removes the reference and leaves the
 * bytes in R2 with nothing pointing at them. Nobody can reach them -- the room
 * grant still gates every read -- but they are a child's picture kept after the
 * board that held it is gone, and they are billed for indefinitely.
 */

/** How long a file is left alone regardless of whether anything references it. */
export const ORPHAN_GRACE_MS = 10 * 60 * 1000;

/**
 * Every file id the board still mentions, tombstones included.
 *
 * Deleted elements count as references on purpose. Excalidraw erases by
 * flagging `isDeleted` rather than removing, and an undo brings the element
 * back expecting its image to still be there. Collecting on the flag would make
 * undo produce a broken picture -- so a file is orphaned only once no element
 * mentions it at all, which is what clearing a board or a stale sweep does.
 */
export function referencedFileIds(elements: readonly unknown[]): Set<string> {
  const referenced = new Set<string>();
  for (const element of elements) {
    if (typeof element !== 'object' || element === null) continue;
    const fileId = (element as { fileId?: unknown }).fileId;
    if (typeof fileId === 'string' && fileId.length > 0) referenced.add(fileId);
  }
  return referenced;
}

export interface StoredFile {
  readonly key: string;
  /** When R2 accepted the upload. */
  readonly uploaded: Date;
}

/**
 * The keys safe to delete now.
 *
 * The grace period is the whole reason this is not just a set difference. A
 * peer uploads the bytes before it publishes the element that references them,
 * so between those two moments a perfectly live file looks exactly like an
 * orphan. Deleting it would break the image on the board of the person who had
 * just added it, which is both the worst outcome and the hardest to reproduce.
 */
export function orphanKeys(input: {
  readonly files: readonly StoredFile[];
  readonly referenced: ReadonlySet<string>;
  readonly now: number;
  readonly graceMs?: number;
}): string[] {
  const grace = input.graceMs ?? ORPHAN_GRACE_MS;
  return input.files
    .filter((file) => {
      const fileId = fileIdFromKey(file.key);
      if (fileId === null) return false;
      if (input.referenced.has(fileId)) return false;
      return input.now - file.uploaded.getTime() >= grace;
    })
    .map((file) => file.key);
}

/**
 * The file id inside an object key, or null when the key is not one of ours.
 *
 * A key this does not recognise is left alone rather than guessed at: this
 * function's answer is fed straight into a delete.
 */
export function fileIdFromKey(key: string): string | null {
  const match = /^rooms\/[^/]+\/files\/([^/]+)$/.exec(key);
  return match ? match[1] : null;
}
