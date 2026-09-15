import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import * as Y from 'yjs';
import { getElementsFromArray, replaceSharedElements } from '../lib/whiteboard/yjsDoc';
import { issueGuestPin } from '../lib/whiteboard/guestPin';
import type { RoomDO } from './RoomDO';
import { authenticatedFetch, bootstrapLocalSession } from '../test/workerAuth';

/*
 * Emptying the board is the owner's alone, checked on the server.
 *
 * A clear used to be an ordinary edit: the client emptied the shared array
 * itself and the deletion travelled like any other stroke, so anybody with a
 * socket could wipe a lesson and nothing on the server had an opinion about
 * it. Hiding the button was never going to be the answer, because the button
 * is not what does the deleting.
 *
 * A file of its own rather than a few more cases in roomDO.workers.test.ts:
 * that file is close enough to its isolate's limits that three extra sessions
 * pushed unrelated board tests into a stack overflow.
 */

async function createRoom(roomId: string, owner: Awaited<ReturnType<typeof bootstrapLocalSession>>) {
  const response = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ elements: [] }),
  });
  expect(response.ok).toBe(true);
}

function roomStub(roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

function docAccess(instance: RoomDO) {
  return instance as unknown as {
    getRoomDoc: (roomId: string) => Promise<Y.Doc>;
    flushDirtyDocs: () => Promise<void>;
  };
}

/** Writes elements straight into the room's shared document and flushes it. */
async function seedElements(roomId: string, elements: Array<Record<string, unknown>>) {
  await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
    const boxed = docAccess(instance);
    const doc = await boxed.getRoomDoc(roomId);
    replaceSharedElements(doc, doc.getArray('elements'), elements, 'seed');
    await boxed.flushDirtyDocs();
  });
}

/** Reads the room's shared elements back, flushing first so nothing is stale. */
async function boardElements(roomId: string) {
  return runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
    const boxed = docAccess(instance);
    await boxed.flushDirtyDocs();
    const doc = await boxed.getRoomDoc(roomId);
    return getElementsFromArray(doc.getArray('elements'));
  });
}

async function admitMember(owner: Awaited<ReturnType<typeof bootstrapLocalSession>>, member: Awaited<ReturnType<typeof bootstrapLocalSession>>, roomId: string) {
  expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, member, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userName: 'Member' }),
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
}

describe('clearing a board is owner-only', () => {
  it('lets the owner empty the room', async () => {
    const owner = await bootstrapLocalSession('clear-owner');
    await createRoom('clear-owned-room', owner);

    expect((await authenticatedFetch('/api/whiteboard/room/clear-owned-room/clear', owner, {
      method: 'POST',
    })).status).toBe(200);
  });

  it('refuses an admitted member who is not the owner', async () => {
    // Admitted, drawing, and still not allowed to empty the room out from
    // under everybody else in it.
    const owner = await bootstrapLocalSession('clear-member-owner');
    const member = await bootstrapLocalSession('clear-member-peer');
    const roomId = 'clear-member-room';
    await createRoom(roomId, owner);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, member, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Member' }),
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

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/clear`, member, {
      method: 'POST',
    })).status).toBe(403);
  });

  it('refuses somebody outside the room', async () => {
    const owner = await bootstrapLocalSession('clear-outsider-owner');
    const outsider = await bootstrapLocalSession('clear-outsider');
    await createRoom('clear-outsider-room', owner);

    expect((await authenticatedFetch('/api/whiteboard/room/clear-outsider-room/clear', outsider, {
      method: 'POST',
    })).status).toBe(403);
  });

  it('refuses a method the route does not offer', async () => {
    const owner = await bootstrapLocalSession('clear-method-owner');
    await createRoom('clear-method-room', owner);

    expect((await authenticatedFetch('/api/whiteboard/room/clear-method-room/clear', owner, {
      method: 'GET',
    })).status).toBe(403);
  });
});

describe('clearing one board is owner-only', () => {
  const GUEST = 'https://join.example.com';

  it('the owner clears one board and elements on other boards survive', async () => {
    const owner = await bootstrapLocalSession('clear-board-owner');
    const roomId = 'clear-board-room';
    await createRoom(roomId, owner);
    await seedElements(roomId, [
      { id: 'main-1', type: 'rectangle', boardId: 'main' },
      { id: 'unstamped-1', type: 'rectangle' },
      { id: 'other-1', type: 'rectangle', boardId: 'board-2' },
    ]);

    const cleared = await authenticatedFetch(`/api/whiteboard/room/${roomId}/clear`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ boardId: 'board-2' }),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true });

    // board-2 is gone; the stamped main-board element and the unstamped one
    // (an element without a stamp belongs to 'main') are both still standing.
    expect((await boardElements(roomId)).map((element) => element.id).sort())
      .toEqual(['main-1', 'unstamped-1']);
  });

  it('an invalid boardId is refused with 400 and clears nothing', async () => {
    const owner = await bootstrapLocalSession('clear-board-invalid-owner');
    const roomId = 'clear-board-invalid-room';
    await createRoom(roomId, owner);
    await seedElements(roomId, [
      { id: 'main-1', type: 'rectangle', boardId: 'main' },
      { id: 'other-1', type: 'rectangle', boardId: 'board-2' },
    ]);

    for (const boardId of [7, '', 'x'.repeat(65), '../main', '<script>']) {
      const refused = await authenticatedFetch(`/api/whiteboard/room/${roomId}/clear`, owner, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ boardId }),
      });
      expect(refused.status, `boardId ${JSON.stringify(boardId)}`).toBe(400);
      expect(await refused.json()).toHaveProperty('error');
    }

    const malformed = await authenticatedFetch(`/api/whiteboard/room/${roomId}/clear`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"boardId": ',
    });
    expect(malformed.status).toBe(400);

    expect((await boardElements(roomId)).map((element) => element.id))
      .toEqual(['main-1', 'other-1']);
  });

  it('a member cannot clear a single board', async () => {
    const owner = await bootstrapLocalSession('clear-board-member-owner');
    const member = await bootstrapLocalSession('clear-board-member');
    const roomId = 'clear-board-member-room';
    await createRoom(roomId, owner);
    await admitMember(owner, member, roomId);
    await seedElements(roomId, [
      { id: 'main-1', type: 'rectangle', boardId: 'main' },
      { id: 'other-1', type: 'rectangle', boardId: 'board-2' },
    ]);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/clear`, member, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ boardId: 'board-2' }),
    })).status).toBe(403);

    expect((await boardElements(roomId)).map((element) => element.id))
      .toEqual(['main-1', 'other-1']);
  });

  it('a guest cannot clear a single board', async () => {
    const owner = await bootstrapLocalSession('clear-board-guest-owner');
    const roomId = 'clear-board-guest-room';
    await createRoom(roomId, owner);
    await seedElements(roomId, [
      { id: 'main-1', type: 'rectangle', boardId: 'main' },
      { id: 'other-1', type: 'rectangle', boardId: 'board-2' },
    ]);

    const pin = await runInDurableObject(
      roomStub(roomId),
      (instance: RoomDO) => issueGuestPin(instance.db, roomId, Date.now()),
    );
    const guestAuth = await SELF.fetch(`${GUEST}/auth/guest`, {
      method: 'POST',
      headers: { Origin: GUEST, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, pin, displayName: 'Guest' }),
    });
    expect(guestAuth.status).toBe(200);
    const guestCookie = guestAuth.headers.get('set-cookie')?.split(';', 1)[0];
    expect(guestCookie).toBeTruthy();

    const cleared = await SELF.fetch(`${GUEST}/api/whiteboard/room/${roomId}/clear`, {
      method: 'POST',
      headers: {
        Origin: GUEST,
        'content-type': 'application/json',
        Cookie: guestCookie!,
      },
      body: JSON.stringify({ boardId: 'board-2' }),
    });
    expect(cleared.status).toBe(403);

    expect((await boardElements(roomId)).map((element) => element.id))
      .toEqual(['main-1', 'other-1']);
  });

  it('clearing with no body still wipes the whole board', async () => {
    const owner = await bootstrapLocalSession('clear-board-legacy-owner');
    const roomId = 'clear-board-legacy-room';
    await createRoom(roomId, owner);
    await seedElements(roomId, [
      { id: 'main-1', type: 'rectangle', boardId: 'main' },
      { id: 'other-1', type: 'rectangle', boardId: 'board-2' },
    ]);

    const cleared = await authenticatedFetch(`/api/whiteboard/room/${roomId}/clear`, owner, {
      method: 'POST',
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true });

    expect(await boardElements(roomId)).toEqual([]);
  });
});
