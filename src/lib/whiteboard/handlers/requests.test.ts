import { describe, expect, it } from 'vitest';
import { handleRequestsPost, handleRequestsGet } from './requests';
import { handleRequestsIdPost } from './requestsId';
import { handleRoomPost } from './room';
import { handleAccessGet } from './access';
import { getRoomDb } from '../roomDb';

function requestParams(roomId: string, requestId: string) {
  return { roomId, requestId };
}

describe('access request API', () => {
  describe('POST /requests - create request', () => {
    it('returns 400 for malformed JSON body', async () => {
      const roomId = `requests-malformed-${crypto.randomUUID()}`;
      const response = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-token',
          },
          body: '{invalid json',
        }),
      );
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it('returns 401 if no bearer token', async () => {
      const roomId = `requests-no-token-${crypto.randomUUID()}`;
      const response = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-token',
          },
          body: JSON.stringify({}),
        }),
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 if userName is empty', async () => {
      const roomId = `requests-empty-name-${crypto.randomUUID()}`;
      const response = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-token',
          },
          body: JSON.stringify({ userName: '' }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it('creates a pending access request', async () => {
      const roomId = `requests-create-${crypto.randomUUID()}`;
      const token = `token-create-${crypto.randomUUID()}`;
      const response = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ userName: 'Alice', email: 'alice@example.com' }),
        }),
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe('pending');
      expect(data.requestId).toBeDefined();
      expect(data.requestId).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    });

    it('returns approved status if token already has a valid grant', async () => {
      const roomId = `requests-already-approved-${crypto.randomUUID()}`;
      const token = `token-approved-${crypto.randomUUID()}`;

      // First, create a room with this token to get a creator grant
      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            elements: [],
            viewport: { x: 0, y: 0, zoom: 1 },
            name: 'Test Room',
          }),
        }),
      );

      // Now request access with the same token
      const response = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ userName: 'Creator' }),
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('approved');
      expect(data.role).toBe('creator');
    });

    it('returns existing requestId if token already has a pending request', async () => {
      const roomId = `requests-duplicate-${crypto.randomUUID()}`;
      const token = `token-duplicate-${crypto.randomUUID()}`;

      const response1 = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ userName: 'Bob' }),
        }),
      );

      const data1 = await response1.json();
      const requestId1 = data1.requestId;

      const response2 = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ userName: 'Bob' }),
        }),
      );

      const data2 = await response2.json();
      expect(data2.requestId).toBe(requestId1);
      expect(response2.status).toBe(201);
    });
  });

  describe('GET /requests - list requests', () => {
    it('returns 403 if not a creator', async () => {
      const roomId = `requests-list-401-${crypto.randomUUID()}`;
      const token = `token-not-creator-${crypto.randomUUID()}`;

      const response = await handleRequestsGet(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`, {
          headers: { 'Authorization': `Bearer ${token}` },
        }),
      );

      expect(response.status).toBe(403);
    });

    it('returns 401 if no bearer token', async () => {
      const roomId = `requests-list-no-token-${crypto.randomUUID()}`;

      const response = await handleRequestsGet(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`),
      );

      expect(response.status).toBe(401);
    });

    it('lists pending requests for creator', async () => {
      const roomId = `requests-list-creator-${crypto.randomUUID()}`;
      const creatorToken = `token-creator-${crypto.randomUUID()}`;
      const requesterToken = `token-requester-${crypto.randomUUID()}`;

      // Create room with creator token
      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({
            elements: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          }),
        }),
      );

      // Create a request with a different token
      await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${requesterToken}`,
          },
          body: JSON.stringify({ userName: 'Alice', email: 'alice@example.com' }),
        }),
      );

      // Get requests as creator
      const response = await handleRequestsGet(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`, {
          headers: { 'Authorization': `Bearer ${creatorToken}` },
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.requests).toHaveLength(1);
      expect(data.requests[0].userName).toBe('Alice');
      expect(data.requests[0].email).toBe('alice@example.com');
    });
  });

  describe('POST /requests/[requestId] - approve/deny request', () => {
    it('returns 403 if not a creator', async () => {
      const roomId = `requests-action-not-creator-${crypto.randomUUID()}`;
      const token = `token-not-creator-${crypto.randomUUID()}`;
      const fakeRequestId = crypto.randomUUID();

      const response = await handleRequestsIdPost(
        getRoomDb(),
        roomId,
        fakeRequestId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests/${fakeRequestId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ action: 'approve' }),
        }),
      );

      expect(response.status).toBe(403);
    });

    it('returns 400 for invalid action', async () => {
      const roomId = `requests-action-invalid-${crypto.randomUUID()}`;
      const creatorToken = `token-creator-invalid-${crypto.randomUUID()}`;
      const requestId = crypto.randomUUID();

      // Create room with creator token
      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({
            elements: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          }),
        }),
      );

      const response = await handleRequestsIdPost(
        getRoomDb(),
        roomId,
        requestId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests/${requestId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ action: 'invalid' }),
        }),
      );

      expect(response.status).toBe(400);
    });

    it('returns 404 if request does not exist', async () => {
      const roomId = `requests-action-not-found-${crypto.randomUUID()}`;
      const creatorToken = `token-creator-not-found-${crypto.randomUUID()}`;
      const fakeRequestId = crypto.randomUUID();

      // Create room with creator token
      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({
            elements: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          }),
        }),
      );

      const response = await handleRequestsIdPost(
        getRoomDb(),
        roomId,
        fakeRequestId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests/${fakeRequestId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ action: 'approve' }),
        }),
      );

      expect(response.status).toBe(404);
    });

    it('approves a request with default role peer', async () => {
      const roomId = `requests-approve-peer-${crypto.randomUUID()}`;
      const creatorToken = `token-creator-approve-${crypto.randomUUID()}`;
      const requesterToken = `token-requester-approve-${crypto.randomUUID()}`;

      // Create room with creator token
      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({
            elements: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          }),
        }),
      );

      // Create a request
      const requestResponse = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${requesterToken}`,
          },
          body: JSON.stringify({ userName: 'Alice' }),
        }),
      );

      const requestData = await requestResponse.json();
      const requestId = requestData.requestId;

      // Approve the request
      const approveResponse = await handleRequestsIdPost(
        getRoomDb(),
        roomId,
        requestId,
        new Request(
          `http://localhost/api/whiteboard/room/${roomId}/requests/${requestId}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${creatorToken}`,
            },
            body: JSON.stringify({ action: 'approve' }),
          },
        ),
      );

      expect(approveResponse.status).toBe(200);
      const approveData = await approveResponse.json();
      expect(approveData.success).toBe(true);
      expect(approveData.role).toBe('peer');
      expect(approveData.expiresAt).toBeDefined();
      expect(typeof approveData.expiresAt).toBe('number');

      // Verify the requester can now access with their token
      const accessResponse = await handleAccessGet(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/access`, {
          headers: { 'Authorization': `Bearer ${requesterToken}` },
        }),
      );

      expect(accessResponse.status).toBe(200);
      const accessData = await accessResponse.json();
      expect(accessData.status).toBe('approved');
      expect(accessData.role).toBe('peer');
      expect(accessData.expiresAt).toBeDefined();
    });

    it('approves a request with viewer role (no expiry)', async () => {
      const roomId = `requests-approve-viewer-${crypto.randomUUID()}`;
      const creatorToken = `token-creator-viewer-${crypto.randomUUID()}`;
      const requesterToken = `token-requester-viewer-${crypto.randomUUID()}`;

      // Create room with creator token
      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({
            elements: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          }),
        }),
      );

      // Create a request
      const requestResponse = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${requesterToken}`,
          },
          body: JSON.stringify({ userName: 'Bob' }),
        }),
      );

      const requestData = await requestResponse.json();
      const requestId = requestData.requestId;

      // Approve with viewer role
      const approveResponse = await handleRequestsIdPost(
        getRoomDb(),
        roomId,
        requestId,
        new Request(
          `http://localhost/api/whiteboard/room/${roomId}/requests/${requestId}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${creatorToken}`,
            },
            body: JSON.stringify({ action: 'approve', role: 'viewer' }),
          },
        ),
      );

      expect(approveResponse.status).toBe(200);
      const approveData = await approveResponse.json();
      expect(approveData.role).toBe('viewer');
      expect(approveData.expiresAt).toBeNull();
    });

    it('denies a request', async () => {
      const roomId = `requests-deny-${crypto.randomUUID()}`;
      const creatorToken = `token-creator-deny-${crypto.randomUUID()}`;
      const requesterToken = `token-requester-deny-${crypto.randomUUID()}`;

      // Create room with creator token
      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({
            elements: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          }),
        }),
      );

      // Create a request
      const requestResponse = await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${requesterToken}`,
          },
          body: JSON.stringify({ userName: 'Charlie' }),
        }),
      );

      const requestData = await requestResponse.json();
      const requestId = requestData.requestId;

      // Deny the request
      const denyResponse = await handleRequestsIdPost(
        getRoomDb(),
        roomId,
        requestId,
        new Request(
          `http://localhost/api/whiteboard/room/${roomId}/requests/${requestId}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${creatorToken}`,
            },
            body: JSON.stringify({ action: 'deny' }),
          },
        ),
      );

      expect(denyResponse.status).toBe(200);
      const denyData = await denyResponse.json();
      expect(denyData.success).toBe(true);

      // Verify the requester has no access
      const accessResponse = await handleAccessGet(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/access`, {
          headers: { 'Authorization': `Bearer ${requesterToken}` },
        }),
      );

      expect(accessResponse.status).toBe(200);
      const accessData = await accessResponse.json();
      expect(accessData.status).toBe('none');
    });
  });

  describe('GET /access - check own access status', () => {
    it('returns 401 if no bearer token', async () => {
      const roomId = `access-no-token-${crypto.randomUUID()}`;

      const response = await handleAccessGet(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/access`),
      );

      expect(response.status).toBe(401);
    });

    it('returns approved status with role for valid grant', async () => {
      const roomId = `access-approved-${crypto.randomUUID()}`;
      const token = `token-access-approved-${crypto.randomUUID()}`;

      // Create room with creator token
      await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            elements: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          }),
        }),
      );

      // Check access
      const response = await handleAccessGet(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/access`, {
          headers: { 'Authorization': `Bearer ${token}` },
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('approved');
      expect(data.role).toBe('creator');
      expect(data.expiresAt).toBeNull();
    });

    it('returns pending status for a pending request', async () => {
      const roomId = `access-pending-${crypto.randomUUID()}`;
      const requesterToken = `token-access-pending-${crypto.randomUUID()}`;

      // Create a request
      await handleRequestsPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${requesterToken}`,
          },
          body: JSON.stringify({ userName: 'Dave' }),
        }),
      );

      // Check access
      const response = await handleAccessGet(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/access`, {
          headers: { 'Authorization': `Bearer ${requesterToken}` },
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('pending');
    });

    it('returns none status when no grant or request', async () => {
      const roomId = `access-none-${crypto.randomUUID()}`;
      const token = `token-access-none-${crypto.randomUUID()}`;

      const response = await handleAccessGet(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/access`, {
          headers: { 'Authorization': `Bearer ${token}` },
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('none');
    });
  });

  describe('creating room with bearer token', () => {
    it('creates a room with bearer token and adds creator grant', async () => {
      const roomId = `room-creator-grant-${crypto.randomUUID()}`;
      const token = `token-room-creator-${crypto.randomUUID()}`;

      const response = await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            elements: [],
            viewport: { x: 0, y: 0, zoom: 1 },
            name: 'My Room',
          }),
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.hasCreatorGrant).toBe(true);

      // Verify the grant was created
      const accessResponse = await handleAccessGet(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}/access`, {
          headers: { 'Authorization': `Bearer ${token}` },
        }),
      );

      expect(accessResponse.status).toBe(200);
      const accessData = await accessResponse.json();
      expect(accessData.status).toBe('approved');
      expect(accessData.role).toBe('creator');
    });

    it('creates a room without bearer token and no grant', async () => {
      const roomId = `room-no-token-${crypto.randomUUID()}`;

      const response = await handleRoomPost(
        getRoomDb(),
        roomId,
        new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            elements: [],
            viewport: { x: 0, y: 0, zoom: 1 },
            name: 'Public Room',
          }),
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.hasCreatorGrant).toBe(false);
    });
  });
});
