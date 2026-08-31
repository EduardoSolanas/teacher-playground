import { describe, expect, it } from 'vitest';
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
