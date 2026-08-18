import { describe, expect, it } from 'vitest';
import { handlePresencePost, handlePresenceGet, handlePresenceDelete } from './presence';
import { handleRoomPost, handleRoomSettings } from './room';
import { handleWaitingPost } from './waiting';
import { getRoomDb } from '../roomDb';
import { approveAccount, requestAccess } from '../membership';

function accountUrl(roomId: string, path: string, accountId: string) {
  return `http://localhost/api/whiteboard/room/${roomId}${path}?accountId=${encodeURIComponent(accountId)}`;
}

function postRequest(roomId: string, accountId: string, body: Record<string, unknown>) {
  return new Request(accountUrl(roomId, '/presence', accountId), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function getRequest(roomId: string, accountId: string) {
  return new Request(accountUrl(roomId, '/presence', accountId));
}

function deleteRequest(roomId: string, accountId: string, peerId: string) {
  return new Request(
    `${accountUrl(roomId, '/presence', accountId)}&peerId=${encodeURIComponent(peerId)}`,
    { method: 'DELETE' },
  );
}

async function createOwnedRoom(roomId: string, owner: string) {
  await handleRoomPost(
    getRoomDb(),
    roomId,
    new Request(accountUrl(roomId, '', owner), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        elements: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
    }),
  );
}

describe('room presence API', () => {
  it('returns 400 for malformed JSON body', async () => {
    const roomId = `presence-malformed-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const response = await handlePresencePost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/presence', owner), {
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
    const owner = `acc-owner-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    const response = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { userName: 'Alice' }),
    );

    expect(response.status).toBe(400);
  });

  it('requires an account to join', async () => {
    const roomId = `presence-no-account-${crypto.randomUUID()}`;
    const response = await handlePresencePost(
      getRoomDb(),
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-alice' }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it('defaults to Anonymous userName when not provided', async () => {
    const roomId = `presence-default-name-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const response = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { peerId: 'peer-alice' }),
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

    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, owner, 'peer-alice'));
  });

  it('marks the owner grant as host even if they join after others, ignoring hostPeerId', async () => {
    const roomId = `presence-creator-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    await handleRoomSettings(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/settings', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostPeerId: 'peer-joiner' }),
      }),
    );

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, guest, { peerId: 'peer-joiner', userName: 'Joiner', color: '#e74c3c' }),
    );
    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { peerId: 'peer-creator', userName: 'Creator', color: '#3498db' }),
    );

    const response = await handlePresenceGet(getRoomDb(), roomId, getRequest(roomId, owner));
    const data = await response.json() as {
      hostPeerId: string;
      users: Array<{ peerId: string; isHost: boolean }>;
      waitingPeers: Array<{ peerId: string }>;
    };

    expect(data.hostPeerId).toBe('peer-joiner');
    expect(data.users.find((u) => u.peerId === 'peer-creator')?.isHost).toBe(true);
    expect(data.users.find((u) => u.peerId === 'peer-joiner')).toBeUndefined();
    expect(data.waitingPeers).toEqual([
      expect.objectContaining({
        peerId: 'peer-joiner',
        userName: 'Joiner',
        color: '#e74c3c',
        isWaiting: true,
      }),
    ]);
  });

  it('queues a second account that has no grant', async () => {
    const roomId = `presence-order-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const aliceResponse = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { peerId: 'peer-alice', userName: 'Alice', color: '#3498db' }),
    );
    const bobResponse = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, guest, { peerId: 'peer-bob', userName: 'Bob', color: '#e74c3c' }),
    );

    expect(aliceResponse.status).toBe(200);
    expect(bobResponse.status).toBe(200);

    const response = await handlePresenceGet(getRoomDb(), roomId, getRequest(roomId, owner));
    const data = await response.json();

    expect(data.users).toEqual([
      expect.objectContaining({ peerId: 'peer-alice', userName: 'Alice', isHost: true, isWaiting: false }),
    ]);
    expect(data.waitingPeers).toEqual([
      expect.objectContaining({
        peerId: 'peer-bob',
        userName: 'Bob',
        color: '#e74c3c',
        isWaiting: true,
      }),
    ]);
  });

  it('removes a user when they leave presence', async () => {
    const roomId = `presence-leave-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Bob' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { peerId: 'peer-alice', userName: 'Alice' }),
    );
    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, editor, { peerId: 'peer-bob', userName: 'Bob' }),
    );

    const deleteResponse = await handlePresenceDelete(
      getRoomDb(),
      roomId,
      deleteRequest(roomId, editor, 'peer-bob'),
    );
    const deleteData = await deleteResponse.json();

    expect(deleteResponse.status).toBe(200);
    expect(deleteData.users).toEqual([
      expect.objectContaining({ peerId: 'peer-alice', userName: 'Alice' }),
    ]);
  });

  it('puts non-owner accounts in waiting even when room capacity remains', async () => {
    const roomId = `presence-waiting-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    await handleRoomSettings(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/settings', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxUsers: 3, hostPeerId: 'peer-host' }),
      }),
    );

    const joinResponse = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, guest, { peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );
    const joinData = await joinResponse.json();

    expect(joinResponse.status).toBe(200);
    expect(joinData.isWaiting).toBe(true);
    expect(joinData.users?.map((user: { peerId: string }) => user.peerId) ?? []).not.toContain(
      'peer-student',
    );
  });

  it('keeps an approved peer active on later heartbeat checks', async () => {
    const roomId = `presence-approved-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, guest, { peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );

    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-student', action: 'approve' }),
      }),
    );

    const heartbeatResponse = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, guest, { peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );
    const heartbeatData = await heartbeatResponse.json();

    expect(heartbeatData.isWaiting).toBe(false);
    expect(heartbeatData.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: 'peer-student', isWaiting: false }),
      ]),
    );
  });

  it('keeps a kicked account banned even with a new peerId', async () => {
    const roomId = `presence-kicked-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, guest, { peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );
    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-student', action: 'approve' }),
      }),
    );

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { action: 'kick', peerId: 'peer-student' }),
    );

    const heartbeatResponse = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, guest, { peerId: 'brand-new-peer', userName: 'Student', color: '#e74c3c' }),
    );

    expect(heartbeatResponse.status).toBe(403);
  });

  it('marks a rejected waiting account as forbidden on their next heartbeat', async () => {
    const roomId = `presence-rejected-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, guest, { peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );
    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-student', action: 'reject' }),
      }),
    );

    const heartbeatResponse = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, guest, { peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );

    expect(heartbeatResponse.status).toBe(403);
  });

  it('moves a suspended approved peer back to waiting on heartbeat', async () => {
    const roomId = `presence-suspended-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, guest, { peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );
    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-student', action: 'approve' }),
      }),
    );
    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { action: 'suspend', peerId: 'peer-student' }),
    );

    const heartbeatResponse = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, guest, { peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );
    const heartbeatData = await heartbeatResponse.json();

    expect(heartbeatData.isWaiting).toBe(true);
  });

  it('omits the waiting queue for a non-owner presence GET', async () => {
    const roomId = `presence-queue-redact-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;

    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, guest, { peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    );

    const ownerGet = await handlePresenceGet(getRoomDb(), roomId, getRequest(roomId, owner));
    const ownerData = await ownerGet.json() as { waitingPeers: Array<{ peerId: string }> };
    expect(ownerData.waitingPeers.map((p) => p.peerId)).toContain('peer-student');

    const editorGet = await handlePresenceGet(getRoomDb(), roomId, getRequest(roomId, editor));
    const editorData = await editorGet.json() as { waitingPeers?: unknown };
    expect(editorData.waitingPeers).toBeUndefined();
  });
});
