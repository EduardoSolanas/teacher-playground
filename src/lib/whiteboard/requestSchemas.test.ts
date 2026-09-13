// @ts-nocheck
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
  isAllowedElementLink,
  parseBody,
  PEER_ID_RE,
  ELEMENT_ID_RE,
  ACCOUNT_ID_RE,
  COLOR_RE,
  MAX_ELEMENTS,
  MAX_ELEMENT_KEYS,
  MAX_ELEMENT_NEST_DEPTH,
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

    it('accepts a typical Excalidraw rectangle including null link and boundElements', () => {
      const result = roomSceneSchema.safeParse({
        elements: [{
          id: 'backlog-rect-1',
          type: 'rectangle',
          x: 120,
          y: 120,
          width: 200,
          height: 120,
          angle: 0,
          strokeColor: '#1e1e1e',
          backgroundColor: 'transparent',
          fillStyle: 'solid',
          strokeWidth: 2,
          strokeStyle: 'solid',
          roughness: 1,
          opacity: 100,
          groupIds: [],
          frameId: null,
          roundness: null,
          seed: 12345,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          boundElements: null,
          updated: Date.now(),
          link: null,
          locked: false,
        }],
        viewport: { x: 0, y: 0, zoom: 1 },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a typical Excalidraw freedraw including pressures and points', () => {
      const result = roomSceneSchema.safeParse({
        elements: [{
          id: 'pen-stroke-1',
          type: 'freedraw',
          x: 100,
          y: 100,
          width: 150,
          height: 100,
          angle: 0,
          strokeColor: '#1e1e1e',
          backgroundColor: 'transparent',
          fillStyle: 'solid',
          strokeWidth: 2,
          strokeStyle: 'solid',
          roughness: 1,
          opacity: 100,
          groupIds: [],
          frameId: null,
          roundness: null,
          seed: 1,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          boundElements: null,
          updated: Date.now(),
          link: null,
          locked: false,
          points: [[0, 0], [20, 30], [40, 35]],
          pressures: [0.4, 0.5, 0.4],
          simulatePressure: true,
        }],
        viewport: { x: 0, y: 0, zoom: 1 },
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

    it('accepts nesting at the depth limit and rejects one level beyond with a message', () => {
      // The element property is depth 1; each nested array adds one level.
      let atLimit: unknown = 'leaf';
      for (let i = 0; i < MAX_ELEMENT_NEST_DEPTH - 1; i += 1) atLimit = [atLimit];
      expect(roomSceneSchema.safeParse({
        elements: [{ id: 'el-1', nested: atLimit }],
      }).success).toBe(true);

      let beyond: unknown = 'leaf';
      for (let i = 0; i < MAX_ELEMENT_NEST_DEPTH; i += 1) beyond = [beyond];
      const outcome = parseBody(roomSceneSchema, {
        elements: [{ id: 'el-1', nested: beyond }],
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('element nesting exceeds maximum depth');
    });

    it('does not apply the object key cap to arrays', () => {
      const tags = new Array(MAX_ELEMENT_KEYS + 5).fill('ok');
      expect(roomSceneSchema.safeParse({
        elements: [{ id: 'el-1', tags }],
      }).success).toBe(true);
    });

    it('rejects non-finite numbers anywhere in the element with a message', () => {
      const outcome = parseBody(roomSceneSchema, {
        elements: [{ id: 'el-1', x: Number.NaN }],
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('element number must be finite');
    });

    it('walks nested objects and reports unsupported values inside them', () => {
      const outcome = parseBody(roomSceneSchema, {
        elements: [{ id: 'el-1', nested: { deep: undefined } }],
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('element contains unsupported value type');
    });

    it('rejects unsupported value types directly with a message', () => {
      const outcome = parseBody(roomSceneSchema, {
        elements: [{ id: 'el-1', nothing: undefined }],
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('element contains unsupported value type');
    });

    it('accepts a string at the length limit and rejects one beyond it with a message', () => {
      expect(roomSceneSchema.safeParse({
        elements: [{ id: 'el-1', text: 'x'.repeat(MAX_ELEMENT_STRING_LENGTH) }],
      }).success).toBe(true);

      const outcome = parseBody(roomSceneSchema, {
        elements: [{ id: 'el-1', text: 'x'.repeat(MAX_ELEMENT_STRING_LENGTH + 1) }],
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('element string exceeds maximum length');
    });

    it('caps nested object key counts at the limit and reports the overflow', () => {
      const atLimit = Object.fromEntries(
        Array.from({ length: MAX_ELEMENT_KEYS }, (_, i) => [`k${i}`, 1]),
      );
      expect(roomSceneSchema.safeParse({
        elements: [{ id: 'el-1', data: atLimit }],
      }).success).toBe(true);

      const beyond = Object.fromEntries(
        Array.from({ length: MAX_ELEMENT_KEYS + 1 }, (_, i) => [`k${i}`, 1]),
      );
      const outcome = parseBody(roomSceneSchema, {
        elements: [{ id: 'el-1', data: beyond }],
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('element object exceeds maximum key count');
    });

    it('accepts a key at the length limit and rejects one beyond it with a message', () => {
      expect(roomSceneSchema.safeParse({
        elements: [{ id: 'el-1', data: { ['k'.repeat(MAX_ELEMENT_STRING_LENGTH)]: 1 } }],
      }).success).toBe(true);

      const longKey = 'k'.repeat(MAX_ELEMENT_STRING_LENGTH + 1);
      const outcome = parseBody(roomSceneSchema, {
        elements: [{ id: 'el-1', data: { [longKey]: 1 } }],
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('element key exceeds maximum length');
    });

    it('caps the element key count at the schema boundary with a message', () => {
      const element: Record<string, unknown> = { id: 'el-1' };
      for (let i = 0; i <= MAX_ELEMENT_KEYS; i += 1) element[`k${i}`] = i;

      const outcome = parseBody(roomSceneSchema, { elements: [element] });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('element object exceeds maximum key count');
    });
  });

  describe('grammar anchors and messages', () => {
    it('anchors the id grammars at both ends', () => {
      expect(ELEMENT_ID_RE.test('a'.repeat(128))).toBe(true);
      expect(ELEMENT_ID_RE.test('a'.repeat(129))).toBe(false);
      expect(ELEMENT_ID_RE.test('!'.repeat(3) + 'abc')).toBe(false);
      expect(ELEMENT_ID_RE.test('abc' + '!')).toBe(false);
      expect(ACCOUNT_ID_RE.test('a'.repeat(129))).toBe(false);
      expect(ACCOUNT_ID_RE.test('@abc')).toBe(false);
      expect(ACCOUNT_ID_RE.test('abc@')).toBe(false);
      expect(COLOR_RE.test('#123456')).toBe(true);
      expect(COLOR_RE.test('zz#123456')).toBe(false);
      expect(COLOR_RE.test('#123456zz')).toBe(false);
    });

    it('reports the element id grammar message', () => {
      const outcome = parseBody(roomSceneSchema, { elements: [{ id: 'bad id!' }] });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('element id must match the allowed grammar');
    });

    it('reports the blocked element type message for padded and cased types', () => {
      for (const type of [' iframe ', 'Image', 'MAGICFRAME']) {
        const outcome = parseBody(roomSceneSchema, { elements: [{ id: 'el-1', type }] });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.error).toContain('element type is not permitted');
      }
    });

    it('reports the link message for a disallowed link', () => {
      const outcome = parseBody(roomSceneSchema, {
        elements: [{ id: 'el-1', type: 'rectangle', link: 'http://example.com' }],
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('element link must be https or a relative URL');
    });

    it('rejects non-string links', () => {
      const outcome = parseBody(roomSceneSchema, {
        elements: [{ id: 'el-1', type: 'rectangle', link: 42 }],
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('element link must be https or a relative URL');
    });

    it('accepts an element with exactly the key cap and rejects one more', () => {
      const atLimit: Record<string, unknown> = { id: 'el-1' };
      while (Object.keys(atLimit).length < MAX_ELEMENT_KEYS) {
        atLimit[`k${Object.keys(atLimit).length}`] = 1;
      }
      expect(Object.keys(atLimit)).toHaveLength(MAX_ELEMENT_KEYS);
      expect(roomSceneSchema.safeParse({ elements: [atLimit] }).success).toBe(true);

      atLimit.extra = 1;
      expect(roomSceneSchema.safeParse({ elements: [atLimit] }).success).toBe(false);
    });

    it('reports the presence target message', () => {
      const kick = parseBody(presencePostSchema, { action: 'kick' });
      expect(kick.ok).toBe(false);
      if (!kick.ok) expect(kick.error).toContain('accountId or peerId is required');

      const lower = parseBody(presencePostSchema, { action: 'lower-peer-hand' });
      expect(lower.ok).toBe(false);
      if (!lower.ok) expect(lower.error).toContain('accountId or peerId is required');

      const join = parseBody(presencePostSchema, { userName: 'Alice' });
      expect(join.ok).toBe(false);
      if (!join.ok) expect(join.error).toContain('peerId is required');
    });

    it('tags the lower-peer-hand target issue with the custom code', () => {
      const result = presencePostSchema.safeParse({ action: 'lower-peer-hand' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.code)).toEqual(['custom']);
      }
    });

    it('requires a target for waiting approvals and reports it', () => {
      const outcome = parseBody(waitingPostSchema, { action: 'approve' });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('accountId or peerId is required');
    });

    it('joins multiple issue messages with a separator', () => {
      const outcome = parseBody(roomSettingsSchema, { maxUsers: 0, name: '', hostPeerId: 'bad id!' });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.split('; ').length).toBeGreaterThanOrEqual(2);
    });

    it('tags every scene issue with the custom code', () => {
      const nested = (() => {
        let value: unknown = 'leaf';
        for (let i = 0; i < MAX_ELEMENT_NEST_DEPTH; i += 1) value = [value];
        return value;
      })();
      const overflowingKeys = Object.fromEntries(
        Array.from({ length: MAX_ELEMENT_KEYS + 1 }, (_, i) => [`k${i}`, 1]),
      );
      const wideElement: Record<string, unknown> = { id: 'el-1' };
      for (let i = 0; i <= MAX_ELEMENT_KEYS; i += 1) wideElement[`k${i}`] = i;
      const cases: unknown[] = [
        { elements: [wideElement] },
        { elements: [{ id: 'el-1', nested }] },
        { elements: [{ id: 'el-1', x: Number.NaN }] },
        { elements: [{ id: 'el-1', text: 'x'.repeat(MAX_ELEMENT_STRING_LENGTH + 1) }] },
        { elements: [{ id: 'el-1', data: overflowingKeys }] },
        { elements: [{ id: 'el-1', data: { ['k'.repeat(MAX_ELEMENT_STRING_LENGTH + 1)]: 1 } }] },
        { elements: [{ id: 'el-1', nothing: undefined }] },
        { elements: [{ id: 'el-1', type: 'iframe' }] },
        { elements: [{ id: 'el-1', type: 'rectangle', link: 'http://example.com' }] },
      ];

      for (const body of cases) {
        const result = roomSceneSchema.safeParse(body);
        expect(result.success).toBe(false);
        if (!result.success) {
          for (const issue of result.error.issues) expect(issue.code).toBe('custom');
        }
      }
    });

    it('tags presence and waiting issues with the custom code', () => {
      const cases = [
        [presencePostSchema, { action: 'kick' }],
        [presencePostSchema, { userName: 'Alice' }],
        [waitingPostSchema, { action: 'approve' }],
      ] as const;

      for (const [schema, body] of cases) {
        const result = schema.safeParse(body);
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.issues[0].code).toBe('custom');
      }
    });
  });

  describe('isAllowedElementLink', () => {
    it('accepts https and relative links', () => {
      expect(isAllowedElementLink('https://example.com/doc')).toBe(true);
      expect(isAllowedElementLink('/assets/handout.pdf')).toBe(true);
      expect(isAllowedElementLink('./notes')).toBe(true);
      expect(isAllowedElementLink('../notes')).toBe(true);
      expect(isAllowedElementLink('#section')).toBe(true);
      expect(isAllowedElementLink('?query')).toBe(true);
    });

    it('rejects other schemes and protocol-relative links', () => {
      expect(isAllowedElementLink('http://example.com')).toBe(false);
      expect(isAllowedElementLink('javascript:alert(1)')).toBe(false);
      expect(isAllowedElementLink('mailto:someone@example.com')).toBe(false);
      expect(isAllowedElementLink('//evil.example/x')).toBe(false);
    });

    it('rejects blank values and protocol-looking fragments', () => {
      expect(isAllowedElementLink('')).toBe(false);
      expect(isAllowedElementLink('   ')).toBe(false);
      expect(isAllowedElementLink('https:')).toBe(false);
      expect(isAllowedElementLink('1javascript:')).toBe(true);
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

    it('accepts guestAccess and rotateGuestPin booleans', () => {
      const enabled = roomSettingsSchema.safeParse({ guestAccess: true });
      expect(enabled.success).toBe(true);
      if (enabled.success) expect(enabled.data.guestAccess).toBe(true);
      const rotated = roomSettingsSchema.safeParse({ rotateGuestPin: true });
      expect(rotated.success).toBe(true);
      if (rotated.success) expect(rotated.data.rotateGuestPin).toBe(true);
      expect(roomSettingsSchema.safeParse({ guestAccess: false }).success).toBe(true);
    });

    it('rejects a client-supplied PIN string', () => {
      expect(roomSettingsSchema.safeParse({ guestPin: '123456' }).success).toBe(false);
      expect(roomSettingsSchema.safeParse({ pin: '123456' }).success).toBe(false);
      expect(roomSettingsSchema.safeParse({ guestAccess: true, guestPin: '123456' }).success).toBe(false);
    });

    it('rejects non-boolean guestAccess and rotateGuestPin', () => {
      expect(roomSettingsSchema.safeParse({ guestAccess: 'yes' }).success).toBe(false);
      expect(roomSettingsSchema.safeParse({ rotateGuestPin: 1 }).success).toBe(false);
    });
  });

  describe('route field mixing', () => {
    it('detects creator-only settings fields', () => {
      expect(hasRoomSettingsIntent({ elements: [] })).toBe(false);
      expect(hasRoomSettingsIntent({ maxUsers: 4 })).toBe(true);
      expect(hasRoomSettingsIntent({ name: 'Room' })).toBe(true);
      expect(hasRoomSettingsIntent({ hostPeerId: 'abc' })).toBe(true);
      expect(hasRoomSettingsIntent({ allowFirstUserHost: false })).toBe(true);
      expect(hasRoomSettingsIntent({ guestAccess: true })).toBe(true);
      expect(hasRoomSettingsIntent({ rotateGuestPin: true })).toBe(true);
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

    it('accepts raise-hand and lower-hand without a target account', () => {
      expect(presencePostSchema.safeParse({ action: 'raise-hand' }).success).toBe(true);
      expect(presencePostSchema.safeParse({ action: 'lower-hand' }).success).toBe(true);
    });

    it('accepts lower-all-hands without a target', () => {
      expect(presencePostSchema.safeParse({ action: 'lower-all-hands' }).success).toBe(true);
    });

    it('requires a target for lower-peer-hand', () => {
      expect(presencePostSchema.safeParse({ action: 'lower-peer-hand' }).success).toBe(false);
      expect(presencePostSchema.safeParse({
        action: 'lower-peer-hand',
        accountId: '11111111-2222-3333-4444-555555555555',
      }).success).toBe(true);
    });

    it('rejects unknown presence actions', () => {
      expect(presencePostSchema.safeParse({ action: 'wave', peerId: 'user-1' }).success).toBe(false);
    });

    it('still requires peerId for a join heartbeat', () => {
      expect(presencePostSchema.safeParse({ userName: 'Alice' }).success).toBe(false);
      expect(presencePostSchema.safeParse({ peerId: 'user-1' }).success).toBe(true);
    });

    it('still requires a target for kick and suspend', () => {
      expect(presencePostSchema.safeParse({ action: 'kick' }).success).toBe(false);
      expect(presencePostSchema.safeParse({ action: 'suspend' }).success).toBe(false);
      expect(presencePostSchema.safeParse({
        action: 'kick',
        accountId: '11111111-2222-3333-4444-555555555555',
      }).success).toBe(true);
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
