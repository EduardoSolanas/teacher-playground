import { describe, it, expect } from 'vitest';
import { parseBody, roomPostSchema, presencePostSchema, waitingPostSchema, requestsPostSchema, requestActionPostSchema } from './requestSchemas';

describe('requestSchemas', () => {
  describe('parseBody', () => {
    it('returns ok:true with typed data for a valid body', () => {
      const result = parseBody(roomPostSchema, {
        elements: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        maxUsers: 5,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.elements).toEqual([]);
        expect(result.data.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
        expect(result.data.maxUsers).toBe(5);
      }
    });

    it('returns ok:false with a message for an invalid body', () => {
      const result = parseBody(waitingPostSchema, {
        peerId: '',
        action: 'approve',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(typeof result.error).toBe('string');
        expect(result.error.length).toBeGreaterThan(0);
      }
    });

    it('does not throw when parsing invalid data', () => {
      expect(() => {
        parseBody(requestsPostSchema, { userName: '' });
      }).not.toThrow();
    });

    it('uses the first issue message for the error', () => {
      const result = parseBody(requestsPostSchema, { userName: '' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('userName is required');
      }
    });
  });

  describe('roomPostSchema', () => {
    it('allows all fields optional', () => {
      const result = parseBody(roomPostSchema, {});
      expect(result.ok).toBe(true);
    });

    it('allows unknown for elements and viewport', () => {
      const result = parseBody(roomPostSchema, {
        elements: { anything: 'goes' },
        viewport: [1, 2, 3],
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('presencePostSchema', () => {
    it('allows all fields optional', () => {
      const result = parseBody(presencePostSchema, {});
      expect(result.ok).toBe(true);
    });

    it('accepts action kick or suspend', () => {
      const result1 = parseBody(presencePostSchema, { action: 'kick' });
      const result2 = parseBody(presencePostSchema, { action: 'suspend' });
      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
    });

    it('rejects invalid action', () => {
      const result = parseBody(presencePostSchema, { action: 'invalid' });
      expect(result.ok).toBe(false);
    });
  });

  describe('waitingPostSchema', () => {
    it('requires peerId and action', () => {
      const result = parseBody(waitingPostSchema, {});
      expect(result.ok).toBe(false);
    });

    it('requires non-empty peerId', () => {
      const result = parseBody(waitingPostSchema, { peerId: '', action: 'approve' });
      expect(result.ok).toBe(false);
    });

    it('accepts approve or reject action', () => {
      const result1 = parseBody(waitingPostSchema, { peerId: 'peer-1', action: 'approve' });
      const result2 = parseBody(waitingPostSchema, { peerId: 'peer-1', action: 'reject' });
      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
    });
  });

  describe('requestsPostSchema', () => {
    it('requires non-empty userName', () => {
      const result = parseBody(requestsPostSchema, { userName: '' });
      expect(result.ok).toBe(false);
    });

    it('accepts userName with optional email', () => {
      const result = parseBody(requestsPostSchema, { userName: 'Alice', email: 'alice@example.com' });
      expect(result.ok).toBe(true);
    });

    it('accepts userName without email', () => {
      const result = parseBody(requestsPostSchema, { userName: 'Bob' });
      expect(result.ok).toBe(true);
    });
  });

  describe('requestActionPostSchema', () => {
    it('requires action', () => {
      const result = parseBody(requestActionPostSchema, {});
      expect(result.ok).toBe(false);
    });

    it('accepts approve or deny action', () => {
      const result1 = parseBody(requestActionPostSchema, { action: 'approve' });
      const result2 = parseBody(requestActionPostSchema, { action: 'deny' });
      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
    });

    it('accepts optional role peer or viewer', () => {
      const result1 = parseBody(requestActionPostSchema, { action: 'approve', role: 'peer' });
      const result2 = parseBody(requestActionPostSchema, { action: 'approve', role: 'viewer' });
      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
    });

    it('rejects invalid role', () => {
      const result = parseBody(requestActionPostSchema, { action: 'approve', role: 'admin' });
      expect(result.ok).toBe(false);
    });
  });
});
