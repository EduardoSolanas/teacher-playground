import { beforeEach, describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type { RoomDO } from './RoomDO';
import { getIdentityObject, type IdentityDO } from './IdentityDO';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';
import { DESTRUCTIVE_FRESH_MS } from '../lib/identity/sessionStore';
import { replaceSharedElements } from '../lib/whiteboard/yjsDoc';
import { ROOM_IDLE_TTL_MS } from '../lib/whiteboard/roomSchema';

const SOCKET_EVENT_DEADLINE_MS = 15_000;

const ROOM_SCOPED_TABLES = [
  'rooms',
  'room_members',
  'room_presence',
  'waiting_peers',
  'kicked_peers',
] as const;

function roomStub(roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

function scopedCounts(instance: RoomDO, roomId: string) {
  return Object.fromEntries(
    ROOM_SCOPED_TABLES.map((table) => [
      table,
      (instance.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE room_id = ?`)
        .get(roomId) as { n: number }).n,
    ]),
  );
}

function seedLeftoverTables(instance: RoomDO, roomId: string, now = Date.now()) {
  instance.db.prepare(
    `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen, account_id)
     VALUES (?, 'peer-1', 'Ada', '#fff', ?, ?, 'acc-1')`,
  ).run(roomId, now, now);
  instance.db.prepare(
    `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
     VALUES (?, 'wait-1', 'Eve', '#000', ?, 'acc-wait')`,
  ).run(roomId, now);
  instance.db.prepare(
    `INSERT INTO kicked_peers (room_id, peer_id, kicked_at) VALUES (?, 'kick-1', ?)`,
  ).run(roomId, now);
}

function boardUpdateFrame(): Uint8Array {
  const doc = new Y.Doc();
  replaceSharedElements(doc, doc.getArray('elements'), [
    { id: 'delete-me', type: 'rectangle', x: 10, y: 20 },
  ]);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(encoder);
}

function syncStepOneFrame(): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep1(encoder, new Y.Doc());
  return encoding.toUint8Array(encoder);
}

function nextBinaryMessage(ws: WebSocket): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const handleMessage = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      clearTimeout(timer);
      ws.removeEventListener('message', handleMessage);
      resolve(event.data);
    };
    timer = setTimeout(() => {
      ws.removeEventListener('message', handleMessage);
      reject(new Error('timed out waiting for binary frame'));
    }, SOCKET_EVENT_DEADLINE_MS);
    ws.addEventListener('message', handleMessage);
  });
}

async function openRoomSocket(owner: LocalAuthSession, roomId: string): Promise<WebSocket> {
  const upgrade = await authenticatedFetch(`/signaling?room=${roomId}`, owner, {
    headers: { Upgrade: 'websocket' },
  });
  expect(upgrade.status).toBe(101);
  const ws = upgrade.webSocket;
  if (!ws) throw new Error('no webSocket on response');
  ws.accept();
  ws.send(Uint8Array.from(boardUpdateFrame()).buffer);
  const synced = nextBinaryMessage(ws);
  ws.send(Uint8Array.from(syncStepOneFrame()).buffer);
  await synced;
  return ws;
}

function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => ws.addEventListener('close', () => resolve(), { once: true }));
}

async function assertBoardStateDeleted(roomId: string): Promise<void> {
  await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
    expect(scopedCounts(instance, roomId)).toEqual({
      rooms: 0,
      room_members: 0,
      room_presence: 0,
      waiting_peers: 0,
      kicked_peers: 0,
    });
    expect(
      instance.db.prepare(`SELECT 1 FROM room_tombstones WHERE room_id = ?`).get(roomId),
    ).toBeDefined();
    expect(
      await (instance as unknown as { ctx: DurableObjectState }).ctx.storage.get(`ydoc:${roomId}`),
    ).toBeUndefined();
    expect(
      await (instance as unknown as { ctx: DurableObjectState }).ctx.storage.get(`ydoc-projection:${roomId}`),
    ).toBeUndefined();
  });
}

describe('atomic room deletion in RoomDO', () => {
  let owner: LocalAuthSession;

  beforeEach(async () => {
    owner = await bootstrapLocalSession(`delete-owner-${crypto.randomUUID()}`);
  });

  it('purges every room-scoped table and closes live signaling sockets', async () => {
    const roomId = `delete-atomic-${crypto.randomUUID()}`;
    const created = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    });
    expect(created.status).toBe(200);

    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      seedLeftoverTables(instance, roomId);
      expect(scopedCounts(instance, roomId)).toEqual({
        rooms: 1,
        room_members: 1,
        room_presence: 1,
        waiting_peers: 1,
        kicked_peers: 1,
      });
    });

    const upgrade = await authenticatedFetch(`/signaling?room=${roomId}`, owner, {
      headers: { Upgrade: 'websocket' },
    });
    expect(upgrade.status).toBe(101);
    const ws = upgrade.webSocket;
    if (!ws) throw new Error('no webSocket on response');
    ws.accept();
    const closed = { done: false, code: 0 };
    ws.addEventListener('close', (event: CloseEvent) => {
      closed.done = true;
      closed.code = event.code;
    }, { once: true });

    const del = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);

    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      expect(scopedCounts(instance, roomId)).toEqual({
        rooms: 0,
        room_members: 0,
        room_presence: 0,
        waiting_peers: 0,
        kicked_peers: 0,
      });
    });

    expect(closed.done).toBe(true);
    expect(closed.code).toBe(4404);
  });

  it('deletes the cached and stored board before the delete-triggered close can flush it', async () => {
    const roomId = `delete-board-${crypto.randomUUID()}`;
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    const ws = await openRoomSocket(owner, roomId);
    const closed = waitForClose(ws);
    const del = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    await closed;

    await assertBoardStateDeleted(roomId);
    await runDurableObjectAlarm(roomStub(roomId));
    await assertBoardStateDeleted(roomId);
  });

  it('does not let a frame already in flight recreate board storage after deletion', async () => {
    const roomId = `delete-in-flight-${crypto.randomUUID()}`;
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    const ws = await openRoomSocket(owner, roomId);
    const closed = waitForClose(ws);
    ws.send(Uint8Array.from(boardUpdateFrame()).buffer);
    const del = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    await closed;

    await runDurableObjectAlarm(roomStub(roomId));
    await assertBoardStateDeleted(roomId);
  });

  it('rejects recreate after delete so old grants cannot be restored', async () => {
    const roomId = `tombstone-recreate-${crypto.randomUUID()}`;

    const created = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ hasCreatorGrant: true });

    const del = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);

    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      expect(
        instance.db
          .prepare(`SELECT 1 FROM room_tombstones WHERE room_id = ?`)
          .get(roomId),
      ).toBeDefined();
    });

    const recreate = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    });
    expect(recreate.status).toBe(410);
    expect(await recreate.json()).toEqual({ error: 'Room deleted' });
    expect(recreate.headers.get('Cache-Control')).toBe('no-store');

    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      expect(scopedCounts(instance, roomId)).toEqual({
        rooms: 0,
        room_members: 0,
        room_presence: 0,
        waiting_peers: 0,
        kicked_peers: 0,
      });
      expect(
        instance.db
          .prepare(`SELECT 1 FROM room_tombstones WHERE room_id = ?`)
          .get(roomId),
      ).toBeDefined();
    });

    const get = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner);
    expect(get.status).toBe(410);

    const other = await bootstrapLocalSession(`tombstone-other-${crypto.randomUUID()}`);
    const otherRecreate = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, other, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    });
    expect(otherRecreate.status).toBe(410);
    expect(await otherRecreate.json()).toEqual({ error: 'Room deleted' });
  });
});

describe('RoomDO account erasure', () => {
  it('tombstones an owned room when the stamped owner posts /room/erasure', async () => {
    const owner = await bootstrapLocalSession(`erase-do-owner-${crypto.randomUUID()}`);
    const roomId = `erase-do-owner-${crypto.randomUUID()}`;
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    const erased = await roomStub(roomId).fetch(
      new Request(`https://room/room/erasure?roomId=${encodeURIComponent(roomId)}&accountId=${encodeURIComponent(owner.accountId)}`, {
        method: 'POST',
      }),
    );
    expect(erased.status).toBe(200);

    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      expect(scopedCounts(instance, roomId)).toEqual({
        rooms: 0,
        room_members: 0,
        room_presence: 0,
        waiting_peers: 0,
        kicked_peers: 0,
      });
    });
  });

  it('deletes an owned room board before erasure closes the live socket', async () => {
    const owner = await bootstrapLocalSession(`erase-board-owner-${crypto.randomUUID()}`);
    const roomId = `erase-board-owner-${crypto.randomUUID()}`;
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    const ws = await openRoomSocket(owner, roomId);
    const closed = waitForClose(ws);
    const erased = await roomStub(roomId).fetch(
      new Request(`https://room/room/erasure?roomId=${encodeURIComponent(roomId)}&accountId=${encodeURIComponent(owner.accountId)}`, {
        method: 'POST',
      }),
    );
    expect(erased.status).toBe(200);
    await closed;

    await assertBoardStateDeleted(roomId);
    await runDurableObjectAlarm(roomStub(roomId));
    await assertBoardStateDeleted(roomId);
  });

  it('removes a non-owner membership and leaves another account in another room', async () => {
    const owner = await bootstrapLocalSession(`erase-do-host-${crypto.randomUUID()}`);
    const member = await bootstrapLocalSession(`erase-do-member-${crypto.randomUUID()}`);
    const otherOwner = await bootstrapLocalSession(`erase-do-other-host-${crypto.randomUUID()}`);
    const otherMember = await bootstrapLocalSession(`erase-do-other-member-${crypto.randomUUID()}`);
    const roomId = `erase-do-joined-${crypto.randomUUID()}`;
    const otherRoomId = `erase-do-other-${crypto.randomUUID()}`;

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);
    expect((await authenticatedFetch(`/api/whiteboard/room/${otherRoomId}`, otherOwner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, member, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Member', email: 'member@example.com' }),
    })).status).toBe(201);
    expect((await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/requests/${member.accountId}`,
      owner,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role: 'peer' }),
      },
    )).status).toBe(200);

    expect((await authenticatedFetch(`/api/whiteboard/room/${otherRoomId}/requests`, otherMember, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Other', email: 'other@example.com' }),
    })).status).toBe(201);
    expect((await authenticatedFetch(
      `/api/whiteboard/room/${otherRoomId}/requests/${otherMember.accountId}`,
      otherOwner,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role: 'peer' }),
      },
    )).status).toBe(200);

    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      const now = Date.now();
      instance.db.prepare(
        `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen, account_id)
         VALUES (?, 'peer-member', 'Member', '#111', ?, ?, ?)`,
      ).run(roomId, now, now, member.accountId);
      instance.db.prepare(
        `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
         VALUES (?, 'wait-member', 'Member', '#111', ?, ?)`,
      ).run(roomId, now, member.accountId);
    });

    const outsider = await bootstrapLocalSession(`erase-do-outsider-${crypto.randomUUID()}`);
    const denied = await roomStub(roomId).fetch(
      new Request(`https://room/room/erasure?roomId=${encodeURIComponent(roomId)}&accountId=${encodeURIComponent(outsider.accountId)}`, {
        method: 'POST',
      }),
    );
    expect(denied.status).toBe(403);

    const erased = await roomStub(roomId).fetch(
      new Request(`https://room/room/erasure?roomId=${encodeURIComponent(roomId)}&accountId=${encodeURIComponent(member.accountId)}`, {
        method: 'POST',
      }),
    );
    expect(erased.status).toBe(200);

    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      expect(
        (instance.db.prepare(
          `SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND account_id = ?`,
        ).get(roomId, member.accountId) as { n: number }).n,
      ).toBe(0);
      expect(
        (instance.db.prepare(
          `SELECT COUNT(*) AS n FROM room_presence WHERE room_id = ? AND account_id = ?`,
        ).get(roomId, member.accountId) as { n: number }).n,
      ).toBe(0);
      expect(
        (instance.db.prepare(
          `SELECT COUNT(*) AS n FROM waiting_peers WHERE room_id = ? AND account_id = ?`,
        ).get(roomId, member.accountId) as { n: number }).n,
      ).toBe(0);
      expect(
        (instance.db.prepare(
          `SELECT role FROM room_members WHERE room_id = ? AND account_id = ?`,
        ).get(roomId, owner.accountId) as { role: string }).role,
      ).toBe('owner');
    });

    await runInDurableObject(roomStub(otherRoomId), (instance: RoomDO) => {
      const row = instance.db.prepare(
        `SELECT display_name AS displayName, email, role
         FROM room_members WHERE room_id = ? AND account_id = ?`,
      ).get(otherRoomId, otherMember.accountId) as {
        displayName: string | null;
        email: string | null;
        role: string;
      };
      expect(row).toEqual({
        displayName: 'Other',
        email: 'other@example.com',
        role: 'editor',
      });
    });
  });
});

describe('idle room board purge', () => {
  it('deletes the cached and stored board when the idle TTL creates a tombstone', async () => {
    const owner = await bootstrapLocalSession(`idle-board-owner-${crypto.randomUUID()}`);
    const roomId = `idle-board-${crypto.randomUUID()}`;
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    const ws = await openRoomSocket(owner, roomId);
    const closed = waitForClose(ws);
    ws.close();
    await closed;
    await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
      expect(
        await (instance as unknown as { ctx: DurableObjectState }).ctx.storage.get(`ydoc:${roomId}`),
      ).toBeDefined();
      instance.db.prepare(`UPDATE rooms SET updated_at = ? WHERE room_id = ?`)
        .run(Date.now() - ROOM_IDLE_TTL_MS - 60_000, roomId);
    });

    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => instance.alarm());
    await assertBoardStateDeleted(roomId);
    await runDurableObjectAlarm(roomStub(roomId));
    await assertBoardStateDeleted(roomId);
  });
});

async function ageSessionCreatedAt(accountId: string, ageMs: number): Promise<void> {
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  await runInDurableObject(identity, (instance: IdentityDO) => {
    instance.db
      .prepare(
        `UPDATE sessions SET created_at = created_at - ?
         WHERE account_id = ? AND revoked_at IS NULL`,
      )
      .run(ageMs, accountId);
  });
}

describe('fresh proof for destructive room DELETE', () => {
  it('rejects a 6-minute-old session cookie without confirm and leaves the room', async () => {
    const owner = await bootstrapLocalSession(`stale-delete-${crypto.randomUUID()}`);
    const roomId = `stale-delete-${crypto.randomUUID()}`;
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    await ageSessionCreatedAt(owner.accountId, DESTRUCTIVE_FRESH_MS + 60_000);

    const del = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'DELETE',
    });
    expect(del.status).toBe(403);
    expect(await del.json()).toEqual({ error: 'Reauthentication required' });

    const still = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner);
    expect(still.status).toBe(200);
  });

  it('allows DELETE after Access-bound session confirm on an old cookie', async () => {
    const owner = await bootstrapLocalSession(`confirm-delete-${crypto.randomUUID()}`);
    const roomId = `confirm-delete-${crypto.randomUUID()}`;
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    await ageSessionCreatedAt(owner.accountId, DESTRUCTIVE_FRESH_MS + 60_000);

    const confirm = await authenticatedFetch('/auth/session/confirm', owner, {
      method: 'POST',
    });
    expect(confirm.status).toBe(200);

    const del = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);

    const gone = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner);
    expect(gone.status).toBe(410);
  });

  it('allows DELETE on a just-issued session without confirm', async () => {
    const owner = await bootstrapLocalSession(`fresh-delete-${crypto.randomUUID()}`);
    const roomId = `fresh-delete-${crypto.randomUUID()}`;
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    const del = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);

    const gone = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner);
    expect(gone.status).toBe(410);
  });

  it('does not require fresh proof for presence DELETE', async () => {
    const owner = await bootstrapLocalSession(`stale-presence-${crypto.randomUUID()}`);
    const roomId = `stale-presence-${crypto.randomUUID()}`;
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    const peerId = `peer-${crypto.randomUUID()}`;
    const join = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId, userName: 'Ada', color: '#3498db' }),
    });
    expect(join.status).toBe(200);
    const issuedPeerId = (await join.json() as { peerId: string }).peerId;

    await ageSessionCreatedAt(owner.accountId, DESTRUCTIVE_FRESH_MS + 60_000);

    const leave = await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/presence?peerId=${encodeURIComponent(issuedPeerId)}`,
      owner,
      { method: 'DELETE' },
    );
    expect(leave.status).toBe(200);
  });
});

describe('room deletion purges guest accounts', () => {
  function identity() {
    return getIdentityObject(env.IDENTITY);
  }

  async function issueGuest(roomId: string, displayName: string): Promise<{ accountId: string }> {
    const response = await identity().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, displayName }),
    });
    expect(response.status).toBe(201);
    return response.json() as Promise<{ accountId: string }>;
  }

  function accountAndSessionCounts(accountId: string) {
    return runInDurableObject(identity(), (instance: IdentityDO) => ({
      accounts: (instance.db
        .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE account_id = ?`)
        .get(accountId) as { n: number }).n,
      sessions: (instance.db
        .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?`)
        .get(accountId) as { n: number }).n,
    }));
  }

  it('DELETE /api/whiteboard/room/:id purges that room\'s guests and leaves others intact', async () => {
    const ownerA = await bootstrapLocalSession(`guest-purge-owner-a-${crypto.randomUUID()}`);
    const ownerB = await bootstrapLocalSession(`guest-purge-owner-b-${crypto.randomUUID()}`);
    const roomA = `guest-purge-a-${crypto.randomUUID()}`;
    const roomB = `guest-purge-b-${crypto.randomUUID()}`;

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomA}`, ownerA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomB}`, ownerB, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    const guestA = await issueGuest(roomA, 'Guest A');
    const guestB = await issueGuest(roomB, 'Guest B');

    const del = await authenticatedFetch(`/api/whiteboard/room/${roomA}`, ownerA, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);

    const remainingA = await accountAndSessionCounts(guestA.accountId);
    const remainingB = await accountAndSessionCounts(guestB.accountId);
    const ownerACounts = await accountAndSessionCounts(ownerA.accountId);
    const ownerBCounts = await accountAndSessionCounts(ownerB.accountId);

    expect(remainingA).toEqual({ accounts: 0, sessions: 0 });
    expect(remainingB).toEqual({ accounts: 1, sessions: 1 });
    expect(ownerACounts.accounts).toBe(1);
    expect(ownerACounts.sessions).toBeGreaterThan(0);
    expect(ownerBCounts.accounts).toBe(1);
  });
});
