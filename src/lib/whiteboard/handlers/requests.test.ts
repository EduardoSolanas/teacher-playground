import { describe, expect, it } from 'vitest';
import { handleRequestsPost, handleRequestsGet } from './requests';
import { handleRequestsIdPost } from './requestsId';
import { handleRoomPost } from './room';
import { handleAccessGet } from './access';
import { getRoomDb } from '../roomDb';
import { banAccount, getMembership } from '../membership';

function roomUrl(roomId: string, path: string, accountId?: string) {
  const url = new URL(`http://localhost/api/whiteboard/room/${roomId}${path}`);
  if (accountId) url.searchParams.set('accountId', accountId);
  return url.toString();
}

describe('access request API', () => {
  describe('POST /requests - create request', () => {
    it('returns 400 for malformed JSON body', async () => {
      const roomId = `requests-malformed-${crypto.randomUUID()}`;
      const response = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', 'acc-1'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{invalid json',
        }),
      );
      expect(response.status).toBe(400);
    });

    it('returns 401 if no verified account is present, even with a bearer token', async () => {
      const roomId = `requests-no-token-${crypto.randomUUID()}`;
      const response = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          },
          body: JSON.stringify({ userName: 'Alice' }),
        }),
      );
      expect(response.status).toBe(401);
    });

    it('returns 400 if userName is missing', async () => {
      const roomId = `requests-missing-name-${crypto.randomUUID()}`;
      const response = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', 'acc-1'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      );
      expect(response.status).toBe(400);
    });

    it('creates a pending access request keyed by account id', async () => {
      const roomId = `requests-create-${crypto.randomUUID()}`;
      const accountId = `acc-${crypto.randomUUID()}`;
      const response = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', accountId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userName: 'Alice', email: 'alice@example.com' }),
        }),
      );

      expect(response.status).toBe(201);
      const data = await response.json() as { status: string; requestId: string };
      expect(data.status).toBe('pending');
      expect(data.requestId).toBe(accountId);
      expect(getMembership(getRoomDb(), roomId, accountId)?.role).toBe('pending');
    });

    it('returns approved status if the account already owns the room', async () => {
      const roomId = `requests-already-approved-${crypto.randomUUID()}`;
      const accountId = `acc-${crypto.randomUUID()}`;

      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '', accountId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            elements: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          }),
        }),
      );

      const response = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', accountId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userName: 'Creator' }),
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json() as { status: string; role: string };
      expect(data.status).toBe('approved');
      expect(data.role).toBe('creator');
    });

    it('returns the same requestId if the account already has a pending request', async () => {
      const roomId = `requests-duplicate-${crypto.randomUUID()}`;
      const accountId = `acc-${crypto.randomUUID()}`;

      const response1 = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', accountId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userName: 'Bob' }),
        }),
      );
      const data1 = await response1.json() as { requestId: string };

      const response2 = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', accountId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userName: 'Bob' }),
        }),
      );
      const data2 = await response2.json() as { requestId: string };
      expect(data2.requestId).toBe(data1.requestId);
      expect(data2.requestId).toBe(accountId);
    });

    it('does not create a pending row from a matching owner email', async () => {
      const roomId = `requests-email-not-key-${crypto.randomUUID()}`;
      const owner = `acc-owner-${crypto.randomUUID()}`;
      const requester = `acc-req-${crypto.randomUUID()}`;

      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '', owner), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elements: [], viewport: { x: 0, y: 0, zoom: 1 } }),
        }),
      );

      const response = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', requester), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userName: 'Eve', email: 'owner@example.com' }),
        }),
      );
      expect(response.status).toBe(201);
      expect(getMembership(getRoomDb(), roomId, requester)?.role).toBe('pending');
      expect(getMembership(getRoomDb(), roomId, owner)?.role).toBe('owner');
    });

    it('does not create a pending row for a banned account', async () => {
      const roomId = `requests-banned-${crypto.randomUUID()}`;
      const accountId = `acc-${crypto.randomUUID()}`;
      banAccount(getRoomDb(), roomId, accountId);

      const response = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', accountId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userName: 'Eve' }),
        }),
      );
      expect(response.status).toBe(403);
      expect(getMembership(getRoomDb(), roomId, accountId)?.role).toBe('banned');
    });
  });

  describe('GET /requests - list requests', () => {
    it('returns 401 if no verified account is present', async () => {
      const roomId = `requests-list-no-token-${crypto.randomUUID()}`;
      const response = await handleRequestsGet(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests')),
      );
      expect(response.status).toBe(401);
    });

    it('lists pending requests from room_members', async () => {
      const roomId = `requests-list-creator-${crypto.randomUUID()}`;
      const owner = `acc-owner-${crypto.randomUUID()}`;
      const requester = `acc-req-${crypto.randomUUID()}`;

      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '', owner), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elements: [], viewport: { x: 0, y: 0, zoom: 1 } }),
        }),
      );

      await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', requester), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userName: 'Alice', email: 'alice@example.com' }),
        }),
      );

      const response = await handleRequestsGet(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', owner)),
      );

      expect(response.status).toBe(200);
      const data = await response.json() as { requests: Array<{ userName: string; email: string; requestId: string }> };
      expect(data.requests).toHaveLength(1);
      expect(data.requests[0].userName).toBe('Alice');
      expect(data.requests[0].email).toBe('alice@example.com');
      expect(data.requests[0].requestId).toBe(requester);
    });

    it('refuses to list request PII for a non-owner', async () => {
      const roomId = `requests-list-non-owner-${crypto.randomUUID()}`;
      const owner = `acc-owner-${crypto.randomUUID()}`;
      const requester = `acc-req-${crypto.randomUUID()}`;

      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '', owner), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elements: [], viewport: { x: 0, y: 0, zoom: 1 } }),
        }),
      );
      await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', requester), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userName: 'Alice', email: 'alice@example.com' }),
        }),
      );

      const response = await handleRequestsGet(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', requester)),
      );
      expect(response.status).toBe(403);
    });
  });

  describe('POST /requests/[requestId] - approve/deny request', () => {
    it('returns 400 for invalid action', async () => {
      const roomId = `requests-action-invalid-${crypto.randomUUID()}`;
      const owner = `acc-${crypto.randomUUID()}`;
      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '', owner), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elements: [], viewport: { x: 0, y: 0, zoom: 1 } }),
        }),
      );

      const response = await handleRequestsIdPost(
        getRoomDb(),
        roomId,
        'missing',
        new Request(roomUrl(roomId, '/requests/missing', owner), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'invalid' }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it('returns 404 if request does not exist and leaves tables unchanged', async () => {
      const roomId = `requests-action-not-found-${crypto.randomUUID()}`;
      const owner = `acc-${crypto.randomUUID()}`;
      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '', owner), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elements: [], viewport: { x: 0, y: 0, zoom: 1 } }),
        }),
      );

      const before = getRoomDb().prepare(`SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?`).get(roomId) as { n: number };
      const response = await handleRequestsIdPost(
        getRoomDb(),
        roomId,
        'no-such-account',
        new Request(roomUrl(roomId, '/requests/no-such-account', owner), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'approve' }),
        }),
      );
      expect(response.status).toBe(404);
      const after = getRoomDb().prepare(`SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?`).get(roomId) as { n: number };
      expect(after.n).toBe(before.n);
    });

    it('approves the path account as peer, ignoring a bearer token', async () => {
      const roomId = `requests-approve-peer-${crypto.randomUUID()}`;
      const owner = `acc-owner-${crypto.randomUUID()}`;
      const requester = `acc-req-${crypto.randomUUID()}`;

      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '', owner), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elements: [], viewport: { x: 0, y: 0, zoom: 1 } }),
        }),
      );

      await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', requester), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userName: 'Alice' }),
        }),
      );

      const approveResponse = await handleRequestsIdPost(
        getRoomDb(),
        roomId,
        requester,
        new Request(roomUrl(roomId, `/requests/${requester}`, owner), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer forged-token',
          },
          body: JSON.stringify({ action: 'approve', accountId: owner }),
        }),
      );

      expect(approveResponse.status).toBe(200);
      const approveData = await approveResponse.json() as { success: boolean; role: string; expiresAt: number };
      expect(approveData.success).toBe(true);
      expect(approveData.role).toBe('peer');
      expect(typeof approveData.expiresAt).toBe('number');
      expect(getMembership(getRoomDb(), roomId, requester)?.role).toBe('editor');
      expect(getMembership(getRoomDb(), roomId, owner)?.role).toBe('owner');

      const accessResponse = await handleAccessGet(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/access', requester), {
          headers: { Authorization: 'Bearer forged-token' },
        }),
      );
      const accessData = await accessResponse.json() as { status: string; role: string };
      expect(accessData.status).toBe('approved');
      expect(accessData.role).toBe('peer');
    });

    it('approves a request with viewer role (no expiry)', async () => {
      const roomId = `requests-approve-viewer-${crypto.randomUUID()}`;
      const owner = `acc-owner-${crypto.randomUUID()}`;
      const requester = `acc-req-${crypto.randomUUID()}`;

      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '', owner), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elements: [], viewport: { x: 0, y: 0, zoom: 1 } }),
        }),
      );
      await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', requester), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userName: 'Bob' }),
        }),
      );

      const approveResponse = await handleRequestsIdPost(
        getRoomDb(),
        roomId,
        requester,
        new Request(roomUrl(roomId, `/requests/${requester}`, owner), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'approve', role: 'viewer' }),
        }),
      );
      const approveData = await approveResponse.json() as { role: string; expiresAt: number | null };
      expect(approveData.role).toBe('viewer');
      expect(approveData.expiresAt).toBeNull();
      expect(getMembership(getRoomDb(), roomId, requester)?.role).toBe('viewer');
    });

    it('denies a request by banning the account', async () => {
      const roomId = `requests-deny-${crypto.randomUUID()}`;
      const owner = `acc-owner-${crypto.randomUUID()}`;
      const requester = `acc-req-${crypto.randomUUID()}`;

      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '', owner), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elements: [], viewport: { x: 0, y: 0, zoom: 1 } }),
        }),
      );
      await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', requester), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userName: 'Charlie' }),
        }),
      );

      const denyResponse = await handleRequestsIdPost(
        getRoomDb(),
        roomId,
        requester,
        new Request(roomUrl(roomId, `/requests/${requester}`, owner), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'deny' }),
        }),
      );
      expect(denyResponse.status).toBe(200);
      expect(getMembership(getRoomDb(), roomId, requester)?.role).toBe('banned');

      const accessResponse = await handleAccessGet(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/access', requester)),
      );
      const accessData = await accessResponse.json() as { status: string };
      expect(accessData.status).toBe('rejected');
    });
  });

  describe('GET /access - check own access status', () => {
    it('returns 401 if no verified account is present', async () => {
      const roomId = `access-no-token-${crypto.randomUUID()}`;
      const response = await handleAccessGet(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/access'), {
          headers: { Authorization: 'Bearer anything' },
        }),
      );
      expect(response.status).toBe(401);
    });

    it('returns approved status with role for the room owner', async () => {
      const roomId = `access-approved-${crypto.randomUUID()}`;
      const accountId = `acc-${crypto.randomUUID()}`;

      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '', accountId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elements: [], viewport: { x: 0, y: 0, zoom: 1 } }),
        }),
      );

      const response = await handleAccessGet(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/access', accountId)),
      );
      const data = await response.json() as { status: string; role: string };
      expect(data.status).toBe('approved');
      expect(data.role).toBe('creator');
    });

    it('returns pending status for a pending request', async () => {
      const roomId = `access-pending-${crypto.randomUUID()}`;
      const accountId = `acc-${crypto.randomUUID()}`;
      await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/requests', accountId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userName: 'Dave' }),
        }),
      );
      const response = await handleAccessGet(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/access', accountId)),
      );
      expect(await response.json()).toEqual({ status: 'pending' });
    });

    it('returns none status when no grant or request', async () => {
      const roomId = `access-none-${crypto.randomUUID()}`;
      const response = await handleAccessGet(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '/access', 'acc-none')),
      );
      expect(await response.json()).toEqual({ status: 'none' });
    });
  });

  describe('creating room membership', () => {
    it('creates an owner grant from the verified account, not a bearer token', async () => {
      const roomId = `room-creator-grant-${crypto.randomUUID()}`;
      const accountId = `acc-${crypto.randomUUID()}`;

      const response = await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, '', accountId), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ignored-token',
          },
          body: JSON.stringify({
            elements: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          }),
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json() as { hasCreatorGrant: boolean };
      expect(data.hasCreatorGrant).toBe(true);
      expect(getMembership(getRoomDb(), roomId, accountId)?.role).toBe('owner');
    });

    it('creates a room without an account and no grant', async () => {
      const roomId = `room-no-token-${crypto.randomUUID()}`;
      const response = await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(roomUrl(roomId, ''), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer still-not-authorization',
          },
          body: JSON.stringify({
            elements: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          }),
        }),
      );
      expect(response.status).toBe(200);
      const data = await response.json() as { hasCreatorGrant: boolean };
      expect(data.hasCreatorGrant).toBe(false);
    });
  });
});
