import { beforeEach, describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { RoomDO } from './RoomDO';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';

const ROOM_SCOPED_TABLES = [
  'rooms',
  'room_members',
  'room_presence',
  'waiting_peers',
  'kicked_peers',
  'room_access',
  'access_requests',
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
  instance.db.prepare(
    `INSERT INTO room_access (room_id, token_hash, role, user_name, email, created_at, expires_at)
     VALUES (?, 'hash-1', 'creator', 'Ada', 'ada@example.com', ?, NULL)`,
  ).run(roomId, now);
  instance.db.prepare(
    `INSERT INTO access_requests (room_id, request_id, token_hash, user_name, email, requested_at)
     VALUES (?, 'req-1', 'reqhash-1', 'Eve', 'eve@example.com', ?)`,
  ).run(roomId, now);
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
        room_access: 1,
        access_requests: 1,
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
        room_access: 0,
        access_requests: 0,
      });
    });

    expect(closed.done).toBe(true);
    expect(closed.code).toBe(4404);
  });
});
