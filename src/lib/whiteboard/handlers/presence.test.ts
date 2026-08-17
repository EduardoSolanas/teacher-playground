import { describe, expect, it } from 'vitest';
import { handlePresencePost, handlePresenceGet, handlePresenceDelete } from './presence';
import { handleRoomPost } from './room';
import { handleWaitingPost } from './waiting';
import { getRoomDb } from '../roomDb';

function postRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/whiteboard/room/test/presence', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function deleteRequest(roomId: string, peerId: string) {
  return new Request(
    `http://localhost/api/whiteboard/room/${roomId}/presence?peerId=${peerId}`,
    { method: 'DELETE' }
  );
}

describe('room presence API', () => {
  it('returns 400 for malformed JSON body', async () => {
    const roomId = `presence-malformed-${crypto.randomUUID()}`;
    const response = await handlePresencePost(
      getRoomDb(),
      roomId,
      new Request('http://localhost/api/whiteboard/room/test/presence', {
        method: 'POST',
        body: '{invalid json',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBeDefined();
  });

  it('requires a peerId when joining presence', async () => {
    const roomId = `presence-missing-${crypto.randomUUID()}`;
    const response = await handlePresencePost(getRoomDb(), roomId, postRequest({ userName: 'Alice' }));

    expect(response.status).toBe(400);
    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'missing'));
  });

  it('defaults to Anonymous userName when not provided', async () => {
    const roomId = `presence-default-name-${crypto.randomUUID()}`;

    const response = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-alice' }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.users).toEqual([
      expect.objectContaining({
        peerId: 'peer-alice',
        userName: 'Anonymous',
        isHost: true,
        isWaiting: false,
      }),
    ]);

    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-alice'));
  });

  it('marks room creator as host even if they join presence after others', async () => {
    const roomId = `presence-creator-${crypto.randomUUID()}`;

    await handleRoomPost(
      getRoomDb(),
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          hostPeerId: 'peer-creator',
        }),
      }),
    );

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-joiner', userName: 'Joiner', color: '#e74c3c' }),
    );
    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-creator', userName: 'Creator', color: '#3498db' }),
    );

    const response = await handlePresenceGet(
      getRoomDb(),
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}/presence`),
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

    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-creator'));
    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-joiner'));
  });

  it('falls back to first-seen host and queues later peers when room has no stored creator', async () => {
    const roomId = `presence-order-${crypto.randomUUID()}`;

    const aliceResponse = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-alice', userName: 'Alice', color: '#3498db' }),
    );
    const bobResponse = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-bob', userName: 'Bob', color: '#e74c3c' }),
    );

    expect(aliceResponse.status).toBe(200);
    expect(bobResponse.status).toBe(200);

    const response = await handlePresenceGet(
      getRoomDb(),
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}/presence`),
    );
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

    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-alice'));
    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-bob'));
  });

  it('removes a user when they leave presence', async () => {
    const roomId = `presence-leave-${crypto.randomUUID()}`;

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-alice', userName: 'Alice' }),
    );
    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-bob', userName: 'Bob' }),
    );

    const deleteResponse = await handlePresenceDelete(
      getRoomDb(),
      roomId,
      deleteRequest(roomId, 'peer-bob'),
    );
    const deleteData = await deleteResponse.json();

    expect(deleteResponse.status).toBe(200);
    expect(deleteData.users).toEqual([
      { peerId: 'peer-alice', userName: 'Alice', color: '#3498db', isHost: true, isWaiting: false },
    ]);

    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-alice'));
  });

  it('puts non-host peers in waiting even when room capacity remains', async () => {
    const roomId = `presence-waiting-${crypto.randomUUID()}`;

    await handleRoomPost(
      getRoomDb(),
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          maxUsers: 3,
          hostPeerId: 'peer-host',
        }),
      }),
    );

    const joinResponse = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
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

    const getResponse = await handlePresenceGet(
      getRoomDb(),
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}/presence`),
    );
    const getData = await getResponse.json();

    expect(getData.waitingPeers).toEqual([
      expect.objectContaining({ peerId: 'peer-student', isWaiting: true }),
    ]);

    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-host'));
    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-student'));
  });

  it('keeps an approved peer active on later heartbeat checks', async () => {
    const roomId = `presence-approved-${crypto.randomUUID()}`;

    await handleRoomPost(
      getRoomDb(),
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          maxUsers: 3,
          hostPeerId: 'peer-host',
        }),
      }),
    );

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );

    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}/waiting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-student', action: 'approve' }),
      }),
    );

    const heartbeatResponse = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );
    const heartbeatData = await heartbeatResponse.json();

    expect(heartbeatData.isWaiting).toBe(false);
    expect(heartbeatData.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: 'peer-student', isWaiting: false }),
      ]),
    );
    expect(heartbeatData.waitingPeers).toEqual([]);

    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-host'));
    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-student'));
  });

  it('marks a kicked peer as kicked instead of moving them back to waiting', async () => {
    const roomId = `presence-kicked-${crypto.randomUUID()}`;

    await handleRoomPost(
      getRoomDb(),
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          maxUsers: 3,
          hostPeerId: 'peer-host',
        }),
      }),
    );

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );
    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}/waiting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-student', action: 'approve' }),
      }),
    );

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ action: 'kick', peerId: 'peer-student' }),
    );

    const heartbeatResponse = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );
    const heartbeatData = await heartbeatResponse.json();

    expect(heartbeatData.isKicked).toBe(true);
    expect(heartbeatData.isWaiting).toBe(false);
    expect(heartbeatData.waitingPeers).toEqual([]);

    const rejoinResponse = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );
    const rejoinData = await rejoinResponse.json();

    expect(rejoinData.isWaiting).toBe(true);
    expect(rejoinData.waitingPeers).toEqual([
      expect.objectContaining({ peerId: 'peer-student', isWaiting: true }),
    ]);

    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-host'));
    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-student'));
  });

  it('marks a rejected waiting peer as kicked on their next heartbeat', async () => {
    const roomId = `presence-rejected-${crypto.randomUUID()}`;

    await handleRoomPost(
      getRoomDb(),
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          maxUsers: 3,
          hostPeerId: 'peer-host',
        }),
      }),
    );

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );
    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}/waiting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-student', action: 'reject' }),
      }),
    );

    const heartbeatResponse = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );
    const heartbeatData = await heartbeatResponse.json();

    expect(heartbeatData.isKicked).toBe(true);
    expect(heartbeatData.isWaiting).toBe(false);
    expect(heartbeatData.waitingPeers).toEqual([]);

    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-host'));
    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-student'));
  });

  it('moves a suspended approved peer back to waiting on heartbeat', async () => {
    const roomId = `presence-suspended-${crypto.randomUUID()}`;

    await handleRoomPost(
      getRoomDb(),
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          maxUsers: 3,
          hostPeerId: 'peer-host',
        }),
      }),
    );

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );
    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}/waiting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-student', action: 'approve' }),
      }),
    );
    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ action: 'suspend', peerId: 'peer-student' }),
    );

    const heartbeatResponse = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );
    const heartbeatData = await heartbeatResponse.json();

    expect(heartbeatData.isWaiting).toBe(true);
    expect(heartbeatData.waitingPeers).toEqual([
      expect.objectContaining({ peerId: 'peer-student', isWaiting: true }),
    ]);

    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-host'));
    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, 'peer-student'));
  });
});
