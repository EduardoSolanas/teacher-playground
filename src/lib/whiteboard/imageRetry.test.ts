import { describe, it, expect } from 'vitest';
import {
  shouldRetryMissingImage,
  recordMissing,
  IMAGE_RETRY_DELAY_MS,
  IMAGE_MAX_RETRIES,
  type MissingImageEntry,
} from './imageRetry';

describe('imageRetry', () => {
  describe('shouldRetryMissingImage', () => {
    it('should retry on first time (no entry)', () => {
      const now = Date.now();
      expect(shouldRetryMissingImage(undefined, now)).toBe(true);
    });

    it('should not retry before delay passes', () => {
      const now = Date.now();
      const entry: MissingImageEntry = { at: now - 1000, retries: 0 };
      expect(shouldRetryMissingImage(entry, now)).toBe(false);
    });

    it('should retry after delay passes', () => {
      const now = Date.now();
      const entry: MissingImageEntry = { at: now - IMAGE_RETRY_DELAY_MS - 1000, retries: 0 };
      expect(shouldRetryMissingImage(entry, now)).toBe(true);
    });

    it('should not retry after max retries exceeded', () => {
      const now = Date.now();
      const entry: MissingImageEntry = { at: now - IMAGE_RETRY_DELAY_MS - 1000, retries: IMAGE_MAX_RETRIES };
      expect(shouldRetryMissingImage(entry, now)).toBe(false);
    });

    it('should retry up to max retries', () => {
      const now = Date.now();
      const entry: MissingImageEntry = { at: now - IMAGE_RETRY_DELAY_MS - 1000, retries: IMAGE_MAX_RETRIES - 1 };
      expect(shouldRetryMissingImage(entry, now)).toBe(true);
    });

    it('should retry exactly at delay boundary', () => {
      const now = Date.now();
      const entry: MissingImageEntry = { at: now - IMAGE_RETRY_DELAY_MS, retries: 0 };
      expect(shouldRetryMissingImage(entry, now)).toBe(true);
    });
  });

  describe('recordMissing', () => {
    it('should create entry with retries: 1 for first miss', () => {
      const now = Date.now();
      const result = recordMissing(undefined, now);
      expect(result.at).toBe(now);
      expect(result.retries).toBe(1);
    });

    it('should increment retries for existing entry', () => {
      const now = Date.now();
      const existing: MissingImageEntry = { at: now - 5000, retries: 2 };
      const result = recordMissing(existing, now);
      expect(result.at).toBe(now);
      expect(result.retries).toBe(3);
    });

    it('should update timestamp on retry', () => {
      const now1 = Date.now();
      const now2 = now1 + 5000;
      const existing: MissingImageEntry = { at: now1, retries: 1 };
      const result = recordMissing(existing, now2);
      expect(result.at).toBe(now2);
    });
  });
});
