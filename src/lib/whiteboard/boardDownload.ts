import { bytesToDataURL, isAllowedMimeType } from './boardFiles';
import type { BoardFileEntry } from './boardExport';

/**
 * Gathering a board's images so a copy of it can stand on its own.
 *
 * The scene arrives from the room as elements that name their pictures by id;
 * the bytes live in the bucket and are fetched one at a time. Whoever opens
 * the exported file will not have a session for that bucket -- may not have
 * this application at all -- so the file has to carry the pictures inside it
 * rather than point at them.
 */

/** Just enough of fetch to ask the room for one file. */
export type FetchLike = (url: string) => Promise<Response>;

/**
 * Fetches the images a board refers to, skipping any that will not come.
 *
 * A picture that fails is left out rather than failing the export. The
 * alternative is that one image lost to a bucket error costs a teacher the
 * whole board, which is the opposite of what a backup is for -- and the file
 * still opens, with the missing picture showing as Excalidraw's own
 * placeholder rather than as a broken document.
 */
export async function collectBoardFiles(
  roomId: string,
  fileIds: readonly string[],
  fetchFile: FetchLike,
  now: number = Date.now(),
): Promise<BoardFileEntry[]> {
  const collected: BoardFileEntry[] = [];
  for (const fileId of fileIds) {
    try {
      const response = await fetchFile(`/api/whiteboard/room/${roomId}/files/${fileId}`);
      if (!response.ok) continue;
      const mimeType = response.headers.get('content-type');
      if (!isAllowedMimeType(mimeType ?? '')) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) continue;
      collected.push({
        id: fileId,
        dataURL: bytesToDataURL(bytes, mimeType as string),
        mimeType: mimeType as string,
        created: now,
      });
    } catch {
      // One picture that will not come must not cost the board.
    }
  }
  return collected;
}

/**
 * Reads the elements out of a room's scene response.
 *
 * Shaped defensively because this is the one place the export trusts the
 * server's JSON: a room that answers with something unexpected should produce
 * an empty export rather than throw inside a click handler, where the failure
 * would be invisible.
 */
export function elementsFromSceneResponse(payload: unknown): unknown[] {
  const elements = (payload as { elements?: unknown } | null)?.elements;
  return Array.isArray(elements) ? elements : [];
}
