import { beforeEach, describe, expect, it } from 'vitest';
import { getRoomDb } from '../roomDb';
import { deleteRoomScopedData } from '../roomSchema';
import {
  documentsCreateResult,
  documentsFindResponse,
  handleDocumentsCreateRequest,
  handleDocumentsFindRequest,
} from './documents';
import { MAX_BOARD_FILE_BYTES } from '../boardFileRoutes';

/*
 * Real objects only: these run against the same SQLite schema the Durable
 * Object applies, via the in-memory unit-test connection.
 */

const db = getRoomDb();

function roomId(name: string): string {
  return `doc-handler-${name}-${crypto.randomUUID().slice(0, 8)}`;
}

function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    documentId: crypto.randomUUID(),
    mediaType: 'pdf',
    byteLength: 48,
    contentDigest: 'a'.repeat(64),
    ...overrides,
  };
}

function manifestRow(documentId: string): Record<string, unknown> | undefined {
  return db.prepare(
    `SELECT * FROM room_documents WHERE document_id = ?`,
  ).get(documentId) as Record<string, unknown> | undefined;
}

function jobRow(documentId: string): Record<string, unknown> | undefined {
  return db.prepare(
    `SELECT * FROM room_document_jobs WHERE document_id = ?`,
  ).get(documentId) as Record<string, unknown> | undefined;
}

describe('documentsCreateResult', () => {
  let room: string;

  beforeEach(() => {
    room = roomId('create');
    db.prepare(
      `INSERT INTO rooms (room_id, elements, viewport, created_at, updated_at)
       VALUES (?, '[]', '{}', ?, ?)`,
    ).run(room, Date.now(), Date.now());
  });

  it('creates the queued manifest and the pending job row together', () => {
    const documentId = crypto.randomUUID();
    const outcome = documentsCreateResult(db, room, {
      documentId,
      uploaderAccountId: 'acc-owner',
      filename: '  Lesson   Plan.pdf ',
      mediaType: 'pdf',
      byteLength: 48,
      contentDigest: 'b'.repeat(64),
    });

    expect(outcome.status).toBe(201);
    expect(outcome.body).toEqual({
      replayed: false,
      document: {
        documentId,
        state: 'queued',
        byteLength: 48,
        mediaType: 'pdf',
        pageCount: 0,
      },
    });

    const manifest = manifestRow(documentId);
    expect(manifest).toBeDefined();
    expect(manifest!.room_id).toBe(room);
    expect(manifest!.state).toBe('queued');
    expect(manifest!.original_filename).toBe('Lesson Plan.pdf');
    expect(manifest!.media_type).toBe('pdf');
    expect(manifest!.byte_length).toBe(48);
    expect(manifest!.content_digest).toBe('b'.repeat(64));
    expect(manifest!.uploader_account_id).toBe('acc-owner');
    expect(manifest!.page_count).toBe(0);
    expect(manifest!.render_revision).toBe(0);
    expect(manifest!.manifest_json).toBeNull();
    expect(manifest!.safe_error_code).toBeNull();
    expect(manifest!.idempotency_key).toBeNull();

    const job = jobRow(documentId);
    expect(job).toBeDefined();
    expect(job!.room_id).toBe(room);
    expect(job!.state).toBe('pending');
    expect(job!.attempt).toBe(0);
    expect(job!.lease_owner).toBeNull();
    expect(job!.lease_expires_at).toBeNull();
    expect(typeof job!.job_id).toBe('string');
  });

  it('stores an OOXML original under the generic detected type', () => {
    const documentId = crypto.randomUUID();
    const outcome = documentsCreateResult(db, room, {
      documentId,
      uploaderAccountId: 'acc-owner',
      mediaType: 'ooxml',
      byteLength: 10,
      contentDigest: 'c'.repeat(64),
    });
    expect(outcome.status).toBe(201);
    expect(outcome.body.document).toMatchObject({ mediaType: 'ooxml' });
  });

  it('normalizes a filename to null when nothing remains', () => {
    const documentId = crypto.randomUUID();
    documentsCreateResult(db, room, {
      documentId,
      uploaderAccountId: 'acc-owner',
      filename: '   ',
      mediaType: 'pdf',
      byteLength: 1,
      contentDigest: 'd'.repeat(64),
    });
    expect(manifestRow(documentId)!.original_filename).toBeNull();
  });

  it('refuses any field outside the manifest contract', () => {
    const cases: Array<Record<string, unknown>> = [
      createInput({ documentId: 'not-a-uuid' }),
      createInput({ documentId: 42 }),
      createInput({ mediaType: 'PDF' }),
      createInput({ mediaType: 'image/png' }),
      createInput({ byteLength: 0 }),
      createInput({ byteLength: 1.5 }),
      createInput({ byteLength: MAX_BOARD_FILE_BYTES + 1 }),
      createInput({ contentDigest: 'nothex' }),
      createInput({ idempotencyKey: 'has space' }),
      createInput({ filename: 7 }),
      createInput({ filename: '' }),
      createInput({ filename: 'x'.repeat(1025) }),
    ];
    for (const input of cases) {
      const outcome = documentsCreateResult(db, room, {
        uploaderAccountId: 'acc-owner',
        ...input,
      } as Parameters<typeof documentsCreateResult>[2]);
      expect(outcome.status, JSON.stringify(input)).toBe(400);
      // The exact refusal body is part of the safe-error contract.
      expect(outcome.body, JSON.stringify(input)).toEqual({ error: 'Invalid request' });
    }
  });

  it('accepts a filename at the raw bound and refuses one past it', () => {
    const atBound = documentsCreateResult(db, room, {
      documentId: crypto.randomUUID(),
      uploaderAccountId: 'acc-owner',
      filename: 'x'.repeat(1024),
      mediaType: 'pdf',
      byteLength: 1,
      contentDigest: '9'.repeat(64),
    });
    expect(atBound.status).toBe(201);

    const pastBound = documentsCreateResult(db, room, {
      documentId: crypto.randomUUID(),
      uploaderAccountId: 'acc-owner',
      filename: 'x'.repeat(1025),
      mediaType: 'pdf',
      byteLength: 1,
      contentDigest: '9'.repeat(64),
    });
    expect(pastBound.status).toBe(400);
  });

  it('replays the original manifest for a repeated idempotency key', () => {
    const documentId = crypto.randomUUID();
    const key = `retry-${crypto.randomUUID().slice(0, 8)}`;
    const first = documentsCreateResult(db, room, {
      documentId,
      uploaderAccountId: 'acc-owner',
      mediaType: 'pdf',
      byteLength: 48,
      contentDigest: 'e'.repeat(64),
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);

    const replay = documentsCreateResult(db, room, {
      documentId: crypto.randomUUID(),
      uploaderAccountId: 'acc-owner',
      mediaType: 'pdf',
      byteLength: 999,
      contentDigest: 'f'.repeat(64),
      idempotencyKey: key,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ replayed: true, document: first.body.document });

    // The loser never became a manifest, and exactly one job row exists.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM room_documents WHERE room_id = ?`)
      .get(room) as { n: number }).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM room_document_jobs WHERE room_id = ?`)
      .get(room) as { n: number }).toEqual({ n: 1 });
  });

  it('lets two documents without idempotency keys coexist', () => {
    documentsCreateResult(db, room, {
      documentId: crypto.randomUUID(),
      uploaderAccountId: 'acc-owner',
      mediaType: 'pdf',
      byteLength: 1,
      contentDigest: '1'.repeat(64),
    });
    documentsCreateResult(db, room, {
      documentId: crypto.randomUUID(),
      uploaderAccountId: 'acc-owner',
      mediaType: 'pdf',
      byteLength: 2,
      contentDigest: '2'.repeat(64),
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM room_documents WHERE room_id = ?`)
      .get(room) as { n: number }).toEqual({ n: 2 });
  });

  it('rethrows a document-id collision instead of reporting it as a replay', () => {
    const documentId = crypto.randomUUID();
    documentsCreateResult(db, room, {
      documentId,
      uploaderAccountId: 'acc-owner',
      mediaType: 'pdf',
      byteLength: 1,
      contentDigest: '1'.repeat(64),
    });

    // A colliding document id under a fresh idempotency key is a server bug,
    // not an idempotent replay: the unique failure names the primary key, and
    // the fresh key lookup finds nothing, so the error must propagate.
    expect(() => documentsCreateResult(db, room, {
      documentId,
      uploaderAccountId: 'acc-owner',
      mediaType: 'pdf',
      byteLength: 2,
      contentDigest: '2'.repeat(64),
      idempotencyKey: `fresh-${crypto.randomUUID().slice(0, 8)}`,
    })).toThrow(/UNIQUE constraint/);
  });

  it('never reports a non-unique insert failure as a replay', () => {
    const key = `fail-${crypto.randomUUID().slice(0, 8)}`;
    documentsCreateResult(db, room, {
      documentId: crypto.randomUUID(),
      uploaderAccountId: 'acc-owner',
      mediaType: 'pdf',
      byteLength: 1,
      contentDigest: '1'.repeat(64),
      idempotencyKey: key,
    });

    // The uploader id is the Worker-stamped account and is never nullable; a
    // create that arrives without one fails on a non-unique constraint even
    // though its idempotency key already exists, and must not masquerade as
    // the earlier manifest.
    expect(() => documentsCreateResult(db, room, {
      documentId: crypto.randomUUID(),
      uploaderAccountId: undefined as unknown as string,
      mediaType: 'pdf',
      byteLength: 1,
      contentDigest: '2'.repeat(64),
      idempotencyKey: key,
    })).toThrow();

    expect(db.prepare(`SELECT COUNT(*) AS n FROM room_documents WHERE room_id = ?`)
      .get(room) as { n: number }).toEqual({ n: 1 });
  });

  it('clears manifests and jobs with the room they belong to', () => {
    const documentId = crypto.randomUUID();
    documentsCreateResult(db, room, {
      documentId,
      uploaderAccountId: 'acc-owner',
      mediaType: 'pdf',
      byteLength: 3,
      contentDigest: '3'.repeat(64),
      idempotencyKey: `sweep-${crypto.randomUUID().slice(0, 8)}`,
    });
    deleteRoomScopedData(db, room);
    expect(manifestRow(documentId)).toBeUndefined();
    expect(jobRow(documentId)).toBeUndefined();
  });
});

describe('documentsFindResponse', () => {
  let room: string;

  beforeEach(() => {
    room = roomId('find');
    db.prepare(
      `INSERT INTO rooms (room_id, elements, viewport, created_at, updated_at)
       VALUES (?, '[]', '{}', ?, ?)`,
    ).run(room, Date.now(), Date.now());
  });

  it('finds a manifest by idempotency key and reports a miss plainly', async () => {
    const documentId = crypto.randomUUID();
    const key = `find-${crypto.randomUUID().slice(0, 8)}`;
    documentsCreateResult(db, room, {
      documentId,
      uploaderAccountId: 'acc-owner',
      mediaType: 'pdf',
      byteLength: 7,
      contentDigest: '7'.repeat(64),
      idempotencyKey: key,
    });

    const found = documentsFindResponse(db, room, { idempotencyKey: key });
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({
      found: true,
      document: {
        documentId,
        state: 'queued',
        byteLength: 7,
        mediaType: 'pdf',
        pageCount: 0,
      },
    });

    const miss = documentsFindResponse(db, room, {
      idempotencyKey: `other-${crypto.randomUUID().slice(0, 8)}`,
    });
    expect(miss.status).toBe(200);
    expect(await miss.json()).toEqual({ found: false });
  });

  it('refuses a malformed probe without touching the manifest', async () => {
    for (const body of [null, {}, { idempotencyKey: '' }, { idempotencyKey: 5 }, ['retry-1']]) {
      const response = documentsFindResponse(db, room, body as { idempotencyKey?: unknown });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json(), JSON.stringify(body))
        .toEqual({ error: 'Invalid request' });
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM room_documents WHERE room_id = ?`)
      .get(room) as { n: number }).toEqual({ n: 0 });
  });
});

describe('RoomDO request wrappers', () => {
  let room: string;

  beforeEach(() => {
    room = roomId('wrapper');
    db.prepare(
      `INSERT INTO rooms (room_id, elements, viewport, created_at, updated_at)
       VALUES (?, '[]', '{}', ?, ?)`,
    ).run(room, Date.now(), Date.now());
  });

  function jsonRequest(path: string, body: string): Request {
    return new Request(`https://room/documents/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  }

  it('create accepts a real JSON request and refuses an unparseable one', async () => {
    const documentId = crypto.randomUUID();
    const created = await handleDocumentsCreateRequest(db, room, 'acc-owner', jsonRequest('create', JSON.stringify({
      documentId,
      mediaType: 'pdf',
      byteLength: 11,
      contentDigest: 'a'.repeat(64),
    })));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ replayed: false });

    const bad = await handleDocumentsCreateRequest(db, room, 'acc-owner', jsonRequest('create', '{not json'));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Invalid request' });

    const jsonNull = await handleDocumentsCreateRequest(db, room, 'acc-owner', jsonRequest('create', 'null'));
    expect(jsonNull.status).toBe(400);
    expect(await jsonNull.json()).toEqual({ error: 'Invalid request' });

    // An unparseable body created nothing, and neither did the refusals.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM room_documents WHERE room_id = ?`)
      .get(room) as { n: number }).toEqual({ n: 1 });
  });

  it('find accepts a real JSON request and falls back to a null probe when unparseable', async () => {
    const documentId = crypto.randomUUID();
    const key = `wrap-${crypto.randomUUID().slice(0, 8)}`;
    documentsCreateResult(db, room, {
      documentId,
      uploaderAccountId: 'acc-owner',
      mediaType: 'pdf',
      byteLength: 3,
      contentDigest: '3'.repeat(64),
      idempotencyKey: key,
    });

    const found = await handleDocumentsFindRequest(db, room, jsonRequest('find', JSON.stringify({ idempotencyKey: key })));
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ found: true, document: { documentId } });

    const bad = await handleDocumentsFindRequest(db, room, jsonRequest('find', '{nope'));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Invalid request' });
  });
});
