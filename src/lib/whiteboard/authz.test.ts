import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { verifiedAccountId } from './authz';

describe('authz', () => {
  describe('verifiedAccountId', () => {
    it('reads the Worker-stamped accountId query parameter', () => {
      const request = new Request('http://localhost/room?accountId=acc-1');
      expect(verifiedAccountId(request)).toBe('acc-1');
    });

    it('ignores a Bearer token when no accountId is present', () => {
      const request = new Request('http://localhost/room', {
        headers: { Authorization: 'Bearer not-authorization' },
      });
      expect(verifiedAccountId(request)).toBeNull();
    });

    it('does not treat a Bearer header as the account id', () => {
      const request = new NextRequest('http://localhost/room?accountId=acc-1', {
        headers: { Authorization: 'Bearer acc-forged' },
      });
      expect(verifiedAccountId(request)).toBe('acc-1');
    });
  });
});
