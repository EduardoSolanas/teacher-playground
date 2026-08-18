import { describe, it, expect } from 'vitest';
import {
  roomPostSchema,
  roomSceneSchema,
  roomSettingsSchema,
  presencePostSchema,
  waitingPostSchema,
  requestsPostSchema,
  requestActionPostSchema,
  hasRoomSettingsIntent,
  hasRoomSceneIntent,
  PEER_ID_RE,
  COLOR_RE,
  MAX_ELEMENTS,
  MAX_MAX_USERS,
} from './requestSchemas';

describe('requestSchemas hardening (SEC-005)', () => {
  describe('roomSceneSchema', () => {
    it('parses a valid scene body', () => {
      const result = roomSceneSchema.safeParse({
        elements: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      });
      expect(result.success).toBe(true);
    });

    it('rejects malformed viewport', () => {
      const result = roomPostSchema.safeParse({
        viewport: { x: 'zero', y: 0, zoom: 1 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects oversized element lists', () => {
      const result = roomSceneSchema.safeParse({
        elements: new Array(MAX_ELEMENTS + 1).fill({ type: 'rectangle' }),
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-array elements', () => {
      expect(roomSceneSchema.safeParse({ elements: { not: 'an array' } }).success).toBe(false);
    });
  });

  describe('roomSettingsSchema', () => {
    it('parses a valid settings body', () => {
      const result = roomSettingsSchema.safeParse({
        maxUsers: 3,
        hostPeerId: 'abcdefg1',
        name: 'Algebra',
        allowFirstUserHost: false,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxUsers).toBe(3);
        expect(result.data.name).toBe('Algebra');
      }
    });

    it('rejects maxUsers outside the allowed range', () => {
      expect(roomSettingsSchema.safeParse({ maxUsers: 0 }).success).toBe(false);
      expect(roomSettingsSchema.safeParse({ maxUsers: 11 }).success).toBe(false);
      expect(roomSettingsSchema.safeParse({ maxUsers: MAX_MAX_USERS }).success).toBe(true);
    });

    it('rejects oversized room names', () => {
      expect(roomSettingsSchema.safeParse({ name: 'a'.repeat(101) }).success).toBe(false);
    });

    it('rejects non-conforming hostPeerId', () => {
      expect(roomSettingsSchema.safeParse({ hostPeerId: 'bad peer id!' }).success).toBe(false);
    });
  });

  describe('route field mixing', () => {
    it('detects creator-only settings fields', () => {
      expect(hasRoomSettingsIntent({ elements: [] })).toBe(false);
      expect(hasRoomSettingsIntent({ maxUsers: 4 })).toBe(true);
      expect(hasRoomSettingsIntent({ name: 'Room' })).toBe(true);
      expect(hasRoomSettingsIntent({ hostPeerId: 'abc' })).toBe(true);
      expect(hasRoomSettingsIntent({ allowFirstUserHost: false })).toBe(true);
      expect(hasRoomSettingsIntent(null)).toBe(false);
    });

    it('detects scene fields on a settings body', () => {
      expect(hasRoomSceneIntent({ maxUsers: 4 })).toBe(false);
      expect(hasRoomSceneIntent({ elements: [] })).toBe(true);
      expect(hasRoomSceneIntent({ viewport: { x: 0, y: 0, zoom: 1 } })).toBe(true);
      expect(hasRoomSceneIntent(null)).toBe(false);
    });
  });

  describe('presencePostSchema', () => {
    it('accepts a conforming peerId', () => {
      expect(PEER_ID_RE.test('user-abc123')).toBe(true);
      const result = presencePostSchema.safeParse({ peerId: 'user-abc123' });
      expect(result.success).toBe(true);
    });

    it('allows kick by accountId without a peerId', () => {
      expect(presencePostSchema.safeParse({
        action: 'kick',
        accountId: '11111111-2222-3333-4444-555555555555',
      }).success).toBe(true);
    });

    it('rejects an out-of-grammar peerId', () => {
      expect(presencePostSchema.safeParse({ peerId: 'has spaces' }).success).toBe(false);
    });

    it('rejects oversized user names', () => {
      expect(presencePostSchema.safeParse({ peerId: 'user-1', userName: 'a'.repeat(101) }).success).toBe(false);
    });

    it('accepts a 6-digit hex color', () => {
      expect(COLOR_RE.test('#3498db')).toBe(true);
      expect(presencePostSchema.safeParse({ peerId: 'user-1', color: '#3498db' }).success).toBe(true);
    });

    it('rejects malformed colors', () => {
      expect(presencePostSchema.safeParse({ peerId: 'user-1', color: 'red' }).success).toBe(false);
    });
  });

  describe('waitingPostSchema', () => {
    it('rejects an out-of-grammar peerId', () => {
      expect(waitingPostSchema.safeParse({ peerId: '../evil', action: 'approve' }).success).toBe(false);
    });

    it('accepts moderate-by-accountId without a peerId', () => {
      expect(waitingPostSchema.safeParse({
        action: 'approve',
        accountId: '11111111-2222-3333-4444-555555555555',
      }).success).toBe(true);
    });
  });

  describe('requestsPostSchema', () => {
    it('accepts a valid email', () => {
      expect(requestsPostSchema.safeParse({ userName: 'Alice', email: 'alice@example.com' }).success).toBe(true);
    });

    it('rejects an invalid email', () => {
      expect(requestsPostSchema.safeParse({ userName: 'Alice', email: 'not-an-email' }).success).toBe(false);
    });

    it('rejects an oversized user name', () => {
      expect(requestsPostSchema.safeParse({ userName: 'a'.repeat(101) }).success).toBe(false);
    });
  });

  describe('requestActionPostSchema', () => {
    it('parses an action and an optional role', () => {
      expect(requestActionPostSchema.safeParse({ action: 'approve', role: 'peer' }).success).toBe(true);
      expect(requestActionPostSchema.safeParse({ action: 'deny' }).success).toBe(true);
    });
  });
});
