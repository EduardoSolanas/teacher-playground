import type { BinaryFileData } from '@teacher-playground/excalidraw/types';

/**
 * Allowed image MIME types for board files. The server accepts these; we
 * validate on the client before sending to avoid wasting bandwidth on rejected
 * uploads.
 */
const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/**
 * Checks if a MIME type is allowed for upload.
 * Returns false for any unsupported or malformed type.
 */
export function isAllowedMimeType(mimeType: string): boolean {
  return ALLOWED_MIME_TYPES.has(mimeType);
}

/**
 * Converts a data URL (e.g., "data:image/png;base64,iVBORw0KGgo...") to raw
 * bytes and MIME type. Returns null for malformed input.
 *
 * Called on local files before upload; also called on remote files fetched from
 * the server before re-loading into Excalidraw. Never throws.
 */
export function dataURLToBytes(
  dataUrl: string,
): { bytes: Uint8Array; mimeType: string } | null {
  try {
    // "data:[<mediatype>][;base64],<data>" — Excalidraw always emits base64.
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;

    const mimeType = match[1];
    const base64 = match[2];

    if (!mimeType.startsWith('image/')) return null;

    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return { bytes, mimeType };
  } catch {
    // atob throws on invalid base64, Uint8Array construction can fail, etc.
    return null;
  }
}

/**
 * Converts raw bytes and a MIME type to a data URL string suitable for
 * handing back to Excalidraw.
 *
 * Never throws; handles empty bytes (returns "data:<mime>;base64,").
 */
export function bytesToDataURL(bytes: Uint8Array, mimeType: string): string {
  /*
   * Built in chunks rather than String.fromCharCode(...bytes).
   *
   * Spreading an array into a call passes one argument per byte, and a
   * photograph is megabytes: the spread overflows the stack and throws
   * RangeError. It survives every small fixture and fails on exactly the
   * images this exists to carry, which is the worst possible place to find it.
   */
  const CHUNK = 8192;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/**
 * Given Excalidraw's BinaryFiles map and a set of already-uploaded fileIds,
 * returns the fileIds that still need uploading.
 *
 * Excalidraw fires onChange on every pointer sample (~20 times/sec while
 * drawing). Uploading the same file repeatedly would be wasteful and
 * wrong—we track uploads to send each file exactly once.
 */
export function filesToUpload(
  files: Partial<Record<string, BinaryFileData>>,
  uploaded: Set<string>,
): string[] {
  return Object.keys(files).filter((fileId) => !uploaded.has(fileId));
}
