/**
 * Server manifest and job rows for embedded documents (milestone 2 of
 * spec/EMBEDDED_DOCUMENTS_SPEC.md §4.2, §5). These handlers run inside the
 * RoomDO: the manifest is room state in RoomDO SQL, the Worker owns
 * validation and the only R2 write path, and no executor exists yet — a job
 * row is created in 'pending' and the state machine just persists it.
 *
 * Cancellation and deletion fences are milestone 4 and deliberately absent.
 */
import type { RoomDatabase } from '../db';
import {
  isAcceptedDocumentMediaType,
  isValidContentDigest,
  isValidDocumentByteLength,
  isValidDocumentId,
  isValidIdempotencyKey,
  MAX_DOCUMENT_FILENAME_RAW_LENGTH,
  normalizeDocumentFilename,
  type DocumentManifestSummary,
} from '../../documents/documentUpload';

interface ManifestRow {
  document_id: string;
  state: string;
  byte_length: number;
  media_type: string;
  page_count: number;
}

function documentSummary(row: ManifestRow): DocumentManifestSummary {
  return {
    documentId: row.document_id,
    state: row.state,
    byteLength: row.byte_length,
    mediaType: row.media_type,
    pageCount: row.page_count,
  };
}

function findManifestByIdempotencyKey(
  db: RoomDatabase,
  roomId: string,
  idempotencyKey: string,
): ManifestRow | undefined {
  return db.prepare(
    `SELECT document_id, state, byte_length, media_type, page_count
     FROM room_documents
     WHERE room_id = ? AND idempotency_key = ?`,
  ).get(roomId, idempotencyKey) as ManifestRow | undefined;
}

function isUniqueConstraint(error: unknown): boolean {
  // better-sqlite3 (unit) and workerd Durable Object SQLite (production) both
  // surface SQLite's own message text; only the message is common to both.
  return /unique constraint/i.test(String(error));
}

/**
 * Idempotent replay probe: does this room already hold a manifest for the
 * caller's idempotency key? Used by the Worker to return the original result
 * before it reserves or stores anything.
 */
export function documentsFindResponse(
  db: RoomDatabase,
  roomId: string,
  body: { idempotencyKey?: unknown } | null,
): Response {
  if (!isValidIdempotencyKey(body?.idempotencyKey)) {
    return Response.json({ error: 'Invalid request' }, { status: 400 });
  }
  const row = findManifestByIdempotencyKey(db, roomId, body!.idempotencyKey as string);
  // Response.json answers 200 by default; only the refusals name a status.
  if (!row) return Response.json({ found: false });
  return Response.json({ found: true, document: documentSummary(row) });
}

export interface DocumentsCreateInput {
  readonly documentId: string;
  readonly uploaderAccountId: string;
  readonly filename?: unknown;
  readonly mediaType: unknown;
  readonly byteLength: unknown;
  readonly contentDigest: unknown;
  readonly idempotencyKey?: unknown;
}

/**
 * Creates the manifest in state 'queued' with one job row in 'pending', in a
 * single transaction. A duplicate idempotency key — sequential retry or a
 * concurrent upload that raced past the Worker's pre-check — loses the insert
 * against the unique index and reports the original manifest instead.
 */
export function documentsCreateResult(
  db: RoomDatabase,
  roomId: string,
  input: DocumentsCreateInput,
): { status: 200 | 201 | 400; body: Record<string, unknown> } {
  if (!isValidDocumentId(input.documentId)) return invalidRequest();
  if (!isAcceptedDocumentMediaType(input.mediaType)) return invalidRequest();
  if (!isValidDocumentByteLength(input.byteLength)) return invalidRequest();
  if (!isValidContentDigest(input.contentDigest)) return invalidRequest();
  if (input.idempotencyKey !== undefined && !isValidIdempotencyKey(input.idempotencyKey)) {
    return invalidRequest();
  }
  if (
    input.filename !== undefined
    && (typeof input.filename !== 'string'
      || input.filename.length === 0
      || input.filename.length > MAX_DOCUMENT_FILENAME_RAW_LENGTH)
  ) {
    return invalidRequest();
  }
  const filename = normalizeDocumentFilename(input.filename);
  const idempotencyKey = (input.idempotencyKey ?? null) as string | null;
  const mediaType = input.mediaType as string;
  const byteLength = input.byteLength as number;
  const contentDigest = input.contentDigest as string;
  const now = Date.now();

  let result: { replayed: boolean; row: ManifestRow };
  try {
    result = db.transaction(() => {
      db.prepare(
        `INSERT INTO room_documents (
           document_id, room_id, state, original_filename, media_type,
           byte_length, content_digest, uploader_account_id, page_count,
           render_revision, manifest_json, safe_error_code, idempotency_key,
           created_at, updated_at
         ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?, ?)`,
      ).run(
        input.documentId,
        roomId,
        filename,
        mediaType,
        byteLength,
        contentDigest,
        input.uploaderAccountId,
        idempotencyKey,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO room_document_jobs (
           job_id, document_id, room_id, state, attempt,
           lease_owner, lease_expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)`,
      ).run(crypto.randomUUID(), input.documentId, roomId, now, now);
      return {
        replayed: false as const,
        row: {
          document_id: input.documentId,
          state: 'queued',
          byte_length: byteLength,
          media_type: mediaType,
          page_count: 0,
        } satisfies ManifestRow,
      };
    })();
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
    // The unique index decides the winner: a manifest with this room's
    // idempotency key already exists, and the original result is what a
    // replayed upload must see. The loser never created an identity. A null
    // key never matches the partial index lookup, so a unique failure without
    // one (a document-id collision) still rethrows below.
    const existing = findManifestByIdempotencyKey(db, roomId, idempotencyKey!);
    if (!existing) throw error;
    result = { replayed: true, row: existing };
  }

  if (result.replayed) {
    return { status: 200, body: { replayed: true, document: documentSummary(result.row) } };
  }
  return { status: 201, body: { replayed: false, document: documentSummary(result.row) } };
}

function invalidRequest(): { status: 400; body: Record<string, unknown> } {
  return { status: 400, body: { error: 'Invalid request' } };
}

/** Request-shaped entry points for the RoomDO route. */
export function handleDocumentsFindRequest(
  db: RoomDatabase,
  roomId: string,
  request: Request,
): Promise<Response> {
  return request.json().then(
    (body) => documentsFindResponse(db, roomId, body as { idempotencyKey?: unknown } | null),
    () => documentsFindResponse(db, roomId, null),
  );
}

export function handleDocumentsCreateRequest(
  db: RoomDatabase,
  roomId: string,
  uploaderAccountId: string,
  request: Request,
): Promise<Response> {
  return request.json().then(
    (body) => {
      const record = (body ?? {}) as Record<string, unknown>;
      const outcome = documentsCreateResult(db, roomId, {
        documentId: record.documentId as string,
        uploaderAccountId,
        filename: record.filename,
        mediaType: record.mediaType,
        byteLength: record.byteLength,
        contentDigest: record.contentDigest,
        idempotencyKey: record.idempotencyKey,
      });
      return Response.json(outcome.body, { status: outcome.status });
    },
    () => Response.json({ error: 'Invalid request' }, { status: 400 }),
  );
}
