/**
 * What a room's pictures weigh, in words a teacher can act on.
 *
 * A room is capped at 250 MB of files (`MAX_ROOM_FILE_BYTES_TOTAL`), and a
 * lesson of imported worksheets reaches that in about ten of them. The cap used
 * to announce itself as an upload failing in the middle of an import, with
 * pages already on the board and no way to tell what went wrong; these are the
 * figures the room shows instead, and the check that runs before the pages are
 * inserted at all.
 */

const BYTES_PER_MB = 1024 * 1024;

/** What a room's pictures weigh, against the cap they are refused at. */
export type RoomStorage = { used: number; limit: number };

/** Megabytes as a person reads them: one decimal while the difference matters. */
export function formatMegabytes(bytes: number): string {
  if (bytes === 0) return '0 MB';
  const megabytes = bytes / BYTES_PER_MB;
  // Anything with bytes in it rounds up to something, never to "0 MB".
  if (megabytes < 0.05) return 'under 0.1 MB';
  if (megabytes < 10) return `${Math.round(megabytes * 10) / 10} MB`;
  return `${Math.round(megabytes)} MB`;
}

/** What the room may still hold, never a negative number. */
export function freeBytes(used: number, limit: number): number {
  return Math.max(0, limit - used);
}

/** The line the room title menu shows. */
export function storageLabel(used: number, limit: number): string {
  return `${formatMegabytes(used)} of ${formatMegabytes(limit)} used`;
}

/**
 * Why these pages cannot be inserted, or null when they fit. Measured against
 * the same cap the upload route enforces, so the dialog refuses exactly what
 * the server would have refused — before anything reaches the board.
 */
export function importTooLargeMessage(
  neededBytes: number,
  used: number,
  limit: number,
): string | null {
  const free = freeBytes(used, limit);
  if (neededBytes <= free) return null;
  return `These pages need about ${formatMegabytes(neededBytes)}, but only ${formatMegabytes(free)}`
    + ' is free in this room. Delete some pictures or use fewer pages.';
}

/**
 * The bytes a data URL will upload. Base64 carries 3 bytes in every 4
 * characters, less whatever the padding stands in for — the string's own
 * length would overstate a page by a third.
 */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma === -1 || !dataUrl.slice(0, comma).includes(';base64')) return 0;
  const encoded = dataUrl.slice(comma + 1);
  if (encoded.length === 0) return 0;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.floor((encoded.length * 3) / 4) - padding;
}
