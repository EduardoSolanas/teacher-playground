import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from './roomDb';
import {
  hashToken,
  grantAccess,
  findGrant,
  createRequest,
  listRequests,
  approveRequest,
  denyRequest,
  revokeGrant,
  purgeExpiredGrants,
  Grant,
  AccessRequest,
} from './access';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('access control', () => {
  describe('hashToken', () => {
    it('is deterministic', () => {
      const token = 'test-token';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);
      expect(hash1).toBe(hash2);
    });

    it('differs for different inputs', () => {
      const hash1 = hashToken('token-a');
      const hash2 = hashToken('token-b');
      expect(hash1).not.toBe(hash2);
    });

    it('never equals the plaintext', () => {
      const token = 'plaintext-token';
      const hash = hashToken(token);
      expect(hash).not.toBe(token);
    });
  });

  describe('grantAccess', () => {
    it('stores a grant and returns it', () => {
      const grant = grantAccess(db, {
        roomId: 'room-1',
        token: 'token-123',
        role: 'peer',
        userName: 'Alice',
        email: 'alice@example.com',
        now: 1000,
      });

      expect(grant.roomId).toBe('room-1');
      expect(grant.role).toBe('peer');
      expect(grant.userName).toBe('Alice');
      expect(grant.email).toBe('alice@example.com');
      expect(grant.createdAt).toBe(1000);
      expect(grant.expiresAt).toBeNull();
    });

    it('stores expiresAt when provided', () => {
      const grant = grantAccess(db, {
        roomId: 'room-1',
        token: 'token-123',
        role: 'viewer',
        userName: 'Bob',
        expiresAt: 2000,
        now: 1000,
      });

      expect(grant.expiresAt).toBe(2000);
    });

    it('defaults to Date.now() for createdAt', () => {
      const beforeTime = Date.now();
      const grant = grantAccess(db, {
        roomId: 'room-1',
        token: 'token-123',
        role: 'peer',
        userName: 'Alice',
      });
      const afterTime = Date.now();

      expect(grant.createdAt).toBeGreaterThanOrEqual(beforeTime);
      expect(grant.createdAt).toBeLessThanOrEqual(afterTime);
    });

    it('allows email to be undefined', () => {
      const grant = grantAccess(db, {
        roomId: 'room-1',
        token: 'token-123',
        role: 'peer',
        userName: 'Charlie',
      });

      expect(grant.email).toBeNull();
    });
  });

  describe('findGrant', () => {
    it('finds a valid grant by token', () => {
      grantAccess(db, {
        roomId: 'room-1',
        token: 'token-123',
        role: 'peer',
        userName: 'Alice',
        now: 1000,
      });

      const grant = findGrant(db, 'room-1', 'token-123', 1500);
      expect(grant).not.toBeNull();
      expect(grant?.userName).toBe('Alice');
      expect(grant?.role).toBe('peer');
    });

    it('returns null for a different token', () => {
      grantAccess(db, {
        roomId: 'room-1',
        token: 'token-123',
        role: 'peer',
        userName: 'Alice',
      });

      const grant = findGrant(db, 'room-1', 'wrong-token');
      expect(grant).toBeNull();
    });

    it('returns null when grant is expired', () => {
      grantAccess(db, {
        roomId: 'room-1',
        token: 'token-123',
        role: 'peer',
        userName: 'Alice',
        expiresAt: 2000,
        now: 1000,
      });

      const grant = findGrant(db, 'room-1', 'token-123', 2000);
      expect(grant).toBeNull();
    });

    it('returns grant when expires_at is in the future', () => {
      grantAccess(db, {
        roomId: 'room-1',
        token: 'token-123',
        role: 'peer',
        userName: 'Alice',
        expiresAt: 3000,
        now: 1000,
      });

      const grant = findGrant(db, 'room-1', 'token-123', 2000);
      expect(grant).not.toBeNull();
      expect(grant?.userName).toBe('Alice');
    });

    it('returns grant when expires_at is null', () => {
      grantAccess(db, {
        roomId: 'room-1',
        token: 'token-123',
        role: 'peer',
        userName: 'Alice',
        expiresAt: null,
        now: 1000,
      });

      const grant = findGrant(db, 'room-1', 'token-123', 999999);
      expect(grant).not.toBeNull();
    });

    it('scopes grants per room', () => {
      grantAccess(db, {
        roomId: 'room-a',
        token: 'token-shared',
        role: 'peer',
        userName: 'Alice',
      });

      const grantA = findGrant(db, 'room-a', 'token-shared');
      const grantB = findGrant(db, 'room-b', 'token-shared');

      expect(grantA).not.toBeNull();
      expect(grantB).toBeNull();
    });

    it('uses Date.now() when now is not provided', () => {
      grantAccess(db, {
        roomId: 'room-1',
        token: 'token-123',
        role: 'peer',
        userName: 'Alice',
        expiresAt: Date.now() + 10000,
      });

      const grant = findGrant(db, 'room-1', 'token-123');
      expect(grant).not.toBeNull();
    });
  });

  describe('createRequest', () => {
    it('creates an access request', () => {
      const request = createRequest(db, {
        roomId: 'room-1',
        requestId: 'req-1',
        token: 'token-123',
        userName: 'Bob',
        email: 'bob@example.com',
        now: 1000,
      });

      expect(request.requestId).toBe('req-1');
      expect(request.roomId).toBe('room-1');
      expect(request.userName).toBe('Bob');
      expect(request.email).toBe('bob@example.com');
      expect(request.requestedAt).toBe(1000);
    });

    it('allows email to be undefined', () => {
      const request = createRequest(db, {
        roomId: 'room-1',
        requestId: 'req-1',
        token: 'token-123',
        userName: 'Bob',
      });

      expect(request.email).toBeNull();
    });
  });

  describe('listRequests', () => {
    it('returns requests in requested_at order', () => {
      createRequest(db, {
        roomId: 'room-1',
        requestId: 'req-1',
        token: 'token-1',
        userName: 'Alice',
        now: 1000,
      });
      createRequest(db, {
        roomId: 'room-1',
        requestId: 'req-2',
        token: 'token-2',
        userName: 'Bob',
        now: 500,
      });
      createRequest(db, {
        roomId: 'room-1',
        requestId: 'req-3',
        token: 'token-3',
        userName: 'Charlie',
        now: 1500,
      });

      const requests = listRequests(db, 'room-1');

      expect(requests).toHaveLength(3);
      expect(requests[0].requestId).toBe('req-2');
      expect(requests[1].requestId).toBe('req-1');
      expect(requests[2].requestId).toBe('req-3');
    });

    it('returns empty list for room with no requests', () => {
      const requests = listRequests(db, 'room-no-requests');
      expect(requests).toEqual([]);
    });

    it('filters requests by room', () => {
      createRequest(db, {
        roomId: 'room-a',
        requestId: 'req-a',
        token: 'token-a',
        userName: 'Alice',
      });
      createRequest(db, {
        roomId: 'room-b',
        requestId: 'req-b',
        token: 'token-b',
        userName: 'Bob',
      });

      const requestsA = listRequests(db, 'room-a');
      const requestsB = listRequests(db, 'room-b');

      expect(requestsA).toHaveLength(1);
      expect(requestsA[0].requestId).toBe('req-a');
      expect(requestsB).toHaveLength(1);
      expect(requestsB[0].requestId).toBe('req-b');
    });
  });

  describe('approveRequest', () => {
    it('moves request to grant with correct role', () => {
      createRequest(db, {
        roomId: 'room-1',
        requestId: 'req-1',
        token: 'token-123',
        userName: 'Alice',
        now: 1000,
      });

      const grant = approveRequest(db, 'room-1', 'req-1', {
        role: 'peer',
        now: 1500,
      });

      expect(grant).not.toBeNull();
      expect(grant?.role).toBe('peer');
      expect(grant?.userName).toBe('Alice');
      expect(grant?.createdAt).toBe(1500);

      const foundGrant = findGrant(db, 'room-1', 'token-123');
      expect(foundGrant).not.toBeNull();
      expect(foundGrant?.role).toBe('peer');

      const requests = listRequests(db, 'room-1');
      expect(requests).toHaveLength(0);
    });

    it('sets expiresAt when provided', () => {
      createRequest(db, {
        roomId: 'room-1',
        requestId: 'req-1',
        token: 'token-123',
        userName: 'Alice',
      });

      const grant = approveRequest(db, 'room-1', 'req-1', {
        role: 'viewer',
        expiresAt: 3000,
        now: 1000,
      });

      expect(grant?.expiresAt).toBe(3000);
    });

    it('returns null for unknown requestId', () => {
      const grant = approveRequest(db, 'room-1', 'unknown-req', {
        role: 'peer',
      });

      expect(grant).toBeNull();
    });

    it('leaves database unchanged when approveRequest returns null', () => {
      createRequest(db, {
        roomId: 'room-1',
        requestId: 'req-1',
        token: 'token-1',
        userName: 'Alice',
      });

      const result = approveRequest(db, 'room-1', 'unknown-req', {
        role: 'peer',
      });

      expect(result).toBeNull();

      const requests = listRequests(db, 'room-1');
      expect(requests).toHaveLength(1);
    });

    it('is atomic - either fully completes or rolls back', () => {
      createRequest(db, {
        roomId: 'room-1',
        requestId: 'req-1',
        token: 'token-123',
        userName: 'Alice',
      });

      approveRequest(db, 'room-1', 'req-1', {
        role: 'peer',
        now: 1000,
      });

      const grant = findGrant(db, 'room-1', 'token-123');
      const requests = listRequests(db, 'room-1');

      expect(grant).not.toBeNull();
      expect(requests).toHaveLength(0);
    });
  });

  describe('denyRequest', () => {
    it('removes the request', () => {
      createRequest(db, {
        roomId: 'room-1',
        requestId: 'req-1',
        token: 'token-123',
        userName: 'Alice',
      });

      const result = denyRequest(db, 'room-1', 'req-1');

      expect(result).toBe(true);
      const requests = listRequests(db, 'room-1');
      expect(requests).toHaveLength(0);
    });

    it('does not create a grant', () => {
      createRequest(db, {
        roomId: 'room-1',
        requestId: 'req-1',
        token: 'token-123',
        userName: 'Alice',
      });

      denyRequest(db, 'room-1', 'req-1');

      const grant = findGrant(db, 'room-1', 'token-123');
      expect(grant).toBeNull();
    });

    it('returns false for unknown requestId', () => {
      const result = denyRequest(db, 'room-1', 'unknown-req');
      expect(result).toBe(false);
    });
  });

  describe('revokeGrant', () => {
    it('removes a valid grant', () => {
      grantAccess(db, {
        roomId: 'room-1',
        token: 'token-123',
        role: 'peer',
        userName: 'Alice',
      });

      const result = revokeGrant(db, 'room-1', 'token-123');

      expect(result).toBe(true);
      const grant = findGrant(db, 'room-1', 'token-123');
      expect(grant).toBeNull();
    });

    it('makes a previously valid token stop working', () => {
      grantAccess(db, {
        roomId: 'room-1',
        token: 'token-123',
        role: 'peer',
        userName: 'Alice',
      });

      const grantBefore = findGrant(db, 'room-1', 'token-123');
      expect(grantBefore).not.toBeNull();

      revokeGrant(db, 'room-1', 'token-123');

      const grantAfter = findGrant(db, 'room-1', 'token-123');
      expect(grantAfter).toBeNull();
    });

    it('returns false for unknown token', () => {
      const result = revokeGrant(db, 'room-1', 'unknown-token');
      expect(result).toBe(false);
    });
  });

  describe('purgeExpiredGrants', () => {
    it('removes only expired grants', () => {
      grantAccess(db, {
        roomId: 'room-1',
        token: 'token-expired',
        role: 'peer',
        userName: 'Alice',
        expiresAt: 1000,
      });
      grantAccess(db, {
        roomId: 'room-1',
        token: 'token-valid',
        role: 'peer',
        userName: 'Bob',
        expiresAt: 3000,
      });
      grantAccess(db, {
        roomId: 'room-1',
        token: 'token-never-expires',
        role: 'peer',
        userName: 'Charlie',
        expiresAt: null,
      });

      const result = purgeExpiredGrants(db, 2000);

      expect(result).toBe(1);
      expect(findGrant(db, 'room-1', 'token-expired', 2000)).toBeNull();
      expect(findGrant(db, 'room-1', 'token-valid', 2000)).not.toBeNull();
      expect(findGrant(db, 'room-1', 'token-never-expires', 2000)).not.toBeNull();
    });

    it('returns correct count of deleted grants', () => {
      grantAccess(db, {
        roomId: 'room-1',
        token: 'token-1',
        role: 'peer',
        userName: 'Alice',
        expiresAt: 1000,
      });
      grantAccess(db, {
        roomId: 'room-1',
        token: 'token-2',
        role: 'peer',
        userName: 'Bob',
        expiresAt: 1500,
      });

      const result = purgeExpiredGrants(db, 2000);

      expect(result).toBe(2);
    });

    it('uses Date.now() when now is not provided', () => {
      grantAccess(db, {
        roomId: 'room-1',
        token: 'token-old',
        role: 'peer',
        userName: 'Alice',
        expiresAt: 1,
      });

      const result = purgeExpiredGrants(db);

      expect(result).toBe(1);
    });

    it('does not delete grants with null expiresAt', () => {
      grantAccess(db, {
        roomId: 'room-1',
        token: 'token-1',
        role: 'peer',
        userName: 'Alice',
        expiresAt: null,
      });

      const result = purgeExpiredGrants(db, 999999);

      expect(result).toBe(0);
      expect(findGrant(db, 'room-1', 'token-1')).not.toBeNull();
    });
  });
});
