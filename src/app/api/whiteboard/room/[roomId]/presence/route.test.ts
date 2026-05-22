import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as postRoom } from '../route';
import { POST as postWaiting } from '../waiting/route';
import { DELETE, GET, POST } from './route';

function params(roomId: string) {
  return { params: Promise.resolve({ roomId }) };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/whiteboard/room/test/presence', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function deleteRequest(roomId: string, peerId: string) {
  return new NextRequest(
    `http://localhost/api/whiteboard/room/${roomId}/presence?peerId=${peerId}`,
    { method: 'DELETE' }
  );
}

describe('room presence API', () => {
  it('requires a peerId when joining presence', async () => {
    const roomId = `presence-missing-${crypto.randomUUID()}`;
    const response = await POST(postRequest({ userName: 'Alice' }), params(roomId));

    expect(response.status).toBe(400);
    await DELETE(deleteRequest(roomId, 'missing'), params(roomId));
  });

  it('marks room creator as host even if they join presence after others', async () => {
    const roomId = `presence-creator-${crypto.randomUUID()}`;

    await postRoom(
      new NextRequest(`http://localhost/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          hostPeerId: 'peer-creator',
        }),
      }),
      params(roomId),
    );

    await POST(
      postRequest({ peerId: 'peer-joiner', userName: 'Joiner', color: '#e74c3c' }),
      params(roomId),
    );
    await POST(
      postRequest({ peerId: 'peer-creator', userName: 'Creator', color: '#3498db' }),
      params(roomId),
    );

    const response = await GET(
      new NextRequest(`http://localhost/api/whiteboard/room/${roomId}/presence`),
      params(roomId),
    );
    const data = await response.json();

    expect(data.hostPeerId).toBe('peer-creator');
    expect(data.users.find((u: { peerId: string }) => u.peerId === 'peer-creator')?.isHost).toBe(
      true,
    );
    expect(data.waitingPeers).toEqual([
      expect.objectContaining({
        peerId: 'peer-joiner',
        userName: 'Joiner',
        color: '#e74c3c',
        isWaiting: true,
      }),
    ]);

    await DELETE(deleteRequest(roomId, 'peer-creator'), params(roomId));
    await DELETE(deleteRequest(roomId, 'peer-joiner'), params(roomId));
  });

  it('falls back to first-seen host and queues later peers when room has no stored creator', async () => {
    const roomId = `presence-order-${crypto.randomUUID()}`;

    const aliceResponse = await POST(
      postRequest({ peerId: 'peer-alice', userName: 'Alice', color: '#3498db' }),
      params(roomId)
    );
    const bobResponse = await POST(
      postRequest({ peerId: 'peer-bob', userName: 'Bob', color: '#e74c3c' }),
      params(roomId)
    );

    expect(aliceResponse.status).toBe(200);
    expect(bobResponse.status).toBe(200);

    const response = await GET(new NextRequest(`http://localhost/api/whiteboard/room/${roomId}/presence`), params(roomId));
    const data = await response.json();

    expect(data.users).toEqual([
      { peerId: 'peer-alice', userName: 'Alice', color: '#3498db', isHost: true, isWaiting: false },
    ]);
    expect(data.waitingPeers).toEqual([
      expect.objectContaining({
        peerId: 'peer-bob',
        userName: 'Bob',
        color: '#e74c3c',
        isWaiting: true,
      }),
    ]);

    await DELETE(deleteRequest(roomId, 'peer-alice'), params(roomId));
    await DELETE(deleteRequest(roomId, 'peer-bob'), params(roomId));
  });

  it('removes a user when they leave presence', async () => {
    const roomId = `presence-leave-${crypto.randomUUID()}`;

    await POST(postRequest({ peerId: 'peer-alice', userName: 'Alice' }), params(roomId));
    await POST(postRequest({ peerId: 'peer-bob', userName: 'Bob' }), params(roomId));

    const deleteResponse = await DELETE(deleteRequest(roomId, 'peer-bob'), params(roomId));
    const deleteData = await deleteResponse.json();

    expect(deleteResponse.status).toBe(200);
    expect(deleteData.users).toEqual([
      { peerId: 'peer-alice', userName: 'Alice', color: '#3498db', isHost: true, isWaiting: false },
    ]);

    await DELETE(deleteRequest(roomId, 'peer-alice'), params(roomId));
  });

  it('puts non-host peers in waiting even when room capacity remains', async () => {
    const roomId = `presence-waiting-${crypto.randomUUID()}`;

    await postRoom(
      new NextRequest(`http://localhost/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          maxUsers: 3,
          hostPeerId: 'peer-host',
        }),
      }),
      params(roomId),
    );

    const joinResponse = await POST(
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
      params(roomId),
    );
    const joinData = await joinResponse.json();

    expect(joinResponse.status).toBe(200);
    expect(joinData.isWaiting).toBe(true);
    expect(joinData.users.map((user: { peerId: string }) => user.peerId)).not.toContain(
      'peer-student',
    );
    expect(joinData.waitingPeers).toEqual([
      expect.objectContaining({
        peerId: 'peer-student',
        userName: 'Student',
        color: '#e74c3c',
        isWaiting: true,
      }),
    ]);

    const getResponse = await GET(
      new NextRequest(`http://localhost/api/whiteboard/room/${roomId}/presence`),
      params(roomId),
    );
    const getData = await getResponse.json();

    expect(getData.waitingPeers).toEqual([
      expect.objectContaining({ peerId: 'peer-student', isWaiting: true }),
    ]);

    await DELETE(deleteRequest(roomId, 'peer-host'), params(roomId));
    await DELETE(deleteRequest(roomId, 'peer-student'), params(roomId));
  });

  it('keeps an approved peer active on later heartbeat checks', async () => {
    const roomId = `presence-approved-${crypto.randomUUID()}`;

    await postRoom(
      new NextRequest(`http://localhost/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          maxUsers: 3,
          hostPeerId: 'peer-host',
        }),
      }),
      params(roomId),
    );

    await POST(
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
      params(roomId),
    );

    await postWaiting(
      new NextRequest(`http://localhost/api/whiteboard/room/${roomId}/waiting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-student', action: 'approve' }),
      }),
      params(roomId),
    );

    const heartbeatResponse = await POST(
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
      params(roomId),
    );
    const heartbeatData = await heartbeatResponse.json();

    expect(heartbeatData.isWaiting).toBe(false);
    expect(heartbeatData.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: 'peer-student', isWaiting: false }),
      ]),
    );
    expect(heartbeatData.waitingPeers).toEqual([]);

    await DELETE(deleteRequest(roomId, 'peer-host'), params(roomId));
    await DELETE(deleteRequest(roomId, 'peer-student'), params(roomId));
  });

  it('marks a kicked peer as kicked instead of moving them back to waiting', async () => {
    const roomId = `presence-kicked-${crypto.randomUUID()}`;

    await postRoom(
      new NextRequest(`http://localhost/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          maxUsers: 3,
          hostPeerId: 'peer-host',
        }),
      }),
      params(roomId),
    );

    await POST(
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
      params(roomId),
    );
    await postWaiting(
      new NextRequest(`http://localhost/api/whiteboard/room/${roomId}/waiting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-student', action: 'approve' }),
      }),
      params(roomId),
    );

    await POST(
      postRequest({ action: 'kick', peerId: 'peer-student' }),
      params(roomId),
    );

    const heartbeatResponse = await POST(
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
      params(roomId),
    );
    const heartbeatData = await heartbeatResponse.json();

    expect(heartbeatData.isKicked).toBe(true);
    expect(heartbeatData.isWaiting).toBe(false);
    expect(heartbeatData.waitingPeers).toEqual([]);

    const rejoinResponse = await POST(
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
      params(roomId),
    );
    const rejoinData = await rejoinResponse.json();

    expect(rejoinData.isWaiting).toBe(true);
    expect(rejoinData.waitingPeers).toEqual([
      expect.objectContaining({ peerId: 'peer-student', isWaiting: true }),
    ]);

    await DELETE(deleteRequest(roomId, 'peer-host'), params(roomId));
    await DELETE(deleteRequest(roomId, 'peer-student'), params(roomId));
  });

  it('marks a rejected waiting peer as kicked on their next heartbeat', async () => {
    const roomId = `presence-rejected-${crypto.randomUUID()}`;

    await postRoom(
      new NextRequest(`http://localhost/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          maxUsers: 3,
          hostPeerId: 'peer-host',
        }),
      }),
      params(roomId),
    );

    await POST(
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
      params(roomId),
    );
    await postWaiting(
      new NextRequest(`http://localhost/api/whiteboard/room/${roomId}/waiting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-student', action: 'reject' }),
      }),
      params(roomId),
    );

    const heartbeatResponse = await POST(
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
      params(roomId),
    );
    const heartbeatData = await heartbeatResponse.json();

    expect(heartbeatData.isKicked).toBe(true);
    expect(heartbeatData.isWaiting).toBe(false);
    expect(heartbeatData.waitingPeers).toEqual([]);

    await DELETE(deleteRequest(roomId, 'peer-host'), params(roomId));
    await DELETE(deleteRequest(roomId, 'peer-student'), params(roomId));
  });

  it('moves a suspended approved peer back to waiting on heartbeat', async () => {
    const roomId = `presence-suspended-${crypto.randomUUID()}`;

    await postRoom(
      new NextRequest(`http://localhost/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          maxUsers: 3,
          hostPeerId: 'peer-host',
        }),
      }),
      params(roomId),
    );

    await POST(
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
      params(roomId),
    );
    await postWaiting(
      new NextRequest(`http://localhost/api/whiteboard/room/${roomId}/waiting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-student', action: 'approve' }),
      }),
      params(roomId),
    );
    await POST(
      postRequest({ action: 'suspend', peerId: 'peer-student' }),
      params(roomId),
    );

    const heartbeatResponse = await POST(
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
      params(roomId),
    );
    const heartbeatData = await heartbeatResponse.json();

    expect(heartbeatData.isWaiting).toBe(true);
    expect(heartbeatData.waitingPeers).toEqual([
      expect.objectContaining({ peerId: 'peer-student', isWaiting: true }),
    ]);

    await DELETE(deleteRequest(roomId, 'peer-host'), params(roomId));
    await DELETE(deleteRequest(roomId, 'peer-student'), params(roomId));
  });
});
