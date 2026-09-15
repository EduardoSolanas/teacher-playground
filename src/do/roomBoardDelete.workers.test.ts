import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import * as Y from 'yjs';
import { getElementsFromArray, replaceSharedElements } from '../lib/whiteboard/yjsDoc';
import { issueGuestPin } from '../lib/whiteboard/guestPin';
import type { RoomDO } from './RoomDO';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';

/*
 * Deleting one board removes its tab and every element behind it for the
 * whole room, so it is the owner's alone and checked on the server, exactly
 * as clearing is.
 *
 * A file of its own rather than more cases in roomClearAuth.workers.test.ts,
 * for the reason that file gives: that suite sits close to its isolate's
 * limits, and three more sessions pushed unrelated board tests into a stack
 * overflow.
 */

async function createRoom(roomId: string, owner: LocalAuthSession) {
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
    docs: Map<string, Y.Doc>;
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

/** Writes a boardsMeta tab entry straight into the room's shared document and flushes it. */
async function seedBoardMeta(roomId: string, boardId: string, name: string, order: number) {
  await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
    const boxed = docAccess(instance);
    const doc = await boxed.getRoomDoc(roomId);
    doc.getMap('boardsMeta').set(boardId, { name, order, createdAt: Date.now() });
    await boxed.flushDirtyDocs();
  });
}

/**
 * Reads the room back from storage: flushes, evicts the in-memory document,
 * and rehydrates it from the snapshot, so what this returns is what a fresh
 * object -- or a peer opening the room later -- would see.
 */
async function storedBoardState(roomId: string) {
  return runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
    const boxed = docAccess(instance);
    await boxed.flushDirtyDocs();
    boxed.docs.delete(roomId);
    const doc = await boxed.getRoomDoc(roomId);
    return {
      meta: Object.fromEntries(doc.getMap('boardsMeta').entries()) as Record<string, unknown>,
      elementIds: getElementsFromArray(doc.getArray('elements'))
        .map((element) => element.id)
        .sort(),
    };
  });
}

async function admitMember(owner: LocalAuthSession, member: LocalAuthSession, roomId: string) {
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

/** POSTs the board-delete route. The body is raw so the refusals can send malformed JSON. */
function postDeleteBoard(roomId: string, session: LocalAuthSession, body: string) {
  return authenticatedFetch(`/api/whiteboard/room/${roomId}/boards/delete`, session, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('deleting a board is owner-only', () => {
  it('the owner deletes a board and its tab entry and elements are gone', async () => {
    const owner = await bootstrapLocalSession('board-delete-owner');
    const roomId = 'board-delete-room';
    await createRoom(roomId, owner);
    await seedBoardMeta(roomId, 'board-2', 'Board 2', 1);
    await seedBoardMeta(roomId, 'board-3', 'Board 3', 2);
    await seedElements(roomId, [
      { id: 'gone-1', type: 'rectangle', boardId: 'board-2' },
      { id: 'kept-1', type: 'rectangle', boardId: 'main' },
      { id: 'elsewhere-1', type: 'rectangle', boardId: 'board-3' },
    ]);

    const deleted = await postDeleteBoard(roomId, owner, JSON.stringify({ boardId: 'board-2' }));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });

    // Read back from storage after eviction: the tab entry and the elements
    // are gone, every other board's tab and elements are still standing.
    const stored = await storedBoardState(roomId);
    expect(stored.meta['board-2']).toBeUndefined();
    expect(stored.meta['board-3']).toBeTruthy();
    expect(stored.elementIds).toEqual(['elsewhere-1', 'kept-1']);
  });

  it('deleting the main board is refused with 400 and changes nothing', async () => {
    const owner = await bootstrapLocalSession('board-delete-main-owner');
    const roomId = 'board-delete-main-room';
    await createRoom(roomId, owner);
    await seedBoardMeta(roomId, 'board-2', 'Board 2', 1);
    await seedElements(roomId, [
      { id: 'main-1', type: 'rectangle', boardId: 'main' },
      { id: 'other-1', type: 'rectangle', boardId: 'board-2' },
    ]);

    const refused = await postDeleteBoard(roomId, owner, JSON.stringify({ boardId: 'main' }));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toHaveProperty('error');

    const stored = await storedBoardState(roomId);
    expect(stored.meta['board-2']).toBeTruthy();
    expect(stored.elementIds).toEqual(['main-1', 'other-1']);
  });

  it('a member cannot delete a board', async () => {
    const owner = await bootstrapLocalSession('board-delete-member-owner');
    const member = await bootstrapLocalSession('board-delete-member');
    const roomId = 'board-delete-member-room';
    await createRoom(roomId, owner);
    await admitMember(owner, member, roomId);
    await seedBoardMeta(roomId, 'board-2', 'Board 2', 1);
    await seedElements(roomId, [
      { id: 'main-1', type: 'rectangle', boardId: 'main' },
      { id: 'other-1', type: 'rectangle', boardId: 'board-2' },
    ]);

    const refused = await postDeleteBoard(roomId, member, JSON.stringify({ boardId: 'board-2' }));
    expect(refused.status).toBe(403);

    const stored = await storedBoardState(roomId);
    expect(stored.meta['board-2']).toBeTruthy();
    expect(stored.elementIds).toEqual(['main-1', 'other-1']);
  });

  it('a guest cannot delete a board', async () => {
    const GUEST = 'https://join.example.com';
    const owner = await bootstrapLocalSession('board-delete-guest-owner');
    const roomId = 'board-delete-guest-room';
    await createRoom(roomId, owner);
    await seedBoardMeta(roomId, 'board-2', 'Board 2', 1);
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

    const refused = await SELF.fetch(`${GUEST}/api/whiteboard/room/${roomId}/boards/delete`, {
      method: 'POST',
      headers: {
        Origin: GUEST,
        'content-type': 'application/json',
        Cookie: guestCookie!,
      },
      body: JSON.stringify({ boardId: 'board-2' }),
    });
    expect(refused.status).toBe(403);

    const stored = await storedBoardState(roomId);
    expect(stored.meta['board-2']).toBeTruthy();
    expect(stored.elementIds).toEqual(['main-1', 'other-1']);
  });

  it('an invalid boardId is refused with 400', async () => {
    const owner = await bootstrapLocalSession('board-delete-invalid-owner');
    const roomId = 'board-delete-invalid-room';
    await createRoom(roomId, owner);
    await seedBoardMeta(roomId, 'board-2', 'Board 2', 1);
    await seedElements(roomId, [
      { id: 'main-1', type: 'rectangle', boardId: 'main' },
      { id: 'other-1', type: 'rectangle', boardId: 'board-2' },
    ]);

    for (const boardId of ['', 'x'.repeat(65), '../main', '<script>', 7, null]) {
      const refused = await postDeleteBoard(roomId, owner, JSON.stringify({ boardId }));
      expect(refused.status, `boardId ${JSON.stringify(boardId)}`).toBe(400);
      expect(await refused.json()).toHaveProperty('error');
    }

    // No boardId at all is as meaningless as a bad one: the route deletes
    // exactly one board, never "the room".
    const missing = await postDeleteBoard(roomId, owner, '{}');
    expect(missing.status).toBe(400);
    const malformed = await postDeleteBoard(roomId, owner, '{"boardId": ');
    expect(malformed.status).toBe(400);

    const stored = await storedBoardState(roomId);
    expect(stored.meta['board-2']).toBeTruthy();
    expect(stored.elementIds).toEqual(['main-1', 'other-1']);
  });

  it('deleting an unknown board id still sweeps its orphaned elements', async () => {
    const owner = await bootstrapLocalSession('board-delete-ghost-owner');
    const roomId = 'board-delete-ghost-room';
    await createRoom(roomId, owner);
    await seedElements(roomId, [
      { id: 'ghost-1', type: 'rectangle', boardId: 'board-ghost' },
      { id: 'kept-1', type: 'rectangle', boardId: 'main' },
    ]);

    const deleted = await postDeleteBoard(roomId, owner, JSON.stringify({ boardId: 'board-ghost' }));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });

    const stored = await storedBoardState(roomId);
    expect(stored.elementIds).toEqual(['kept-1']);

    // Idempotent: a second delete of the same id changes nothing and still succeeds.
    const again = await postDeleteBoard(roomId, owner, JSON.stringify({ boardId: 'board-ghost' }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
    expect((await storedBoardState(roomId)).elementIds).toEqual(['kept-1']);
  });
});
