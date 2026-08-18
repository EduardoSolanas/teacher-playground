import { describe, expect, it } from 'vitest';
import {
  handleRoomPost,
  handleRoomGet,
  handleRoomSettings,
  handleRoomSettingsGet,
  handleRoomDelete,
} from './room';
import { getRoomDb } from '../roomDb';
import { getRoomAllowFirstUserHost, getRoomHostPeerId, deleteRoomScopedData } from '../roomSchema';
import { approveAccount, getGrantRole, requestAccess } from '../membership';

const ROOM_SCOPED_TABLES = [
  'rooms',
  'room_members',
  'room_presence',
  'waiting_peers',
  'kicked_peers',
] as const;

function scopedCounts(db: ReturnType<typeof getRoomDb>, roomId: string) {
  return Object.fromEntries(
    ROOM_SCOPED_TABLES.map((table) => [
      table,
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE room_id = ?`).get(roomId) as { n: number }).n,
    ]),
  ) as Record<(typeof ROOM_SCOPED_TABLES)[number], number>;
}

function seedEveryRoomScopedTable(
  db: ReturnType<typeof getRoomDb>,
  roomId: string,
  now = Date.now(),
) {
  db.prepare(
    `INSERT INTO rooms (room_id, elements, viewport, max_users, host_peer_id, name,
                        allow_first_user_host, created_at, updated_at)
     VALUES (?, '[]', '{"x":0,"y":0,"zoom":1}', 3, null, ?, 0, ?, ?)`,
  ).run(roomId, roomId, now, now);
  db.prepare(
    `INSERT INTO room_members (
       room_id, account_id, role, display_name, email, requested_at, created_at, updated_at, expires_at
     ) VALUES (?, ?, 'owner', 'Ada', 'ada@example.com', NULL, ?, ?, NULL)`,
  ).run(roomId, `acc-${roomId}`, now, now);
  db.prepare(
    `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen, account_id)
     VALUES (?, ?, 'Ada', '#fff', ?, ?, ?)`,
  ).run(roomId, `peer-${roomId}`, now, now, `acc-${roomId}`);
  db.prepare(
    `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
     VALUES (?, ?, 'Eve', '#000', ?, ?)`,
  ).run(roomId, `wait-${roomId}`, now, `acc-wait-${roomId}`);
  db.prepare(
    `INSERT INTO kicked_peers (room_id, peer_id, kicked_at) VALUES (?, ?, ?)`,
  ).run(roomId, `kick-${roomId}`, now);
}

function postRequest(path: string, body: Record<string, unknown>, accountId?: string) {
  const url = new URL(`http://localhost/api/whiteboard/room/test${path}`);
  if (accountId) url.searchParams.set('accountId', accountId);
  return new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function getSettingsRequest(roomId: string, accountId?: string) {
  const url = new URL(`http://localhost/api/whiteboard/room/${roomId}/settings`);
  if (accountId) url.searchParams.set('accountId', accountId);
  return new Request(url, { method: 'GET' });
}

describe('room allowFirstUserHost setting', () => {
  it('defaults to off when a room is created without it', async () => {
    const db = getRoomDb();
    const roomId = `room-default-${crypto.randomUUID()}`;

    await handleRoomPost(db, roomId, postRequest('', { elements: [] }));

    expect(getRoomAllowFirstUserHost(db, roomId)).toBe(false);
  });

  it('stores the setting on the settings route', async () => {
    const db = getRoomDb();
    const roomId = `room-create-on-${crypto.randomUUID()}`;

    await handleRoomPost(db, roomId, postRequest('', { elements: [] }));
    const response = await handleRoomSettings(
      db,
      roomId,
      postRequest('/settings', { allowFirstUserHost: true }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ allowFirstUserHost: true });
    expect(getRoomAllowFirstUserHost(db, roomId)).toBe(true);
  });

  it('updates the setting on an existing room', async () => {
    const db = getRoomDb();
    const roomId = `room-update-${crypto.randomUUID()}`;
    await handleRoomPost(db, roomId, postRequest('', { elements: [] }));

    await handleRoomSettings(db, roomId, postRequest('/settings', { allowFirstUserHost: true }));
    expect(getRoomAllowFirstUserHost(db, roomId)).toBe(true);

    await handleRoomSettings(db, roomId, postRequest('/settings', { allowFirstUserHost: false }));
    expect(getRoomAllowFirstUserHost(db, roomId)).toBe(false);
  });

  it('leaves the setting untouched when a scene write omits it', async () => {
    const db = getRoomDb();
    const roomId = `room-omit-${crypto.randomUUID()}`;
    await handleRoomPost(db, roomId, postRequest('', { elements: [] }));
    await handleRoomSettings(db, roomId, postRequest('/settings', { allowFirstUserHost: true }));

    await handleRoomPost(db, roomId, postRequest('', { elements: [] }));

    expect(getRoomAllowFirstUserHost(db, roomId)).toBe(true);
  });

  it('reports the setting on read', async () => {
    const db = getRoomDb();
    const roomId = `room-read-${crypto.randomUUID()}`;
    await handleRoomPost(db, roomId, postRequest('', { elements: [] }));
    await handleRoomSettings(db, roomId, postRequest('/settings', { allowFirstUserHost: true }));

    const response = await handleRoomGet(
      db,
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}`),
    );

    expect(await response.json()).toMatchObject({ allowFirstUserHost: true });
  });

  it('rejects a non-boolean setting', async () => {
    const db = getRoomDb();
    const roomId = `room-bad-${crypto.randomUUID()}`;
    await handleRoomPost(db, roomId, postRequest('', { elements: [] }));

    const response = await handleRoomSettings(
      db,
      roomId,
      postRequest('/settings', { allowFirstUserHost: 'yes' }),
    );

    expect(response.status).toBe(400);
  });

  it('rejects settings fields on the scene route with 400', async () => {
    const db = getRoomDb();
    const roomId = `room-scene-mix-${crypto.randomUUID()}`;
    await handleRoomPost(db, roomId, postRequest('', { elements: [] }));

    const mixed = await handleRoomPost(
      db,
      roomId,
      postRequest('', { elements: [], maxUsers: 9, name: 'Stolen' }),
    );
    expect(mixed.status).toBe(400);

    const read = await handleRoomGet(
      db,
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}`),
    );
    expect(await read.json()).toMatchObject({ name: null, maxUsers: 3, elements: [] });
  });

  it('rejects scene fields on the settings route with 400', async () => {
    const db = getRoomDb();
    const roomId = `room-settings-mix-${crypto.randomUUID()}`;
    await handleRoomPost(db, roomId, postRequest('', { elements: [{ id: 'keep' }] }));

    const mixed = await handleRoomSettings(
      db,
      roomId,
      postRequest('/settings', { maxUsers: 5, elements: [{ id: 'stolen' }] }),
    );
    expect(mixed.status).toBe(400);

    const read = await handleRoomGet(
      db,
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}`),
    );
    expect(await read.json()).toMatchObject({ maxUsers: 3, elements: [{ id: 'keep' }] });
  });

  it('refuses settings changes from a non-owner when an account is present', async () => {
    const db = getRoomDb();
    const roomId = `room-settings-authz-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;

    await handleRoomPost(
      db,
      roomId,
      postRequest('', { elements: [] }, owner),
    );
    await handleRoomSettings(
      db,
      roomId,
      postRequest('/settings', { name: 'Original', maxUsers: 3 }, owner),
    );
    requestAccess(db, { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(db, roomId, editor, { role: 'editor' });

    const denied = await handleRoomSettings(
      db,
      roomId,
      postRequest('/settings', { name: 'Stolen', maxUsers: 9 }, editor),
    );
    expect(denied.status).toBe(403);

    const read = await handleRoomGet(
      db,
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}`),
    );
    expect(await read.json()).toMatchObject({ name: 'Original', maxUsers: 3 });
  });

  it('returns a generic 500 body when storage throws', async () => {
    const db = {
      prepare() {
        throw new Error(
          'SQLITE_ERROR teacher@example.com token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig {"elements":[{"id":"el-1"}]}',
        );
      },
    };

    const response = await handleRoomGet(
      db as never,
      'room-x',
      new Request('http://localhost/api/whiteboard/room/room-x'),
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(body)).not.toContain('SQLITE_ERROR');
    expect(JSON.stringify(body)).not.toContain('teacher@example.com');
    expect(JSON.stringify(body)).not.toContain('el-1');
  });
});

describe('duplicate room creation', () => {
  it('does not transfer ownership when a second account posts a scene to an existing room', async () => {
    const db = getRoomDb();
    const roomId = `room-preclaimed-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const outsider = `acc-outsider-${crypto.randomUUID()}`;

    const created = await handleRoomPost(
      db,
      roomId,
      postRequest('', { elements: [{ id: 'original' }] }, owner),
    );
    expect(created.status).toBe(200);
    await handleRoomSettings(
      db,
      roomId,
      postRequest('/settings', { hostPeerId: 'host-owner' }, owner),
    );

    const denied = await handleRoomPost(
      db,
      roomId,
      postRequest('', { elements: [{ id: 'stolen' }] }, outsider),
    );
    expect(denied.status).toBe(409);

    expect(getGrantRole(db, roomId, owner)).toBe('owner');
    expect(getGrantRole(db, roomId, outsider)).toBeNull();
    expect(getRoomHostPeerId(db, roomId)).toBe('host-owner');
    const read = await handleRoomGet(
      db,
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}`),
    );
    expect(await read.json()).toMatchObject({
      elements: [{ id: 'original' }],
      hostPeerId: 'host-owner',
    });
  });

  it('lets the owner update the scene on the same route', async () => {
    const db = getRoomDb();
    const roomId = `room-owner-scene-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;

    await handleRoomPost(db, roomId, postRequest('', { elements: [] }, owner));
    const updated = await handleRoomPost(
      db,
      roomId,
      postRequest('', { elements: [{ id: 'keep' }] }, owner),
    );

    expect(updated.status).toBe(200);
    expect(getGrantRole(db, roomId, owner)).toBe('owner');
    const read = await handleRoomGet(
      db,
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}`),
    );
    expect(await read.json()).toMatchObject({ elements: [{ id: 'keep' }] });
  });

  it('lets an editor update the scene without becoming owner', async () => {
    const db = getRoomDb();
    const roomId = `room-editor-scene-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const editor = `acc-editor-${crypto.randomUUID()}`;

    await handleRoomPost(db, roomId, postRequest('', { elements: [] }, owner));
    requestAccess(db, { roomId, accountId: editor, userName: 'Ed' });
    approveAccount(db, roomId, editor, { role: 'editor' });

    const updated = await handleRoomPost(
      db,
      roomId,
      postRequest('', { elements: [{ id: 'from-editor' }] }, editor),
    );

    expect(updated.status).toBe(200);
    expect(getGrantRole(db, roomId, owner)).toBe('owner');
    expect(getGrantRole(db, roomId, editor)).toBe('editor');
  });

  it('returns 409 when a create INSERT collides with an existing rooms row', async () => {
    const inner = getRoomDb();
    const roomId = `room-insert-race-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;
    const outsider = `acc-outsider-${crypto.randomUUID()}`;

    await handleRoomPost(inner, roomId, postRequest('', { elements: [{ id: 'original' }] }, owner));

    const db = {
      prepare(sql: string) {
        const stmt = inner.prepare(sql);
        if (sql.includes('SELECT created_at FROM rooms')) {
          return { get: () => undefined };
        }
        return stmt;
      },
      exec: inner.exec.bind(inner),
      transaction: inner.transaction.bind(inner),
    };

    const denied = await handleRoomPost(
      db as never,
      roomId,
      postRequest('', { elements: [{ id: 'stolen' }] }, outsider),
    );
    expect(denied.status).toBe(409);
    expect(getGrantRole(inner, roomId, owner)).toBe('owner');
    expect(getGrantRole(inner, roomId, outsider)).toBeNull();
  });
});

describe('GET room settings', () => {
  it('returns settings fields without scene data and does not mutate storage', async () => {
    const db = getRoomDb();
    const roomId = `room-settings-get-${crypto.randomUUID()}`;
    const owner = `acc-owner-${crypto.randomUUID()}`;

    await handleRoomPost(db, roomId, postRequest('', { elements: [{ id: 'secret' }] }, owner));
    await handleRoomSettings(
      db,
      roomId,
      postRequest('/settings', { name: 'Lesson', maxUsers: 4, allowFirstUserHost: true }, owner),
    );

    const before = scopedCounts(db, roomId);
    const response = await handleRoomSettingsGet(db, roomId, getSettingsRequest(roomId, owner));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      name: 'Lesson',
      maxUsers: 4,
      allowFirstUserHost: true,
    });
    expect(body).toHaveProperty('updated_at');
    expect(body).toHaveProperty('created_at');
    expect(body).not.toHaveProperty('elements');
    expect(body).not.toHaveProperty('viewport');
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(scopedCounts(db, roomId)).toEqual(before);
  });

  it('returns 404 when the room is missing', async () => {
    const db = getRoomDb();
    const response = await handleRoomSettingsGet(
      db,
      'missing-room',
      getSettingsRequest('missing-room'),
    );
    expect(response.status).toBe(404);
  });
});

describe('atomic room deletion', () => {
  it('removes every room-scoped table in one call and leaves other rooms intact', async () => {
    const db = getRoomDb();
    const doomed = `delete-doomed-${crypto.randomUUID()}`;
    const keep = `delete-keep-${crypto.randomUUID()}`;
    seedEveryRoomScopedTable(db, doomed);
    seedEveryRoomScopedTable(db, keep);

    expect(scopedCounts(db, doomed)).toEqual({
      rooms: 1,
      room_members: 1,
      room_presence: 1,
      waiting_peers: 1,
      kicked_peers: 1,
    });

    const response = await handleRoomDelete(
      db,
      doomed,
      new Request(`http://localhost/api/whiteboard/room/${doomed}`, { method: 'DELETE' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });

    expect(scopedCounts(db, doomed)).toEqual({
      rooms: 0,
      room_members: 0,
      room_presence: 0,
      waiting_peers: 0,
      kicked_peers: 0,
    });
    expect(scopedCounts(db, keep)).toEqual({
      rooms: 1,
      room_members: 1,
      room_presence: 1,
      waiting_peers: 1,
      kicked_peers: 1,
    });
  });

  it('rolls back earlier table deletes when a later delete throws', () => {
    const inner = getRoomDb();
    const roomId = `delete-rollback-${crypto.randomUUID()}`;
    seedEveryRoomScopedTable(inner, roomId);

    let deletes = 0;
    const db = {
      prepare(sql: string) {
        const stmt = inner.prepare(sql);
        if (!sql.startsWith('DELETE FROM')) return stmt;
        return {
          run(...args: unknown[]) {
            deletes += 1;
            if (deletes >= 3) throw new Error('injected');
            return stmt.run(...args);
          },
        };
      },
      exec: inner.exec.bind(inner),
      transaction: inner.transaction.bind(inner),
    };

    expect(() => deleteRoomScopedData(db as never, roomId)).toThrow('injected');
    expect(scopedCounts(inner, roomId)).toEqual({
      rooms: 1,
      room_members: 1,
      room_presence: 1,
      waiting_peers: 1,
      kicked_peers: 1,
    });
  });
});
