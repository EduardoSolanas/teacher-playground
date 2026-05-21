import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as postRoom } from '../route';
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
    expect(data.users.find((u: { peerId: string }) => u.peerId === 'peer-joiner')?.isHost).toBe(
      false,
    );

    await DELETE(deleteRequest(roomId, 'peer-creator'), params(roomId));
    await DELETE(deleteRequest(roomId, 'peer-joiner'), params(roomId));
  });

  it('falls back to first-seen host when room has no stored creator', async () => {
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
      { peerId: 'peer-alice', userName: 'Alice', color: '#3498db', isHost: true },
      { peerId: 'peer-bob', userName: 'Bob', color: '#e74c3c', isHost: false },
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
      { peerId: 'peer-alice', userName: 'Alice', color: '#3498db', isHost: true },
    ]);

    await DELETE(deleteRequest(roomId, 'peer-alice'), params(roomId));
  });
});
