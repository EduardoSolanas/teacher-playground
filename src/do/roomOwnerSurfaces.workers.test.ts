import { beforeEach, describe, expect, it } from 'vitest';

import { bootstrapLocalSession, authenticatedFetch, type LocalAuthSession } from '../test/workerAuth';

/**
 * The two owner-only surfaces that are neither board nor settings: the
 * diagnostic report about a room, and the room's shape library.
 *
 * They live in their own file rather than beside the rest of the room matrix
 * because that file is at a limit: adding three tests to it made five of its
 * unrelated document tests fail with a stack overflow inside session
 * bootstrap, and removing one made one of them pass again. The pool gives each
 * file its own isolate, so this keeps the fragility from spreading rather than
 * pretending it is not there.
 *
 * What is being tested is the gate, not the handler. Authorization in RoomDO
 * runs before the route and its default is refusal, so both of these shipped
 * with a handler that checked ownership correctly and a gate that had never
 * heard of them: the owner they were built for got 403, and no unit test of a
 * handler could have seen it.
 */
describe('owner-only room surfaces', () => {
  let owner: LocalAuthSession;
  let outsider: LocalAuthSession;

  beforeEach(async () => {
    owner = await bootstrapLocalSession(`surfaces-owner-${crypto.randomUUID()}`);
    outsider = await bootstrapLocalSession(`surfaces-outsider-${crypto.randomUUID()}`);
  });

  async function createRoom(roomId: string) {
    const created = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [], viewport: { x: 0, y: 0, zoom: 1 } }),
    });
    expect(created.status).toBe(200);
  }

  it('lets the owner read a room report and refuses everyone else', async () => {
    const roomId = 'surfaces-stats';
    await createRoom(roomId);

    const mine = await authenticatedFetch(`/api/whiteboard/room/${roomId}/stats`, owner);
    expect(mine.status).toBe(200);
    const report = await mine.json() as Record<string, unknown>;
    expect(report).toHaveProperty('elements');
    expect(report).toHaveProperty('snapshotBytes');

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/stats`, outsider)).status)
      .toBe(403);
  });

  it('keeps a room library for its owner and refuses everyone else', async () => {
    const roomId = 'surfaces-library';
    await createRoom(roomId);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/library`, owner)).status)
      .toBe(200);

    const saved = await authenticatedFetch(`/api/whiteboard/room/${roomId}/library`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 'lib-1', elements: [] }] }),
    });
    expect(saved.status).toBe(200);

    const read = await authenticatedFetch(`/api/whiteboard/room/${roomId}/library`, owner);
    expect((await read.json() as { items: unknown[] }).items).toHaveLength(1);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/library`, outsider)).status)
      .toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/library`, outsider, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    })).status).toBe(403);
  });

  it('refuses a library that is not a library, and one that is too big', async () => {
    const roomId = 'surfaces-library-limits';
    await createRoom(roomId);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/library`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: 'not-a-library' }),
    })).status).toBe(400);

    /*
     * Told apart from a malformed body on purpose: a library that has outgrown
     * the room is the teacher's own shapes, and they can act on that by
     * removing one. Answering it as a bad request would read as a bug in the
     * application rather than as a limit they have reached.
     */
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/library`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 'huge', blob: 'y'.repeat(300 * 1024) }] }),
    })).status).toBe(413);
  });
});
