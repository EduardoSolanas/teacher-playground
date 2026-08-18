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
  MAX_ELEMENT_STRING_LENGTH,
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

    it('rejects non-finite viewport numbers', () => {
      expect(roomSceneSchema.safeParse({
        viewport: { x: Number.POSITIVE_INFINITY, y: 0, zoom: 1 },
      }).success).toBe(false);
      expect(roomSceneSchema.safeParse({
        viewport: { x: 0, y: Number.NaN, zoom: 1 },
      }).success).toBe(false);
      expect(roomSceneSchema.safeParse({
        viewport: { x: 0, y: 0, zoom: Number.NEGATIVE_INFINITY },
      }).success).toBe(false);
    });

    it('rejects iframe, embeddable, magicframe, and image element types', () => {
      for (const type of ['iframe', 'embeddable', 'magicframe', 'image', 'IFRAME']) {
        expect(roomSceneSchema.safeParse({
          elements: [{ id: 'el-1', type }],
        }).success).toBe(false);
      }
    });

    it('rejects element links that are not https or relative', () => {
      expect(roomSceneSchema.safeParse({
        elements: [{ id: 'el-1', type: 'rectangle', link: 'javascript:alert(1)' }],
      }).success).toBe(false);
      expect(roomSceneSchema.safeParse({
        elements: [{ id: 'el-1', type: 'rectangle', link: 'data:text/html,<script>' }],
      }).success).toBe(false);
      expect(roomSceneSchema.safeParse({
        elements: [{ id: 'el-1', type: 'rectangle', link: 'http://example.com' }],
      }).success).toBe(false);
      expect(roomSceneSchema.safeParse({
        elements: [{ id: 'el-1', type: 'rectangle', link: '//evil.example/board' }],
      }).success).toBe(false);
    });

    it('accepts https and relative element links', () => {
      expect(roomSceneSchema.safeParse({
        elements: [{ id: 'el-1', type: 'rectangle', link: 'https://example.com/doc' }],
      }).success).toBe(true);
      expect(roomSceneSchema.safeParse({
        elements: [{ id: 'el-1', type: 'rectangle', link: '/assets/handout.pdf' }],
      }).success).toBe(true);
      expect(roomSceneSchema.safeParse({
        elements: [{ id: 'el-1', type: 'rectangle', link: './notes' }],
      }).success).toBe(true);
    });

    it('rejects oversized element lists', () => {
      const result = roomSceneSchema.safeParse({
        elements: new Array(MAX_ELEMENTS + 1).fill({ id: 'el-1' }),
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-array elements', () => {
      expect(roomSceneSchema.safeParse({ elements: { not: 'an array' } }).success).toBe(false);
    });

    it('accepts a minimal valid element object', () => {
      const result = roomSceneSchema.safeParse({
        elements: [{ id: 'rect-1', type: 'rectangle', x: 0, y: 0 }],
      });
      expect(result.success).toBe(true);
    });

    it('rejects non-object elements in the array', () => {
      expect(roomSceneSchema.safeParse({ elements: ['not-an-object'] }).success).toBe(false);
      expect(roomSceneSchema.safeParse({ elements: [42] }).success).toBe(false);
      expect(roomSceneSchema.safeParse({ elements: [null] }).success).toBe(false);
    });

    it('rejects elements missing a conforming id', () => {
      expect(roomSceneSchema.safeParse({ elements: [{ type: 'rectangle' }] }).success).toBe(false);
      expect(roomSceneSchema.safeParse({ elements: [{ id: 'bad id!' }] }).success).toBe(false);
    });

    it('rejects elements with oversized string fields', () => {
      const result = roomSceneSchema.safeParse({
        elements: [{ id: 'el-1', text: 'x'.repeat(MAX_ELEMENT_STRING_LENGTH + 1) }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects deeply nested element payloads', () => {
      let nested: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 20; i += 1) {
        nested = { child: nested };
      }
      const result = roomSceneSchema.safeParse({
        elements: [{ id: 'el-1', nested }],
      });
      expect(result.success).toBe(false);
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

    it('strips ASCII control characters and trims room names', () => {
      const result = roomSettingsSchema.safeParse({ name: '\u0000\u0007 Algebra \u007F' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('Algebra');
      }
    });

    it('rejects room names that are empty after stripping controls', () => {
      expect(roomSettingsSchema.safeParse({ name: '\u0000\u0001' }).success).toBe(false);
      expect(roomSettingsSchema.safeParse({ name: '   \u007F  ' }).success).toBe(false);
    });

    it('strips zero-width characters from room names', () => {
      const result = roomSettingsSchema.safeParse({ name: 'Teacher\u200b' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('Teacher');
      }
    });

    it('collapses confusable whitespace in room names', () => {
      const result = roomSettingsSchema.safeParse({ name: '  A   B  ' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('A B');
      }
    });

    it('rejects room names that are empty after stripping zero-width characters', () => {
      expect(roomSettingsSchema.safeParse({ name: '\u200b\u200c\u200d\uFEFF' }).success).toBe(false);
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

    it('strips ASCII control characters and trims display names', () => {
      const result = presencePostSchema.safeParse({
        peerId: 'user-1',
        userName: '\u0000Alice\u007F',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.userName).toBe('Alice');
      }
    });

    it('rejects display names that are empty after stripping controls', () => {
      expect(presencePostSchema.safeParse({ peerId: 'user-1', userName: '\u0007' }).success).toBe(false);
      expect(presencePostSchema.safeParse({ peerId: 'user-1', userName: '   \u007F  ' }).success).toBe(false);
    });

    it('strips zero-width characters from display names', () => {
      const result = presencePostSchema.safeParse({
        peerId: 'user-1',
        userName: 'Teacher\u200b',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.userName).toBe('Teacher');
      }
    });

    it('collapses confusable whitespace in display names', () => {
      const result = presencePostSchema.safeParse({
        peerId: 'user-1',
        userName: '  A   B  ',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.userName).toBe('A B');
      }
    });

    it('rejects display names that are empty after stripping zero-width characters', () => {
      expect(
        presencePostSchema.safeParse({ peerId: 'user-1', userName: '\u200b\uFEFF' }).success,
      ).toBe(false);
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

    it('strips ASCII control characters and trims request display names', () => {
      const result = requestsPostSchema.safeParse({ userName: '  \u0000Bob\u007F  ' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.userName).toBe('Bob');
      }
    });

    it('rejects request display names that are empty after stripping controls', () => {
      expect(requestsPostSchema.safeParse({ userName: '\u0000\u001F' }).success).toBe(false);
    });
  });

  describe('requestActionPostSchema', () => {
    it('parses an action and an optional role', () => {
      expect(requestActionPostSchema.safeParse({ action: 'approve', role: 'peer' }).success).toBe(true);
      expect(requestActionPostSchema.safeParse({ action: 'deny' }).success).toBe(true);
    });

    it('rejects roles outside the allowed set', () => {
      expect(requestActionPostSchema.safeParse({ action: 'approve', role: 'owner' }).success).toBe(false);
      expect(requestActionPostSchema.safeParse({ action: 'approve', role: 'admin' }).success).toBe(false);
    });
  });
});
