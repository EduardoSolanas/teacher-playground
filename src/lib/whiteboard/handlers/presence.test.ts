// @ts-nocheck
﻿import { describe, expect, it } from 'vitest';
import { CSPRNG_ID_HEX_LENGTH } from '../../crypto/randomId';
import { handlePresencePost, handlePresenceGet, handlePresenceDelete } from './presence';
import { handleRoomPost, handleRoomSettings } from './room';
import { handleWaitingPost } from './waiting';
import { getRoomDb } from '../roomDb';
import { ACTIVE_WINDOW_MS, activePeerIds } from '../presence';
import { approveAccount, getGrantRole, requestAccess } from '../membership';

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

/*
 * The two timestamps behind every roster, read straight from the row.
 *
 * `last_seen` is what keeps a peer in the room and `first_seen` is what orders
 * it, and the upsert has to move exactly one of them. Nothing asserted that
 * until a change to the client's heartbeat passed the whole suite while every
 * roster in production would have emptied inside ten seconds.
 */
function presenceTimes(roomId: string, peerId: string) {
  return getRoomDb().prepare(
    `SELECT first_seen AS firstSeen, last_seen AS lastSeen
     FROM room_presence WHERE room_id = ? AND peer_id = ?`,
  ).get(roomId, peerId) as { firstSeen: number; lastSeen: number } | undefined;
}

function backdate(roomId: string, peerId: string, lastSeen: number, firstSeen?: number) {
  getRoomDb().prepare(
    `UPDATE room_presence SET last_seen = ?, first_seen = COALESCE(?, first_seen)
     WHERE room_id = ? AND peer_id = ?`,
  ).run(lastSeen, firstSeen ?? null, roomId, peerId);
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
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
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
    const data = await response.json() as { error?: string };
    expect(typeof data.error).toBe('string');
    expect(data.error!.length).toBeGreaterThan(0);
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
    expect(await response.json()).toEqual({ error: 'Account required' });
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
        color: '#3498db',
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

  it('refuses an over-cap waiter with a queue-full signal, not a rate limit', async () => {
    const roomId = `presence-queue-full-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
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

    const first = await postPresence(roomId, `acc-first-${crypto.randomUUID()}`, {
      peerId: 'peer-first',
      userName: 'First',
      color: '#3498db',
    });
    const second = await postPresence(roomId, `acc-second-${crypto.randomUUID()}`, {
      peerId: 'peer-second',
      userName: 'Second',
      color: '#e74c3c',
    });
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);

    const overflow = await postPresence(roomId, `acc-third-${crypto.randomUUID()}`, {
      peerId: 'peer-third',
      userName: 'Third',
      color: '#2ecc71',
    });

    expect(overflow.response.status).toBe(409);
    expect(overflow.response.status).not.toBe(429);
    expect(overflow.data.error).toMatch(/waiting queue is full/i);
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

    const approved = await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: join.data.peerId, action: 'approve' }),
      }),
    );
    const approvedBody = await approved.json() as { success?: boolean; users?: Array<{ peerId: string }> };
    expect(approvedBody.success).toBe(true);
    expect(approvedBody.users?.some((user) => user.peerId === join.data.peerId)).toBe(true);

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
    expect(heartbeat.data).toEqual({ error: 'Forbidden' });
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
    const rejected = await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: join.data.peerId, action: 'reject' }),
      }),
    );
    expect(await rejected.json()).toEqual({
      success: true,
      bannedPeer: { accountId: guest },
    });
    expect(storedPeerId(roomId, guest)).toBeUndefined();

    const heartbeat = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });

    expect(heartbeat.response.status).toBe(403);
    expect(heartbeat.data).toEqual({ error: 'Forbidden' });
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
    expect(await response.json()).toMatchObject({
      kickedPeer: { peerId: join.data.peerId, accountId: guest },
    });
    expect(storedPeerId(roomId, guest)).toBeUndefined();
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
    expect(await response.json()).toEqual({ error: 'Forbidden' });
    expect(lines).toEqual([]);
  });

  it('returns 404 when a kick names only a stale peer id', async () => {
    const roomId = `presence-kick-stale-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const response = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { action: 'kick', peerId: 'ghost-peer' }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Peer not bound to an account' });
  });

  it('refuses a kick that names the owner account itself', async () => {
    const roomId = `presence-kick-self-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const response = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { action: 'kick', accountId: owner }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
    expect(getGrantRole(getRoomDb(), roomId, owner)).toBe('owner');
  });

  it('resolves the kicked peer label from the stored row when only the account is named', async () => {
    const roomId = `presence-kick-by-account-${crypto.randomUUID()}`;
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

    const response = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { action: 'kick', accountId: guest }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kickedPeer: { peerId: join.data.peerId, accountId: guest },
    });
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
    expect(await response.json()).toMatchObject({
      suspendedPeer: { peerId: join.data.peerId, accountId: guest, userName: 'Student' },
    });
    expect(storedPeerId(roomId, guest)).toBe(join.data.peerId);
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

  it('lets an admitted member raise and lower their own hand', async () => {
    const roomId = `presence-raise-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });

    const join = await postPresence(roomId, editor, { peerId: 'peer-ed', userName: 'Ed' });
    const raised = await postPresence(roomId, editor, { action: 'raise-hand' });
    expect(raised.response.status).toBe(200);
    expect(raised.data.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: join.data.peerId, handRaised: true }),
      ]),
    );

    const lowered = await postPresence(roomId, editor, { action: 'lower-hand' });
    expect(lowered.response.status).toBe(200);
    expect(lowered.data.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: join.data.peerId, handRaised: false }),
      ]),
    );
  });

  it('rejects raise-hand from a waiting account', async () => {
    const roomId = `presence-raise-wait-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    await postPresence(roomId, guest, { peerId: 'peer-student', userName: 'Student' });

    const raised = await postPresence(roomId, guest, { action: 'raise-hand' });
    expect(raised.response.status).toBe(403);
    expect(raised.data).toEqual({ error: 'Forbidden' });
  });

  it('refuses raise-hand for a granted account that never joined presence', async () => {
    const roomId = `presence-raise-no-row-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });

    const raised = await postPresence(roomId, editor, { action: 'raise-hand' });

    expect(raised.response.status).toBe(403);
    expect(raised.data).toEqual({ error: 'Forbidden' });
  });

  it('refuses raise-hand for a pending account that somehow holds a presence row', async () => {
    const roomId = `presence-raise-pending-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: guest, userName: 'Guest' });
    getRoomDb().prepare(
      `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen, account_id)
       VALUES (?, 'peer-seeded', 'Guest', '#3498db', ?, ?, ?)`,
    ).run(roomId, Date.now(), Date.now(), guest);

    const raised = await postPresence(roomId, guest, { action: 'raise-hand' });

    expect(raised.response.status).toBe(403);
    expect(raised.data).toEqual({ error: 'Forbidden' });
  });

  it('kicks a known account that has no presence row using its account id as label', async () => {
    const roomId = `presence-kick-no-row-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });

    const response = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { action: 'kick', accountId: editor }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kickedPeer: { peerId: editor, accountId: editor },
    });
    expect(getGrantRole(getRoomDb(), roomId, editor)).toBe('banned');
  });

  it('does not raise another account hand even when the body names their peerId', async () => {
    const roomId = `presence-raise-other-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });

    const ownerJoin = await postPresence(roomId, owner, { peerId: 'peer-owner', userName: 'Teacher' });
    const editorJoin = await postPresence(roomId, editor, { peerId: 'peer-ed', userName: 'Ed' });

    const raised = await postPresence(roomId, editor, {
      action: 'raise-hand',
      peerId: ownerJoin.data.peerId,
    });
    expect(raised.response.status).toBe(200);
    expect(raised.data.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: editorJoin.data.peerId, handRaised: true }),
        expect.objectContaining({ peerId: ownerJoin.data.peerId, handRaised: false }),
      ]),
    );
  });

  it('lets the owner lower a named participant hand', async () => {
    const roomId = `presence-lower-peer-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });

    const ownerJoin = await postPresence(roomId, owner, { peerId: 'peer-owner', userName: 'Teacher' });
    const editorJoin = await postPresence(roomId, editor, { peerId: 'peer-ed', userName: 'Ed' });
    await postPresence(roomId, editor, { action: 'raise-hand' });

    const lowered = await postPresence(roomId, owner, {
      action: 'lower-peer-hand',
      accountId: editor,
    });

    expect(lowered.response.status).toBe(200);
    expect(lowered.data.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: editorJoin.data.peerId, handRaised: false }),
        expect.objectContaining({ peerId: ownerJoin.data.peerId, handRaised: false }),
      ]),
    );
  });

  it('refuses a non-owner lowering another participant hand', async () => {
    const roomId = `presence-lower-peer-role-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });

    const ownerJoin = await postPresence(roomId, owner, { peerId: 'peer-owner', userName: 'Teacher' });
    await postPresence(roomId, editor, { peerId: 'peer-ed', userName: 'Ed' });
    await postPresence(roomId, owner, { action: 'raise-hand' });

    const lowered = await postPresence(roomId, editor, {
      action: 'lower-peer-hand',
      accountId: owner,
    });

    expect(lowered.response.status).toBe(403);
    expect(lowered.data).toEqual({ error: 'Forbidden' });

    const roster = await postPresence(roomId, owner, { peerId: 'peer-owner', userName: 'Teacher' });
    expect(roster.data.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: ownerJoin.data.peerId, handRaised: true }),
      ]),
    );
  });

  it('lets the owner lower every raised hand at once', async () => {
    const roomId = `presence-lower-all-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const first = `acc-first-${crypto.randomUUID()}`;
    const second = `acc-second-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    for (const [accountId, userName] of [[first, 'Ann'], [second, 'Ben']] as const) {
      requestAccess(getRoomDb(), { roomId, accountId, userName });
      approveAccount(getRoomDb(), roomId, accountId, { role: 'editor' });
    }

    await postPresence(roomId, owner, { peerId: 'peer-owner', userName: 'Teacher' });
    const firstJoin = await postPresence(roomId, first, { peerId: 'peer-first', userName: 'Ann' });
    const secondJoin = await postPresence(roomId, second, { peerId: 'peer-second', userName: 'Ben' });
    await postPresence(roomId, first, { action: 'raise-hand' });
    await postPresence(roomId, second, { action: 'raise-hand' });

    const lowered = await postPresence(roomId, owner, { action: 'lower-all-hands' });

    expect(lowered.response.status).toBe(200);
    expect(lowered.data.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: firstJoin.data.peerId, handRaised: false }),
        expect.objectContaining({ peerId: secondJoin.data.peerId, handRaised: false }),
      ]),
    );
  });

  it('refuses a non-owner lowering every raised hand', async () => {
    const roomId = `presence-lower-all-role-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });

    const ownerJoin = await postPresence(roomId, owner, { peerId: 'peer-owner', userName: 'Teacher' });
    await postPresence(roomId, owner, { action: 'raise-hand' });

    const lowered = await postPresence(roomId, editor, { action: 'lower-all-hands' });

    expect(lowered.response.status).toBe(403);
    expect(lowered.data).toEqual({ error: 'Forbidden' });

    const roster = await postPresence(roomId, owner, { peerId: 'peer-owner', userName: 'Teacher' });
    expect(roster.data.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: ownerJoin.data.peerId, handRaised: true }),
      ]),
    );
  });

  it('refuses to lower a hand for an account that is not in the room', async () => {
    const roomId = `presence-lower-peer-unknown-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const stranger = `acc-stranger-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    const ownerJoin = await postPresence(roomId, owner, { peerId: 'peer-owner', userName: 'Teacher' });
    await postPresence(roomId, owner, { action: 'raise-hand' });

    const lowered = await postPresence(roomId, owner, {
      action: 'lower-peer-hand',
      accountId: stranger,
    });

    expect(lowered.response.status).toBe(404);
    expect(lowered.data).toEqual({ error: 'Account not found' });

    const roster = await postPresence(roomId, owner, { peerId: 'peer-owner', userName: 'Teacher' });
    expect(roster.data.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: ownerJoin.data.peerId, handRaised: true }),
      ]),
    );
  });

  it('keeps handRaised true across a join heartbeat', async () => {
    const roomId = `presence-raise-hb-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    const join = await postPresence(roomId, owner, { peerId: 'peer-owner', userName: 'Teacher' });
    await postPresence(roomId, owner, { action: 'raise-hand' });

    const heartbeat = await postPresence(roomId, owner, {
      peerId: 'peer-owner',
      userName: 'Teacher',
    });
    expect(heartbeat.data.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: join.data.peerId, handRaised: true }),
      ]),
    );
  });

  it('a heartbeat is what keeps a peer in the room', async () => {
    /*
     * The whole reason the client must keep posting even on a healthy socket:
     * this upsert is the only writer of `last_seen`, and nothing on the
     * signaling path touches it.
     */
    const roomId = `presence-heartbeat-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const join = await postPresence(roomId, owner, { peerId: 'peer-teacher', userName: 'Teacher', color: '#123456' });
    const peerId = join.data.peerId!;

    backdate(roomId, peerId, Date.now() - ACTIVE_WINDOW_MS - 5_000);
    expect(activePeerIds(getRoomDb(), roomId).has(peerId)).toBe(false);

    await postPresence(roomId, owner, { peerId: 'peer-teacher', userName: 'Teacher', color: '#123456' });
    expect(activePeerIds(getRoomDb(), roomId).has(peerId)).toBe(true);
  });

  it('a heartbeat does not reset when the peer arrived', async () => {
    // first_seen orders the roster and elects the first-user host. A heartbeat
    // that moved it would reshuffle the room every two seconds, and could hand
    // the lesson to whoever posted last.
    const roomId = `presence-firstseen-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const join = await postPresence(roomId, owner, { peerId: 'peer-teacher', userName: 'Teacher', color: '#123456' });
    const peerId = join.data.peerId!;

    const arrived = Date.now() - 120_000;
    backdate(roomId, peerId, Date.now(), arrived);

    await postPresence(roomId, owner, { peerId: 'peer-teacher', userName: 'Teacher', color: '#123456' });
    const after = presenceTimes(roomId, peerId)!;
    expect(after.firstSeen).toBe(arrived);
    expect(after.lastSeen).toBeGreaterThan(arrived);
  });

  it('admission puts a peer in the room without waiting for a heartbeat', async () => {
    // Approval writes presence itself. If it did not, a student would be let
    // in and still be missing from the roster until their next post.
    const roomId = `presence-admit-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const join = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });
    expect(join.data.isWaiting).toBe(true);

    await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: join.data.peerId, action: 'approve' }),
      }),
    );

    expect(activePeerIds(getRoomDb(), roomId).has(join.data.peerId!)).toBe(true);
  });

  it('leaving removes a peer at once, without waiting out the window', async () => {
    const roomId = `presence-leave-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const join = await postPresence(roomId, owner, { peerId: 'peer-teacher', userName: 'Teacher', color: '#123456' });
    const peerId = join.data.peerId!;
    expect(activePeerIds(getRoomDb(), roomId).has(peerId)).toBe(true);

    await handlePresenceDelete(getRoomDb(), roomId, deleteRequest(roomId, owner, peerId));
    expect(presenceTimes(roomId, peerId)).toBeUndefined();
  });

  it('returns 400 for a malformed waiting action body', async () => {
    const roomId = `waiting-malformed-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const response = await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-someone' }),
      }),
    );

    expect(response.status).toBe(400);
    const data = await response.json() as { error?: string };
    expect(typeof data.error).toBe('string');
    expect(data.error!.length).toBeGreaterThan(0);
  });

  it('returns 401 for a waiting action without an account', async () => {
    const roomId = `waiting-no-account-${crypto.randomUUID()}`;
    const response = await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}/waiting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-someone', action: 'approve' }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Account required' });
  });

  it('returns 403 for a waiting action from a granted non-owner', async () => {
    const roomId = `waiting-non-owner-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });

    const response = await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', editor), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer-someone', action: 'approve' }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 404 for a waiting target that resolves to nothing', async () => {
    const roomId = `waiting-ghost-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const response = await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'ghost-peer', action: 'approve' }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Peer not bound to an account' });
  });

  it('returns 404 when approving an account that is no longer pending', async () => {
    const roomId = `waiting-not-pending-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });

    const response = await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: editor, action: 'approve' }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Peer not found in waiting list' });
  });

  it('returns 500 when the approve transaction fails for another reason', async () => {
    const roomId = `waiting-approve-error-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    const join = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });

    const inner = getRoomDb();
    const db = {
      prepare(sql: string) {
        const stmt = inner.prepare(sql);
        if (sql.includes('UPDATE room_members') && sql.includes("role = 'pending'")) {
          return {
            run() {
              throw new Error('injected');
            },
          };
        }
        return stmt;
      },
      exec: inner.exec.bind(inner),
      transaction: inner.transaction.bind(inner),
    };

    const lines: string[] = [];
    const response = await handleWaitingPost(
      db as never,
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: join.data.peerId, action: 'approve' }),
      }),
      (line) => lines.push(line),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(lines).toEqual([]);
  });

  it('clears the kicked marker when a waiting account is admitted', async () => {
    const roomId = `waiting-kicked-clear-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const join = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });
    getRoomDb().prepare(
      `INSERT INTO kicked_peers (room_id, peer_id, kicked_at) VALUES (?, ?, ?)`,
    ).run(roomId, join.data.peerId, Date.now());

    const response = await handleWaitingPost(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/waiting', owner), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: join.data.peerId, action: 'approve' }),
      }),
    );

    expect(response.status).toBe(200);
    const kicked = getRoomDb().prepare(
      `SELECT COUNT(*) AS n FROM kicked_peers WHERE room_id = ? AND peer_id = ?`,
    ).get(roomId, join.data.peerId) as { n: number };
    expect(kicked.n).toBe(0);
  });

  it('suspends a waiting account under its waiting row peer id', async () => {
    const roomId = `presence-suspend-waiting-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const join = await postPresence(roomId, guest, {
      peerId: 'peer-student',
      userName: 'Student',
      color: '#e74c3c',
    });
    expect(join.data.isWaiting).toBe(true);

    const response = await handlePresencePost(
      getRoomDb(),
      roomId,
      postRequest(roomId, owner, { action: 'suspend', accountId: guest }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      suspendedPeer: { peerId: join.data.peerId, accountId: guest },
    });
    expect(storedPeerId(roomId, guest)).toBe(join.data.peerId);
  });

  it('refuses a presence DELETE without a peerId', async () => {
    const roomId = `presence-delete-no-peer-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const response = await handlePresenceDelete(
      getRoomDb(),
      roomId,
      new Request(accountUrl(roomId, '/presence', owner), { method: 'DELETE' }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'peerId is required' });
  });

  it('refuses a presence DELETE without an account', async () => {
    const roomId = `presence-delete-no-account-${crypto.randomUUID()}`;
    const response = await handlePresenceDelete(
      getRoomDb(),
      roomId,
      new Request(
        `http://localhost/api/whiteboard/room/${roomId}/presence?peerId=peer-x`,
        { method: 'DELETE' },
      ),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Account required' });
  });
});
