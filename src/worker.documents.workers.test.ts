import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import type { RoomDO } from './do/RoomDO';
import { MAX_BOARD_FILE_BYTES, MAX_ROOM_FILE_BYTES_TOTAL } from './lib/whiteboard/boardFileRoutes';
import { getFileBytesTotal, setFileBytes } from './lib/whiteboard/roomSchema';
import { authenticatedFetch, bootstrapLocalSession, type LocalAuthSession } from './test/workerAuth';

const BASE = 'https://example.com';

/*
 * Milestone 2 (spec/EMBEDDED_DOCUMENTS_SPEC.md §10): owner-authorized upload,
 * server manifest, byte reservation, and job rows. No converter exists yet —
 * the job row is persisted in 'pending' and nothing executes it.
 *
 * The surface flag default in vitest.workers.config.mts is 'on'; the off and
 * read-only cases override the binding per test and restore it, the same way
 * the admin tests override ADMIN_EMAILS.
 */

type EnvWithDocuments = { EMBEDDED_DOCUMENTS?: string };

function roomStub(roomId: string) {
  return (env as unknown as { ROOMS: DurableObjectNamespace }).ROOMS.get(
    (env as unknown as { ROOMS: DurableObjectNamespace }).ROOMS.idFromName(roomId),
  ) as DurableObjectStub<RoomDO>;
}

function boardFiles(): R2Bucket {
  return (env as unknown as { BOARD_FILES: R2Bucket }).BOARD_FILES;
}

async function quotaTotal(roomId: string): Promise<number> {
  return runInDurableObject(roomStub(roomId), (instance: RoomDO) =>
    getFileBytesTotal(instance.db, roomId));
}

function seedQuota(roomId: string, bytes: number): Promise<void> {
  return runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
    setFileBytes(instance.db, roomId, bytes);
  });
}

function documentRowCounts(roomId: string) {
  return runInDurableObject(roomStub(roomId), (instance: RoomDO) => ({
    manifests: instance.db
      .prepare(`SELECT COUNT(*) AS n FROM room_documents WHERE room_id = ?`)
      .get(roomId) as { n: number },
    jobs: instance.db
      .prepare(`SELECT COUNT(*) AS n FROM room_document_jobs WHERE room_id = ?`)
      .get(roomId) as { n: number },
  }));
}

async function createOwnedRoom(roomId: string, owner: LocalAuthSession): Promise<void> {
  const created = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ elements: [] }),
  });
  expect(created.status).toBe(200);
}

function grantRole(roomId: string, accountId: string, role: 'editor' | 'viewer'): Promise<void> {
  return runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
    instance.db.prepare(
      `INSERT INTO room_members (
         room_id, account_id, role, display_name, email,
         requested_at, created_at, updated_at, expires_at
       ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
    ).run(roomId, accountId, role, role, Date.now(), Date.now());
  });
}

/** Magic bytes only. Content type and filename are hints the server ignores. */
export function pdfBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  return bytes;
}

export function ooxmlBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
  return bytes;
}

async function uploadDocument(
  session: LocalAuthSession,
  roomId: string,
  init: {
    bytes: Uint8Array;
    filename?: string;
    idempotencyKey?: string;
    contentType?: string;
  },
): Promise<Response> {
  const query = new URLSearchParams();
  if (init.filename !== undefined) query.set('filename', init.filename);
  if (init.idempotencyKey !== undefined) query.set('idempotencyKey', init.idempotencyKey);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return authenticatedFetch(`/api/whiteboard/room/${roomId}/documents${suffix}`, session, {
    method: 'POST',
    headers: { 'content-type': init.contentType ?? 'application/pdf' },
    body: init.bytes,
  });
}

function storedOriginalCount(roomId: string): Promise<number> {
  return runInDurableObject(roomStub(roomId), async () => {
    const listed = await boardFiles().list({ prefix: `rooms/${roomId}/documents/` });
    return listed.objects.length;
  });
}

describe('POST /api/whiteboard/room/:roomId/documents (milestone 2)', () => {
  it('answers 404 to everyone while the surface is off', async () => {
    const owner = await bootstrapLocalSession(`doc-off-owner-${crypto.randomUUID()}`);
    const outsider = await bootstrapLocalSession(`doc-off-outsider-${crypto.randomUUID()}`);
    const roomId = `doc-off-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const original = (env as unknown as EnvWithDocuments).EMBEDDED_DOCUMENTS;
    (env as unknown as EnvWithDocuments).EMBEDDED_DOCUMENTS = undefined;
    try {
      const ownerResponse = await uploadDocument(owner, roomId, {
        bytes: pdfBytes(20),
        filename: 'Lesson.pdf',
      });
      expect(ownerResponse.status).toBe(404);
      // The exact body matters: a bare hostNotFound 404 carries no JSON, and
      // the surface must look like any other absent route, not an error.
      expect(await ownerResponse.json()).toEqual({ error: 'Not found' });

      const outsiderResponse = await uploadDocument(outsider, roomId, {
        bytes: pdfBytes(20),
        filename: 'Lesson.pdf',
      });
      expect(outsiderResponse.status).toBe(404);
      expect(await outsiderResponse.json()).toEqual({ error: 'Not found' });
    } finally {
      (env as unknown as EnvWithDocuments).EMBEDDED_DOCUMENTS = original;
    }

    expect(await storedOriginalCount(roomId)).toBe(0);
    expect(await quotaTotal(roomId)).toBe(0);
    const counts = await documentRowCounts(roomId);
    expect(counts.manifests.n).toBe(0);
    expect(counts.jobs.n).toBe(0);
  });

  it('refuses uploads in read-only mode even for the owner', async () => {
    const owner = await bootstrapLocalSession(`doc-readonly-owner-${crypto.randomUUID()}`);
    const roomId = `doc-readonly-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const original = (env as unknown as EnvWithDocuments).EMBEDDED_DOCUMENTS;
    (env as unknown as EnvWithDocuments).EMBEDDED_DOCUMENTS = 'read-only';
    try {
      const response = await uploadDocument(owner, roomId, {
        bytes: pdfBytes(20),
        filename: 'Lesson.pdf',
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Forbidden' });
    } finally {
      (env as unknown as EnvWithDocuments).EMBEDDED_DOCUMENTS = original;
    }

    expect(await storedOriginalCount(roomId)).toBe(0);
    expect(await quotaTotal(roomId)).toBe(0);
    const counts = await documentRowCounts(roomId);
    expect(counts.manifests.n).toBe(0);
    expect(counts.jobs.n).toBe(0);
  });

  it('refuses an editor upload with 403 and stores nothing', async () => {
    const owner = await bootstrapLocalSession(`doc-editor-owner-${crypto.randomUUID()}`);
    const editor = await bootstrapLocalSession(`doc-editor-editor-${crypto.randomUUID()}`);
    const outsider = await bootstrapLocalSession(`doc-editor-outsider-${crypto.randomUUID()}`);
    const roomId = `doc-editor-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    await grantRole(roomId, editor.accountId, 'editor');

    for (const who of [editor, outsider]) {
      const response = await uploadDocument(who, roomId, {
        bytes: pdfBytes(20),
        filename: 'Lesson.pdf',
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Forbidden' });
    }

    expect(await storedOriginalCount(roomId)).toBe(0);
    expect(await quotaTotal(roomId)).toBe(0);
    const counts = await documentRowCounts(roomId);
    expect(counts.manifests.n).toBe(0);
    expect(counts.jobs.n).toBe(0);
  });

  it('stores the original, reserves quota, and returns the queued manifest for the owner', async () => {
    const owner = await bootstrapLocalSession(`doc-owner-ok-${crypto.randomUUID()}`);
    const roomId = `doc-owner-ok-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    // An unknown room answers 404 before any bytes are accepted.
    const unknown = await uploadDocument(owner, `doc-missing-${crypto.randomUUID()}`, {
      bytes: pdfBytes(20),
      filename: 'Lesson.pdf',
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Not found' });

    const bytes = pdfBytes(48);
    const digestHex = hex(await crypto.subtle.digest('SHA-256', bytes));
    const response = await uploadDocument(owner, roomId, {
      bytes,
      filename: '  Lesson   Plan.pdf ',
    });
    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'byteLength',
      'documentId',
      'mediaType',
      'pageCount',
      'state',
    ]);
    expect(body.state).toBe('queued');
    expect(body.byteLength).toBe(bytes.byteLength);
    expect(body.mediaType).toBe('pdf');
    expect(body.pageCount).toBe(0);
    const documentId = body.documentId as string;

    const stored = await boardFiles().get(`rooms/${roomId}/documents/${documentId}/original`);
    expect(stored).not.toBeNull();
    const storedBytes = new Uint8Array(await stored!.arrayBuffer());
    expect(storedBytes.byteLength).toBe(bytes.byteLength);
    expect([...storedBytes]).toEqual([...bytes]);

    expect(await quotaTotal(roomId)).toBe(bytes.byteLength);

    const manifest = await runInDurableObject(roomStub(roomId), (instance: RoomDO) =>
      instance.db
        .prepare(`SELECT * FROM room_documents WHERE room_id = ? AND document_id = ?`)
        .get(roomId, documentId) as Record<string, unknown> | undefined);
    expect(manifest).toBeDefined();
    expect(manifest!.state).toBe('queued');
    expect(manifest!.media_type).toBe('pdf');
    expect(manifest!.byte_length).toBe(bytes.byteLength);
    expect(manifest!.content_digest).toBe(digestHex);
    expect(manifest!.uploader_account_id).toBe(owner.accountId);
    expect(manifest!.original_filename).toBe('Lesson Plan.pdf');
    expect(manifest!.page_count).toBe(0);
    expect(manifest!.render_revision).toBe(0);
    expect(manifest!.idempotency_key).toBeNull();

    const job = await runInDurableObject(roomStub(roomId), (instance: RoomDO) =>
      instance.db
        .prepare(`SELECT * FROM room_document_jobs WHERE document_id = ?`)
        .get(documentId) as Record<string, unknown> | undefined);
    expect(job).toBeDefined();
    expect(job!.room_id).toBe(roomId);
    expect(job!.state).toBe('pending');
    expect(job!.attempt).toBe(0);
    expect(job!.lease_owner).toBeNull();
    expect(job!.lease_expires_at).toBeNull();
  });

  it('is idempotent for a repeated idempotency key without double quota charge', async () => {
    const owner = await bootstrapLocalSession(`doc-idem-owner-${crypto.randomUUID()}`);
    const roomId = `doc-idem-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const bytes = pdfBytes(32);
    const idempotencyKey = `retry-${crypto.randomUUID().slice(0, 8)}`;
    const first = await uploadDocument(owner, roomId, {
      bytes,
      filename: 'Lesson.pdf',
      idempotencyKey,
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as Record<string, unknown>;

    // A client retry with the same key must return the ORIGINAL manifest
    // result — same document id — and must not charge the room twice.
    const replay = await uploadDocument(owner, roomId, {
      bytes,
      filename: 'Lesson.pdf',
      idempotencyKey,
    });
    expect(replay.status).toBe(201);
    const replayBody = await replay.json() as Record<string, unknown>;
    expect(replayBody).toEqual(firstBody);

    expect(await quotaTotal(roomId)).toBe(bytes.byteLength);
    expect(await storedOriginalCount(roomId)).toBe(1);
    const counts = await documentRowCounts(roomId);
    expect(counts.manifests.n).toBe(1);
    expect(counts.jobs.n).toBe(1);

    const manifest = await runInDurableObject(roomStub(roomId), (instance: RoomDO) =>
      instance.db
        .prepare(`SELECT idempotency_key FROM room_documents WHERE document_id = ?`)
        .get(firstBody.documentId) as { idempotency_key: string } | undefined);
    expect(manifest!.idempotency_key).toBe(idempotencyKey);
  });

  it('rejects an oversize original with 413 before accepting bytes', async () => {
    const owner = await bootstrapLocalSession(`doc-oversize-owner-${crypto.randomUUID()}`);
    const roomId = `doc-oversize-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const response = await uploadDocument(owner, roomId, {
      bytes: pdfBytes(MAX_BOARD_FILE_BYTES + 1),
      filename: 'Too Big.pdf',
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'File too large' });

    expect(await storedOriginalCount(roomId)).toBe(0);
    expect(await quotaTotal(roomId)).toBe(0);
    const counts = await documentRowCounts(roomId);
    expect(counts.manifests.n).toBe(0);
    expect(counts.jobs.n).toBe(0);
  });

  it('rejects a body whose magic bytes do not match any accepted media type with 415', async () => {
    const owner = await bootstrapLocalSession(`doc-magic-owner-${crypto.randomUUID()}`);
    const roomId = `doc-magic-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pngResponse = await uploadDocument(owner, roomId, {
      bytes: png,
      filename: 'Picture.pdf',
    });
    expect(pngResponse.status).toBe(415);
    expect(await pngResponse.json()).toEqual({ error: 'Unsupported media type' });

    const emptyResponse = await uploadDocument(owner, roomId, {
      bytes: new Uint8Array(0),
      filename: 'Empty.pdf',
    });
    expect(emptyResponse.status).toBe(415);
    expect(await emptyResponse.json()).toEqual({ error: 'Unsupported media type' });

    expect(await storedOriginalCount(roomId)).toBe(0);
    expect(await quotaTotal(roomId)).toBe(0);
    const counts = await documentRowCounts(roomId);
    expect(counts.manifests.n).toBe(0);
    expect(counts.jobs.n).toBe(0);
  });

  it('racing uploads cannot exceed the 250 MiB room quota', async () => {
    const owner = await bootstrapLocalSession(`doc-race-owner-${crypto.randomUUID()}`);
    const roomId = `doc-race-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const bytes = pdfBytes(20);
    await seedQuota(roomId, MAX_ROOM_FILE_BYTES_TOTAL - bytes.byteLength);

    const [first, second] = await Promise.all([
      uploadDocument(owner, roomId, { bytes, filename: 'First.pdf' }),
      uploadDocument(owner, roomId, { bytes, filename: 'Second.pdf' }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 413]);
    const refused = first.status === 413 ? first : second;
    expect(await refused.json()).toEqual({
      error: 'Aggregate file storage quota exceeded (250 MB limit)',
    });

    expect(await quotaTotal(roomId)).toBe(MAX_ROOM_FILE_BYTES_TOTAL);
    expect(await storedOriginalCount(roomId)).toBe(1);
    const counts = await documentRowCounts(roomId);
    expect(counts.manifests.n).toBe(1);
    expect(counts.jobs.n).toBe(1);
  });
});

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
