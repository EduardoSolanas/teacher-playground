import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getBearerToken, requireGrant } from './authz';
import { getRoomDb } from './roomDb';
import { grantAccess } from './access';

describe('authz', () => {
  describe('getBearerToken', () => {
    it('parses a valid Authorization header', () => {
      const request = new NextRequest('http://localhost/test', {
        headers: { 'Authorization': 'Bearer my-token-123' },
      });
      const token = getBearerToken(request);
      expect(token).toBe('my-token-123');
    });

    it('parses Authorization header case-insensitively on scheme', () => {
      const request = new NextRequest('http://localhost/test', {
        headers: { 'Authorization': 'bearer my-token-456' },
      });
      const token = getBearerToken(request);
      expect(token).toBe('my-token-456');
    });

    it('trims whitespace from the token', () => {
      const request = new NextRequest('http://localhost/test', {
        headers: { 'Authorization': 'Bearer   my-token-789   ' },
      });
      const token = getBearerToken(request);
      expect(token).toBe('my-token-789');
    });

    it('returns null for missing Authorization header', () => {
      const request = new NextRequest('http://localhost/test', {});
      const token = getBearerToken(request);
      expect(token).toBeNull();
    });

    it('returns null for malformed Authorization header (no Bearer)', () => {
      const request = new NextRequest('http://localhost/test', {
        headers: { 'Authorization': 'Basic dXNlcjpwYXNz' },
      });
      const token = getBearerToken(request);
      expect(token).toBeNull();
    });

    it('returns null for empty token after Bearer scheme', () => {
      const request = new NextRequest('http://localhost/test', {
        headers: { 'Authorization': 'Bearer ' },
      });
      const token = getBearerToken(request);
      expect(token).toBeNull();
    });

    it('returns null for Bearer with only whitespace', () => {
      const request = new NextRequest('http://localhost/test', {
        headers: { 'Authorization': 'Bearer    ' },
      });
      const token = getBearerToken(request);
      expect(token).toBeNull();
    });
  });

  describe('requireGrant', () => {
    it('returns null if no bearer token is present', async () => {
      const db = getRoomDb();
      const roomId = `authz-no-token-${crypto.randomUUID()}`;
      const request = new NextRequest('http://localhost/test', {});
      const grant = requireGrant(db, roomId, request);
      expect(grant).toBeNull();
    });

    it('returns null for an unknown token', async () => {
      const db = getRoomDb();
      const roomId = `authz-unknown-token-${crypto.randomUUID()}`;
      const request = new NextRequest('http://localhost/test', {
        headers: { 'Authorization': 'Bearer unknown-token-xyz' },
      });
      const grant = requireGrant(db, roomId, request);
      expect(grant).toBeNull();
    });

    it('returns the grant for a valid token', async () => {
      const db = getRoomDb();
      const roomId = `authz-valid-token-${crypto.randomUUID()}`;
      const token = `token-valid-${crypto.randomUUID()}`;

      grantAccess(db, {
        roomId,
        token,
        role: 'creator',
        userName: 'TestUser',
        email: 'test@example.com',
      });

      const request = new NextRequest('http://localhost/test', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const grant = requireGrant(db, roomId, request);

      expect(grant).not.toBeNull();
      expect(grant?.role).toBe('creator');
      expect(grant?.userName).toBe('TestUser');
      expect(grant?.email).toBe('test@example.com');
    });

    it('returns null when role is not in allowed list', async () => {
      const db = getRoomDb();
      const roomId = `authz-role-filter-${crypto.randomUUID()}`;
      const token = `token-role-filter-${crypto.randomUUID()}`;

      grantAccess(db, {
        roomId,
        token,
        role: 'peer',
        userName: 'PeerUser',
      });

      const request = new NextRequest('http://localhost/test', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const grant = requireGrant(db, roomId, request, ['creator', 'viewer']);

      expect(grant).toBeNull();
    });

    it('returns the grant when role is in allowed list', async () => {
      const db = getRoomDb();
      const roomId = `authz-role-allowed-${crypto.randomUUID()}`;
      const token = `token-role-allowed-${crypto.randomUUID()}`;

      grantAccess(db, {
        roomId,
        token,
        role: 'peer',
        userName: 'PeerUser',
      });

      const request = new NextRequest('http://localhost/test', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const grant = requireGrant(db, roomId, request, ['creator', 'peer']);

      expect(grant).not.toBeNull();
      expect(grant?.role).toBe('peer');
    });

    it('returns null for expired grant', async () => {
      const db = getRoomDb();
      const roomId = `authz-expired-${crypto.randomUUID()}`;
      const token = `token-expired-${crypto.randomUUID()}`;
      const now = Date.now();

      grantAccess(db, {
        roomId,
        token,
        role: 'peer',
        userName: 'PeerUser',
        expiresAt: now - 1000, // expired 1 second ago
        now,
      });

      const request = new NextRequest('http://localhost/test', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const grant = requireGrant(db, roomId, request, undefined, now);

      expect(grant).toBeNull();
    });
  });
});
