/**
 * Pure logic for whiteboard board file upload and download routes. Separated
 * from worker.ts so it can be tested without mocking the Cloudflare environment.
 */

export const MAX_BOARD_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ROOM_FILE_BYTES_TOTAL = 250 * 1024 * 1024;
const VALID_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * File ID must be content-addressed (determined by file contents by Excalidraw)
 * and alphanumeric with dashes and underscores only. Rejects empty, overly long,
 * or character-based attacks.
 */
export function isValidFileId(fileId: string): boolean {
  return VALID_FILE_ID_PATTERN.test(fileId);
}

/**
 * Allowlist of MIME types for board files. SVG is explicitly NOT included
 * because SVG can contain script tags and would be an XSS vector served from
 * our origin.
 */
export function isAllowedMimeType(mimeType: string | null): boolean {
  return typeof mimeType === 'string' && ALLOWED_MIME_TYPES.has(mimeType);
}

/**
 * Builds the R2 object key for a board file. Keys are immutable since file IDs
 * are content-addressed by Excalidraw: the bytes never change, so the key
 * determines uniqueness.
 */
export function buildR2ObjectKey(roomId: string, fileId: string): string {
  return `rooms/${roomId}/files/${fileId}`;
}

export interface ValidFileUploadRequest {
  method: 'PUT';
  fileId: string;
  mimeType: string;
  contentLength: number;
}

type ValidationResult =
  | { ok: true; value: ValidFileUploadRequest }
  | { ok: false; status: 400 | 413 | 415; message: string };

/**
 * Validates a PUT request for file upload before it reaches R2. Returns status
 * codes that mirror HTTP semantics: 400 for bad request (invalid ID), 413 for
 * payload too large, 415 for unsupported media type.
 */
export function validateFileUploadRequest(input: {
  method: string;
  fileId: string;
  mimeType: string | null;
  contentLength: number;
}): ValidationResult {
  if (input.method !== 'PUT') {
    return { ok: false, status: 400, message: 'Invalid method for file upload' };
  }

  if (!isValidFileId(input.fileId)) {
    return { ok: false, status: 400, message: 'Invalid file ID format' };
  }

  if (!isAllowedMimeType(input.mimeType)) {
    return { ok: false, status: 415, message: 'Unsupported media type' };
  }

  if (input.contentLength > MAX_BOARD_FILE_BYTES) {
    return { ok: false, status: 413, message: 'File too large' };
  }

  return {
    ok: true,
    value: {
      method: 'PUT',
      fileId: input.fileId,
      mimeType: input.mimeType as string,
      contentLength: input.contentLength,
    },
  };
}
