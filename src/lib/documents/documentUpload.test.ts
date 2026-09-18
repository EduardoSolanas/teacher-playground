import { describe, expect, it } from 'vitest';
import { MAX_BOARD_FILE_BYTES } from '../whiteboard/boardFileRoutes';
import {
  ACCEPTED_DOCUMENT_MEDIA_TYPES,
  detectDocumentMediaType,
  documentContentType,
  documentOriginalKey,
  isAcceptedDocumentMediaType,
  isValidContentDigest,
  isValidDocumentByteLength,
  isValidDocumentId,
  isValidIdempotencyKey,
  MAX_DOCUMENT_FILENAME_LENGTH,
  normalizeDocumentFilename,
} from './documentUpload';

describe('detectDocumentMediaType', () => {
  it('recognizes the PDF magic and only at the start', () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x2d, 0x20]);
    expect(detectDocumentMediaType(pdf)).toBe('pdf');
    expect(detectDocumentMediaType(pdf.slice(0, 5))).toBe('pdf');

    const offset = new Uint8Array(10);
    offset.set([0x25, 0x50, 0x44, 0x46, 0x2d], 3);
    expect(detectDocumentMediaType(offset)).toBeNull();
  });

  it('recognizes the OOXML zip container magic as the generic type', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(detectDocumentMediaType(zip)).toBe('ooxml');
    expect(detectDocumentMediaType(zip.slice(0, 4))).toBe('ooxml');
  });

  it('refuses every other magic, including a truncated PDF header', () => {
    expect(detectDocumentMediaType(new Uint8Array(0))).toBeNull();
    expect(detectDocumentMediaType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectDocumentMediaType(png)).toBeNull();
    expect(detectDocumentMediaType(new TextEncoder().encode('PK\u0003'))).toBeNull();
  });

  it('refuses a PDF header with any single magic byte wrong', () => {
    const sound = [0x25, 0x50, 0x44, 0x46, 0x2d];
    for (let position = 0; position < sound.length; position += 1) {
      const broken = [...sound];
      broken[position] = broken[position] === 0x00 ? 0x01 : 0x00;
      expect(detectDocumentMediaType(new Uint8Array(broken)), `byte ${position}`).toBeNull();
    }
  });

  it('refuses a zip header with any single magic byte wrong', () => {
    const sound = [0x50, 0x4b, 0x03, 0x04];
    for (let position = 0; position < sound.length; position += 1) {
      const broken = [...sound];
      broken[position] = broken[position] === 0x00 ? 0x01 : 0x00;
      expect(detectDocumentMediaType(new Uint8Array(broken)), `byte ${position}`).toBeNull();
    }
  });

  it('refuses a near miss on the first byte of either format', () => {
    expect(detectDocumentMediaType(new Uint8Array([0x50, 0x50, 0x44, 0x46, 0x2d]))).toBeNull();
    expect(detectDocumentMediaType(new Uint8Array([0x51, 0x4b, 0x03, 0x04]))).toBeNull();
  });
});

describe('normalizeDocumentFilename', () => {
  it('trims, collapses whitespace, and strips control characters', () => {
    expect(normalizeDocumentFilename('  Lesson   Plan.pdf ')).toBe('Lesson Plan.pdf');
    expect(normalizeDocumentFilename('bad\u0000\u0007name.docx')).toBe('bad name.docx');
    expect(normalizeDocumentFilename('slide\tdeck.pptx')).toBe('slide deck.pptx');
  });

  it('caps the stored name at the manifest limit', () => {
    const long = 'a'.repeat(500) + '.pdf';
    expect(normalizeDocumentFilename(long)).toBe('a'.repeat(MAX_DOCUMENT_FILENAME_LENGTH));
    expect(normalizeDocumentFilename(long)!.length).toBe(MAX_DOCUMENT_FILENAME_LENGTH);
  });

  it('normalizes nothing to null', () => {
    for (const value of [undefined, null, 42, '', '   ', '\u0007']) {
      expect(normalizeDocumentFilename(value)).toBeNull();
    }
  });
});

describe('identifier and field rules', () => {
  /** A non-string whose string form satisfies a pattern must still be refused. */
  function stringLike(text: string): unknown {
    return { toString: () => text };
  }

  it('accepts only well-formed document ids', () => {
    expect(isValidDocumentId(crypto.randomUUID())).toBe(true);
    expect(isValidDocumentId('not-a-uuid')).toBe(false);
    expect(isValidDocumentId('')).toBe(false);
    expect(isValidDocumentId(null)).toBe(false);
    expect(isValidDocumentId(123)).toBe(false);
    expect(isValidDocumentId(stringLike(crypto.randomUUID()))).toBe(false);
    // A traversal or fragment must never become part of an R2 key.
    expect(isValidDocumentId('../escape')).toBe(false);
    expect(isValidDocumentId('a/b/c/d/e/f/g/h')).toBe(false);
    // Anchors: a real id wrapped in extra characters is still refused.
    expect(isValidDocumentId(`zzz-${crypto.randomUUID()}`)).toBe(false);
    expect(isValidDocumentId(`${crypto.randomUUID()}-zzz`)).toBe(false);
  });

  it('accepts only bounded opaque idempotency keys', () => {
    expect(isValidIdempotencyKey('retry-1')).toBe(true);
    expect(isValidIdempotencyKey('a'.repeat(128))).toBe(true);
    expect(isValidIdempotencyKey('')).toBe(false);
    expect(isValidIdempotencyKey('a'.repeat(129))).toBe(false);
    expect(isValidIdempotencyKey('has space')).toBe(false);
    expect(isValidIdempotencyKey(null)).toBe(false);
    expect(isValidIdempotencyKey(stringLike('retry-1'))).toBe(false);
    expect(isValidIdempotencyKey(`x${'a'.repeat(128)}`)).toBe(false);
  });

  it('bounds the byte length to the board-file per-object cap', () => {
    expect(isValidDocumentByteLength(1)).toBe(true);
    expect(isValidDocumentByteLength(MAX_BOARD_FILE_BYTES)).toBe(true);
    expect(isValidDocumentByteLength(0)).toBe(false);
    expect(isValidDocumentByteLength(-1)).toBe(false);
    expect(isValidDocumentByteLength(1.5)).toBe(false);
    expect(isValidDocumentByteLength(MAX_BOARD_FILE_BYTES + 1)).toBe(false);
    expect(isValidDocumentByteLength('5')).toBe(false);
    expect(isValidDocumentByteLength(null)).toBe(false);
    expect(isValidDocumentByteLength(stringLike('5'))).toBe(false);
  });

  it('accepts only lowercase 64-hex digests', () => {
    expect(isValidContentDigest('a'.repeat(64))).toBe(true);
    expect(isValidContentDigest('A'.repeat(64))).toBe(false);
    expect(isValidContentDigest('a'.repeat(63))).toBe(false);
    expect(isValidContentDigest('')).toBe(false);
    expect(isValidContentDigest(stringLike('a'.repeat(64)))).toBe(false);
    expect(isValidContentDigest(`x${'a'.repeat(64)}`)).toBe(false);
    expect(isValidContentDigest(`${'a'.repeat(64)}x`)).toBe(false);
  });

  it('accepts only the detected media types', () => {
    expect(ACCEPTED_DOCUMENT_MEDIA_TYPES).toEqual(['pdf', 'ooxml']);
    for (const value of ACCEPTED_DOCUMENT_MEDIA_TYPES) {
      expect(isAcceptedDocumentMediaType(value)).toBe(true);
    }
    for (const value of ['PDF', 'image/png', 'zip', '', null, undefined, 42, stringLike('pdf')]) {
      expect(isAcceptedDocumentMediaType(value)).toBe(false);
    }
  });
});

describe('keys and content types', () => {
  it('builds the room-scoped immutable original key', () => {
    expect(documentOriginalKey('room1', crypto.randomUUID())).toMatch(
      /^rooms\/room1\/documents\/[0-9a-f-]+\/original$/,
    );
  });

  it('stores PDF as its real type and OOXML as an opaque octet stream', () => {
    expect(documentContentType('pdf')).toBe('application/pdf');
    expect(documentContentType('ooxml')).toBe('application/octet-stream');
  });
});
