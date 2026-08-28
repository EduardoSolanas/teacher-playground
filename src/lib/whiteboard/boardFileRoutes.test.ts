import { describe, it, expect } from 'vitest';
import {
  MAX_BOARD_FILE_BYTES,
  isValidFileId,
  isAllowedMimeType,
  buildR2ObjectKey,
  validateFileUploadRequest,
  type ValidFileUploadRequest,
} from './boardFileRoutes';

describe('boardFileRoutes', () => {
  describe('isValidFileId', () => {
    it('accepts valid file IDs matching ^[A-Za-z0-9_-]{1,64}$', () => {
      expect(isValidFileId('abc123')).toBe(true);
      expect(isValidFileId('ABC_DEF-ghi')).toBe(true);
      expect(isValidFileId('a')).toBe(true);
      expect(isValidFileId('A-_0')).toBe(true);
    });

    it('rejects invalid file IDs', () => {
      expect(isValidFileId('')).toBe(false);
      expect(isValidFileId('a'.repeat(65))).toBe(false);
      expect(isValidFileId('abc/def')).toBe(false);
      expect(isValidFileId('abc def')).toBe(false);
      expect(isValidFileId('abc.def')).toBe(false);
      expect(isValidFileId('abc@def')).toBe(false);
    });
  });

  describe('isAllowedMimeType', () => {
    it('allows image/png, image/jpeg, image/webp, image/gif', () => {
      expect(isAllowedMimeType('image/png')).toBe(true);
      expect(isAllowedMimeType('image/jpeg')).toBe(true);
      expect(isAllowedMimeType('image/webp')).toBe(true);
      expect(isAllowedMimeType('image/gif')).toBe(true);
    });

    it('rejects SVG and other types', () => {
      expect(isAllowedMimeType('image/svg+xml')).toBe(false);
      expect(isAllowedMimeType('text/plain')).toBe(false);
      expect(isAllowedMimeType('application/json')).toBe(false);
      expect(isAllowedMimeType('image/x-icon')).toBe(false);
    });

    it('handles null or empty string', () => {
      expect(isAllowedMimeType('')).toBe(false);
      expect(isAllowedMimeType(null as any)).toBe(false);
    });
  });

  describe('buildR2ObjectKey', () => {
    it('builds rooms/${roomId}/files/${fileId} format', () => {
      expect(buildR2ObjectKey('room123', 'file456')).toBe('rooms/room123/files/file456');
      expect(buildR2ObjectKey('abc', 'xyz')).toBe('rooms/abc/files/xyz');
    });
  });

  describe('MAX_BOARD_FILE_BYTES', () => {
    it('exports 25 MB as the limit', () => {
      expect(MAX_BOARD_FILE_BYTES).toBe(25 * 1024 * 1024);
    });
  });

  describe('validateFileUploadRequest', () => {
    it('accepts valid PUT request with allowed content type and size', () => {
      const result = validateFileUploadRequest({
        method: 'PUT',
        fileId: 'file-123',
        mimeType: 'image/png',
        contentLength: 1024 * 1024,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result as any).value).toEqual({
          method: 'PUT',
          fileId: 'file-123',
          mimeType: 'image/png',
          contentLength: 1024 * 1024,
        });
      }
    });

    it('rejects invalid file ID with 400', () => {
      const result = validateFileUploadRequest({
        method: 'PUT',
        fileId: 'invalid/file',
        mimeType: 'image/png',
        contentLength: 1024,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
      }
    });

    it('rejects disallowed content type with 415', () => {
      const result = validateFileUploadRequest({
        method: 'PUT',
        fileId: 'file-123',
        mimeType: 'image/svg+xml',
        contentLength: 1024,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(415);
      }
    });

    it('rejects SVG explicitly with 415', () => {
      const result = validateFileUploadRequest({
        method: 'PUT',
        fileId: 'file-123',
        mimeType: 'image/svg+xml',
        contentLength: 1024,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(415);
      }
    });

    it('rejects content length over MAX_BOARD_FILE_BYTES with 413', () => {
      const result = validateFileUploadRequest({
        method: 'PUT',
        fileId: 'file-123',
        mimeType: 'image/png',
        contentLength: MAX_BOARD_FILE_BYTES + 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(413);
      }
    });

    it('accepts content length exactly at MAX_BOARD_FILE_BYTES', () => {
      const result = validateFileUploadRequest({
        method: 'PUT',
        fileId: 'file-123',
        mimeType: 'image/png',
        contentLength: MAX_BOARD_FILE_BYTES,
      });
      expect(result.ok).toBe(true);
    });

    it('rejects GET requests in upload validation', () => {
      const result = validateFileUploadRequest({
        method: 'GET',
        fileId: 'file-123',
        mimeType: 'image/png',
        contentLength: 1024,
      });
      expect(result.ok).toBe(false);
    });
  });
});
