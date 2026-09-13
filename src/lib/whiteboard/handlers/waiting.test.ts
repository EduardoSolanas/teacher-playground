import { describe, expect, it } from 'vitest';
import { approveAccount, getGrantRole, requestAccess } from '../membership';
import { getRoomDb } from '../roomDb';
import { handlePresencePost } from './presence';
import { handleRoomPost } from './room';
import { handleWaitingDelete, handleWaitingGet, handleWaitingPost } from './waiting';

function accountUrl(roomId: string, path: string, accountId: string): string {
  return `http://localhost/api/whiteboard/room/${roomId}${path}?accountId=${encodeURIComponent(accountId)}`;
}

async function createOwnedRoom(roomId: string, owner: string): Promise<void> {
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

async function joinAsWaitingGuest(
  roomId: string,
  guest: string,
): Promise<{ peerId: string; isWaiting: boolean }> {
  const response = await handlePresencePost(
    getRoomDb(),
    roomId,
    new Request(accountUrl(roomId, '/presence', guest), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: 'peer-student', userName: 'Student', color: '#e74c3c' }),
    }),
  );
  return (await response.json()) as { peerId: string; isWaiting: boolean };
}

function waitingUrl(roomId: string, accountId?: string): string {
  return accountId
    ? accountUrl(roomId, '/waiting', accountId)
    : `http://localhost/api/whiteboard/room/${roomId}/waiting`;
}

function getWaiting(roomId: string, accountId?: string): Request {
  return new Request(waitingUrl(roomId, accountId));
}

function postWaiting(
  roomId: string,
  accountId: string | undefined,
  body: string | Record<string, unknown>,
): Request {
  return new Request(waitingUrl(roomId, accountId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function deleteWaiting(roomId: string, accountId: string | undefined, peerId?: string): Request {
  const base = waitingUrl(roomId, accountId);
  const url = peerId
    ? `${base}${accountId ? '&' : '?'}peerId=${encodeURIComponent(peerId)}`
    : base;
  return new Request(url, { method: 'DELETE' });
}

describe('waiting handler GET', () => {
  it('requires an account', async () => {
    const roomId = `waiting-get-no-account-${crypto.randomUUID()}`;

    const response = await handleWaitingGet(getRoomDb(), roomId, getWaiting(roomId));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Account required' });
  });

  it('forbids a granted non-owner', async () => {
    const roomId = `waiting-get-non-owner-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });

    const response = await handleWaitingGet(getRoomDb(), roomId, getWaiting(roomId, editor));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
  });

  it('lists a waiting peer with its stored label and arrival', async () => {
    const roomId = `waiting-get-list-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    const join = await joinAsWaitingGuest(roomId, guest);
    expect(join.isWaiting).toBe(true);

    const response = await handleWaitingGet(getRoomDb(), roomId, getWaiting(roomId, owner));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      waitingPeers: Array<{
        peerId: string;
        accountId: string;
        userName: string;
        color: string;
        requestedAt: number;
      }>;
    };
    expect(body.waitingPeers).toEqual([
      {
        peerId: join.peerId,
        accountId: guest,
        userName: 'Student',
        color: '#e74c3c',
        requestedAt: expect.any(Number),
      },
    ]);
    expect(body.waitingPeers[0]!.requestedAt).toBeGreaterThan(0);
  });

  it('falls back to the pending membership when no peer row is stored', async () => {
    const roomId = `waiting-get-fallback-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const stranger = `acc-stranger-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: stranger, userName: 'Stranger', now: 777 });

    const response = await handleWaitingGet(getRoomDb(), roomId, getWaiting(roomId, owner));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      waitingPeers: Array<{
        peerId: string;
        accountId: string;
        userName: string;
        color: string;
        requestedAt: number;
      }>;
    };
    expect(body.waitingPeers).toEqual([
      {
        peerId: stranger,
        accountId: stranger,
        userName: 'Stranger',
        color: '#3498db',
        requestedAt: 777,
      },
    ]);
  });

  it('ignores unbound peer rows and keeps the first peer of a repeated account', async () => {
    const roomId = `waiting-get-legacy-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const legacy = `acc-legacy-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: legacy, userName: 'Legacy', now: 10 });

    const insertWaiting = getRoomDb().prepare(
      `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertWaiting.run(roomId, 'peer-a', 'Legacy A', '#111111', 10, legacy);
    insertWaiting.run(roomId, 'peer-b', 'Legacy B', '#222222', 10, legacy);
    insertWaiting.run(roomId, 'peer-unbound', 'Unbound', '#333333', 10, null);

    const response = await handleWaitingGet(getRoomDb(), roomId, getWaiting(roomId, owner));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      waitingPeers: Array<{
        peerId: string;
        accountId: string;
        userName: string;
        color: string;
        requestedAt: number;
      }>;
    };
    expect(body.waitingPeers).toEqual([
      {
        peerId: 'peer-a',
        accountId: legacy,
        userName: 'Legacy A',
        color: '#111111',
        requestedAt: 10,
      },
    ]);
  });
});

describe('waiting handler DELETE', () => {
  it('requires a peer id', async () => {
    const roomId = `waiting-delete-no-peer-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const response = await handleWaitingDelete(getRoomDb(), roomId, deleteWaiting(roomId, owner));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'peerId is required' });
  });

  it('requires an account', async () => {
    const roomId = `waiting-delete-no-account-${crypto.randomUUID()}`;

    const response = await handleWaitingDelete(
      getRoomDb(),
      roomId,
      deleteWaiting(roomId, undefined, 'peer-x'),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Account required' });
  });

  it('returns 404 for a peer that is not bound to an account', async () => {
    const roomId = `waiting-delete-unbound-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const response = await handleWaitingDelete(
      getRoomDb(),
      roomId,
      deleteWaiting(roomId, owner, 'ghost-peer'),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Peer not bound to an account' });
  });

  it('forbids a non-owner from removing another account', async () => {
    const roomId = `waiting-delete-forbidden-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    requestAccess(getRoomDb(), { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(getRoomDb(), roomId, editor, { role: 'editor' });
    const join = await joinAsWaitingGuest(roomId, guest);

    const response = await handleWaitingDelete(
      getRoomDb(),
      roomId,
      deleteWaiting(roomId, editor, join.peerId),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
    expect(
      getRoomDb()
        .prepare(`SELECT COUNT(*) AS n FROM waiting_peers WHERE room_id = ? AND peer_id = ?`)
        .get(roomId, join.peerId),
    ).toEqual({ n: 1 });
  });

  it('lets a waiting account leave the queue itself', async () => {
    const roomId = `waiting-delete-self-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    const join = await joinAsWaitingGuest(roomId, guest);

    const response = await handleWaitingDelete(
      getRoomDb(),
      roomId,
      deleteWaiting(roomId, guest, join.peerId),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(
      getRoomDb()
        .prepare(`SELECT COUNT(*) AS n FROM waiting_peers WHERE room_id = ? AND peer_id = ?`)
        .get(roomId, join.peerId),
    ).toEqual({ n: 0 });
    expect(
      getRoomDb()
        .prepare(`SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND account_id = ?`)
        .get(roomId, guest),
    ).toEqual({ n: 0 });
  });

  it('lets the owner remove another account from the queue', async () => {
    const roomId = `waiting-delete-owner-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const guest = `acc-guest-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    const join = await joinAsWaitingGuest(roomId, guest);

    const response = await handleWaitingDelete(
      getRoomDb(),
      roomId,
      deleteWaiting(roomId, owner, join.peerId),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(
      getRoomDb()
        .prepare(`SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND account_id = ?`)
        .get(roomId, guest),
    ).toEqual({ n: 0 });
    expect(
      getRoomDb()
        .prepare(`SELECT COUNT(*) AS n FROM waiting_peers WHERE room_id = ? AND account_id = ?`)
        .get(roomId, guest),
    ).toEqual({ n: 0 });
  });
});

describe('waiting handler POST', () => {
  it('returns 400 for a body that is not JSON', async () => {
    const roomId = `waiting-post-malformed-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);

    const response = await handleWaitingPost(
      getRoomDb(),
      roomId,
      postWaiting(roomId, owner, '{invalid json'),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('rejects one waiting peer and approves another in the same list', async () => {
    const roomId = `waiting-post-actions-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const rejectedGuest = `acc-rejected-${crypto.randomUUID()}`;
    const approvedGuest = `acc-approved-${crypto.randomUUID()}`;
    await createOwnedRoom(roomId, owner);
    const rejected = await joinAsWaitingGuest(roomId, rejectedGuest);
    const approved = await joinAsWaitingGuest(roomId, approvedGuest);

    const rejectedResponse = await handleWaitingPost(
      getRoomDb(),
      roomId,
      postWaiting(roomId, owner, { peerId: rejected.peerId, action: 'reject' }),
    );

    expect(rejectedResponse.status).toBe(200);
    expect(await rejectedResponse.json()).toEqual({
      success: true,
      bannedPeer: { accountId: rejectedGuest },
    });
    expect(getGrantRole(getRoomDb(), roomId, rejectedGuest)).toBe('banned');

    const approvedResponse = await handleWaitingPost(
      getRoomDb(),
      roomId,
      postWaiting(roomId, owner, { peerId: approved.peerId, action: 'approve' }),
    );

    expect(approvedResponse.status).toBe(200);
    expect(await approvedResponse.json()).toMatchObject({ success: true });
    expect(getGrantRole(getRoomDb(), roomId, approvedGuest)).toBe('editor');
  });
});
