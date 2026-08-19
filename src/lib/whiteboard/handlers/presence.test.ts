import { describe, expect, it } from 'vitest';
import { CSPRNG_ID_HEX_LENGTH } from '../../crypto/randomId';
import { handlePresencePost, handlePresenceGet, handlePresenceDelete } from './presence';
import { handleRoomPost, handleRoomSettings } from './room';
import { handleWaitingPost } from './waiting';
import { getRoomDb } from '../roomDb';
import { approveAccount, requestAccess } from '../membership';

const ISSUED_PEER_ID = new RegExp(`^user-[0-9a-f]{${CSPRNG_ID_HEX_LENGTH}}$`);

async function postPresence(
  roomId: string,
  accountId: string,
  body: Record<string, unknown>,
) {
  const response = await handlePresencePost(
    getRoomDb(),
    roomId,
    postRequest(roomId, accountId, body),
  );
  const data = await response.json() as {
    peerId?: string;
    error?: string;
    isWaiting?: boolean;
    users?: Array<{ peerId: string; userName?: string; isHost?: boolean; isWaiting?: boolean }>;
    waitingPeers?: Array<{ peerId: string; userName?: string; color?: string; isWaiting?: boolean }>;
  };
  return { response, data };
}

function storedPeerId(roomId: string, accountId: string): string | undefined {
  const row = getRoomDb().prepare(
    `SELECT peer_id AS peerId FROM room_presence WHERE room_id = ? AND account_id = ?
     UNION
     SELECT peer_id AS peerId FROM waiting_peers WHERE room_id = ? AND account_id = ?`,
  ).get(roomId, accountId, roomId, accountId) as { peerId: string } | undefined;
  return row?.peerId;
}

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

  it('issues a stable server peerId and ignores client-chosen ids', async () => {
    const roomId = `presence-issued-id-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const first = await postPresence(roomId, owner, {
      peerId: 'client-alpha',
      userName: 'Alice',
    });
    expect(first.response.status).toBe(200);
    expect(first.data.peerId).toMatch(ISSUED_PEER_ID);
    expect(first.data.peerId).not.toBe('client-alpha');
    expect(storedPeerId(roomId, owner)).toBe(first.data.peerId);
    expect(first.data.users?.map((user) => user.peerId)).toEqual([first.data.peerId]);

    const second = await postPresence(roomId, owner, {
      peerId: 'client-beta',
      userName: 'Alice',
    });
    expect(second.response.status).toBe(200);
    expect(second.data.peerId).toBe(first.data.peerId);
    expect(second.data.peerId).not.toBe('client-beta');
    expect(storedPeerId(roomId, owner)).toBe(first.data.peerId);

    const other = await postPresence(roomId, guest, {
      peerId: 'client-alpha',
      userName: 'Bob',
    });
    expect(other.response.status).toBe(200);
    expect(other.data.peerId).toMatch(ISSUED_PEER_ID);
    expect(other.data.peerId).not.toBe(first.data.peerId);
    expect(other.data.peerId).not.toBe('client-alpha');
    expect(storedPeerId(roomId, guest)).toBe(other.data.peerId);
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

    const { response, data } = await postPresence(roomId, owner, { peerId: 'peer-alice' });

    expect(response.status).toBe(200);
    expect(data.users).toEqual([
      expect.objectContaining({
        peerId: data.peerId,
        userName: 'Anonymous',
        isHost: true,
        isWaiting: false,
      }),
    ]);

    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, owner, data.peerId!));
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

    const guestJoin = await postPresence(roomId, guest, {
      peerId: 'peer-joiner',
      userName: 'Joiner',
      color: '#e74c3c',
    });
    const ownerJoin = await postPresence(roomId, owner, {
      peerId: 'peer-creator',
      userName: 'Creator',
      color: '#3498db',
    });

    const response = await handlePresenceGet(getRoomDb(), roomId, getRequest(roomId, owner));
    const data = await response.json() as {
      hostPeerId: string;
      users: Array<{ peerId: string; isHost: boolean }>;
      waitingPeers: Array<{ peerId: string }>;
    };

    expect(data.hostPeerId).toBe('peer-joiner');
    expect(data.users.find((u) => u.peerId === ownerJoin.data.peerId)?.isHost).toBe(true);
    expect(data.users.find((u) => u.peerId === guestJoin.data.peerId)).toBeUndefined();
    expect(data.waitingPeers).toEqual([
      expect.objectContaining({
        peerId: guestJoin.data.peerId,
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

    const alice = await postPresence(roomId, owner, {
      peerId: 'peer-alice',
      userName: 'Alice',
      color: '#3498db',
    });
    const bob = await postPresence(roomId, guest, {
      peerId: 'peer-bob',
      userName: 'Bob',
      color: '#e74c3c',
    });

    expect(alice.response.status).toBe(200);
    expect(bob.response.status).toBe(200);

    const response = await handlePresenceGet(getRoomDb(), roomId, getRequest(roomId, owner));
    const data = await response.json();

    expect(data.users).toEqual([
      expect.objectContaining({
        peerId: alice.data.peerId,
        userName: 'Alice',
        isHost: true,
        isWaiting: false,
      }),
    ]);
    expect(data.waitingPeers).toEqual([
      expect.objectContaining({
        peerId: bob.data.peerId,
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

    const alice = await postPresence(roomId, owner, { peerId: 'peer-alice', userName: 'Alice' });
    const bob = await postPresence(roomId, editor, { peerId: 'peer-bob', userName: 'Bob' });

    const deleteResponse = await handlePresenceDelete(
      getRoomDb(),
      roomId,
      deleteRequest(roomId, editor, bob.data.peerId!),
    );
    const deleteData = await deleteResponse.json();

    expect(deleteResponse.status).toBe(200);
    expect(deleteData.users).toEqual([
      expect.objectContaining({ peerId: alice.data.peerId, userName: 'Alice' }),
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
        body: JSON.stringify({ maxUsers: 2, hostPeerId: 'peer-host' }),
      }),
    );

    const { response, data } = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });

    expect(response.status).toBe(200);
    expect(data.isWaiting).toBe(true);
    expect(data.users?.map((user) => user.peerId) ?? []).not.toContain(data.peerId);
  });

  it('keeps an approved peer active on later heartbeat checks', async () => {
    const roomId = `presence-approved-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const join = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });

    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: join.data.peerId, action: 'approve' }),
      }),
    );

    const heartbeat = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });

    expect(heartbeat.data.isWaiting).toBe(false);
    expect(heartbeat.data.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: join.data.peerId, isWaiting: false }),
      ]),
    );
  });

  it('keeps a kicked account banned even with a new peerId', async () => {
    const roomId = `presence-kicked-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const join = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });
    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: join.data.peerId, action: 'approve' }),
      }),
    );

    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { action: 'kick', peerId: join.data.peerId }),
    );

    const heartbeat = await postPresence(roomId, guest, {
      peerId: 'brand-new-peer',
      userName: 'Student',
      color: '#e74c3c',
    });

    expect(heartbeat.response.status).toBe(403);
  });

  it('marks a rejected waiting account as forbidden on their next heartbeat', async () => {
    const roomId = `presence-rejected-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const join = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });
    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: join.data.peerId, action: 'reject' }),
      }),
    );

    const heartbeat = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });

    expect(heartbeat.response.status).toBe(403);
  });

  it('moves a suspended approved peer back to waiting on heartbeat', async () => {
    const roomId = `presence-suspended-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const join = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });
    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: join.data.peerId, action: 'approve' }),
      }),
    );
    await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { action: 'suspend', peerId: join.data.peerId }),
    );

    const heartbeat = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });

    expect(heartbeat.data.isWaiting).toBe(true);
  });

  it('omits the waiting queue for a non-owner presence GET', async () => {
    const roomId = `presence-queue-redact-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;

    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });

    const join = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });

    const ownerGet = await handlePresenceGet(getRoomDb(), roomId, getRequest(roomId, owner));
    const ownerData = await ownerGet.json() as { waitingPeers: Array<{ peerId: string }> };
    expect(ownerData.waitingPeers.map((p) => p.peerId)).toContain(join.data.peerId);

    const editorGet = await handlePresenceGet(getRoomDb(), roomId, getRequest(roomId, editor));
    const editorData = await editorGet.json() as { waitingPeers?: unknown };
    expect(editorData.waitingPeers).toBeUndefined();
  });

  it('omits accountId from presence users for a non-owner GET', async () => {
    const roomId = `presence-account-redact-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;

    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });

    await postPresence(roomId, owner, { peerId: 'peer-owner', userName: 'Teacher' });
    await postPresence(roomId, editor, { peerId: 'peer-editor', userName: 'Ed' });

    const ownerGet = await handlePresenceGet(getRoomDb(), roomId, getRequest(roomId, owner));
    const ownerData = await ownerGet.json() as {
      users: Array<{ peerId: string; accountId?: string }>;
    };
    expect(ownerData.users.some((user) => typeof user.accountId === 'string')).toBe(true);

    const editorGet = await handlePresenceGet(getRoomDb(), roomId, getRequest(roomId, editor));
    const editorData = await editorGet.json() as {
      users: Array<{ peerId: string; accountId?: string }>;
    };
    expect(JSON.stringify(editorData)).not.toContain('"accountId"');
    expect(editorData.users.every((user) => user.accountId === undefined)).toBe(true);
  });

  it('logs a revocation auth event after a successful kick', async () => {
    const roomId = `presence-kick-log-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const join = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });
    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: join.data.peerId, action: 'approve' }),
      }),
    );

    const lines: string[] = [];
    const response = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { action: 'kick', peerId: join.data.peerId }),
      (line) => lines.push(line),
    );

    expect(response.status).toBe(200);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'auth_event',
      type: 'revocation',
      accountId: guest,
      roomId,
      outcome: 'kicked',
    });
  });

  it('does not log a revocation auth event when kick is forbidden', async () => {
    const roomId = `presence-kick-nolog-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });

    const join = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });
    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: join.data.peerId, action: 'approve' }),
      }),
    );

    const lines: string[] = [];
    const response = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, editor, { action: 'kick', peerId: join.data.peerId }),
      (line) => lines.push(line),
    );

    expect(response.status).toBe(403);
    expect(lines).toEqual([]);
  });

  it('logs a revocation auth event after a successful suspend', async () => {
    const roomId = `presence-suspend-log-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const join = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });
    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: join.data.peerId, action: 'approve' }),
      }),
    );

    const lines: string[] = [];
    const response = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { action: 'suspend', peerId: join.data.peerId }),
      (line) => lines.push(line),
    );

    expect(response.status).toBe(200);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'auth_event',
      type: 'revocation',
      accountId: guest,
      roomId,
      outcome: 'suspended',
    });
  });

  it('logs a grant_change auth event after a successful waiting approve', async () => {
    const roomId = `waiting-approve-log-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const join = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });

    const lines: string[] = [];
    const response = await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: join.data.peerId, action: 'approve' }),
      }),
      (line) => lines.push(line),
    );

    expect(response.status).toBe(200);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'auth_event',
      type: 'grant_change',
      accountId: guest,
      roomId,
      outcome: 'approved',
    });
  });
});
