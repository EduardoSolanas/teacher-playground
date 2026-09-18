/**
 * Pure logic for the embedded-documents upload slice (milestone 2 of
 * spec/EMBEDDED_DOCUMENTS_SPEC.md). The Worker owns validation and the only
 * R2 write path; this module holds the media-type detection, filename
 * normalization, identifier rules, and key grammar both sides of the route
 * share.
 *
 * Media types are detected from magic bytes, never from the client's declared
 * content type or extension — those are hints only (spec §5). PDF is
 * recognized by its `%PDF-` header. The two OOXML formats are ZIP containers,
 * so this slice accepts them by the zip local-file-header magic and records
 * the generic `ooxml` type; distinguishing PPTX from DOCX, and every hostile
 * package-structure check, arrives with the conversion milestone.
 */
import { MAX_BOARD_FILE_BYTES } from '../whiteboard/boardFileRoutes';

export type DetectedDocumentMediaType = 'pdf' | 'ooxml';

export const ACCEPTED_DOCUMENT_MEDIA_TYPES: readonly DetectedDocumentMediaType[] = [
  'pdf',
  'ooxml',
];

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const; // PK\x03\x04

export function detectDocumentMediaType(
  bytes: Uint8Array,
): DetectedDocumentMediaType | null {
  // No length guard: a short buffer simply cannot match the magic bytes, so
  // the element checks below are themselves the bound.
  if (
    bytes[0] === PDF_MAGIC[0]
    && bytes[1] === PDF_MAGIC[1]
    && bytes[2] === PDF_MAGIC[2]
    && bytes[3] === PDF_MAGIC[3]
    && bytes[4] === PDF_MAGIC[4]
  ) {
    return 'pdf';
  }
  if (
    bytes[0] === ZIP_MAGIC[0]
    && bytes[1] === ZIP_MAGIC[1]
    && bytes[2] === ZIP_MAGIC[2]
    && bytes[3] === ZIP_MAGIC[3]
  ) {
    return 'ooxml';
  }
  return null;
}

export function isAcceptedDocumentMediaType(
  value: unknown,
): value is DetectedDocumentMediaType {
  return (ACCEPTED_DOCUMENT_MEDIA_TYPES as readonly unknown[]).includes(value);
}

/** Stored filenames are normalized before they may reach the manifest. */
export const MAX_DOCUMENT_FILENAME_LENGTH = 200;
/** Bound on the raw filename a client may hand over before normalization. */
export const MAX_DOCUMENT_FILENAME_RAW_LENGTH = 1024;

/**
 * Normalizes an original filename: control characters become spaces, whitespace
 * runs collapse, and the result is capped at the stored limit. Anything that
 * normalizes to nothing (absent, wrong type, empty) becomes null — the
 * manifest field is optional.
 */
export function normalizeDocumentFilename(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return null;
  return cleaned.slice(0, MAX_DOCUMENT_FILENAME_LENGTH);
}

/** Document ids are minted server-side as UUIDs and never accepted raw into keys. */
export function isValidDocumentId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

/** Idempotency keys share the billing operation id grammar: bounded and opaque. */
export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Originals may never exceed the board-file per-object cap. */
export function isValidDocumentByteLength(value: unknown): value is number {
  // Number.isSafeInteger rejects every non-number, so it is the bound and the
  // type guard at once; the casts only satisfy the comparisons after it.
  return Number.isSafeInteger(value)
    && (value as number) > 0
    && (value as number) <= MAX_BOARD_FILE_BYTES;
}

export function isValidContentDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Room-scoped, immutable key for an original. Route parameters must be
 * validated before key construction; the grammar never accepts raw fragments.
 */
export function documentOriginalKey(roomId: string, documentId: string): string {
  return `rooms/${roomId}/documents/${documentId}/original`;
}

export function documentContentType(mediaType: DetectedDocumentMediaType): string {
  return mediaType === 'pdf' ? 'application/pdf' : 'application/octet-stream';
}

/** The public manifest shape the upload route answers with. */
export interface DocumentManifestSummary {
  readonly documentId: string;
  readonly state: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly pageCount: number;
}
