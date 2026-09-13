import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import { RoomDO } from './RoomDO';
import { issueGuestPin } from '../lib/whiteboard/guestPin';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';
import { withLiveKitConfigured } from '../test/workerLiveKit';

/*
 * Kept out of roomDO.workers.test.ts on purpose: vitest-pool-workers nests one
 * more Proxy around the entrypoint prototype for every instance it constructs,
 * so a single file that makes enough requests overflows the stack in whatever
 * test happens to run last. That file is at the limit.
 */

function writeRoom(roomId: string, who: LocalAuthSession) {
  return authenticatedFetch(`/api/whiteboard/room/${roomId}`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ elements: [] }),
  });
}

describe('A/V screen share control (Phase 10)', () => {
  const GUEST = 'https://join.example.com';

  function roomStub(roomId: string) {
    return env.ROOMS.get(env.ROOMS.idFromName(roomId));
  }

  async function admit(owner: LocalAuthSession, who: LocalAuthSession, roomId: string, role: 'peer' | 'viewer') {
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, who, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: role === 'viewer' ? 'Viewer' : 'Student' }),
    })).status).toBe(201);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests/${who.accountId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', role }),
    })).status).toBe(200);
  }

  function av(roomId: string, who: LocalAuthSession, body: Record<string, unknown>) {
    return authenticatedFetch(`/api/whiteboard/room/${roomId}/av`, who, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('lets the owner allow and withdraw a participant share, and reaches LiveKit to do it', async () => {
    const owner = await bootstrapLocalSession('share-allow-owner');
    const student = await bootstrapLocalSession('share-allow-student');
    const roomId = 'share-allow-room';
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await admit(owner, student, roomId, 'peer');

    await withLiveKitConfigured(false, async () => {
      for (const action of ['allow-screen-share', 'revoke-screen-share']) {
        const response = await av(roomId, owner, { action, target: student.accountId });
        expect(response.status, action).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
      }
    });
    // Configured against a host that cannot be reached: the route really calls
    // LiveKit, and says so when it fails rather than claiming success.
    await withLiveKitConfigured(true, async () => {
      const response = await av(roomId, owner, { action: 'allow-screen-share', target: student.accountId });
      expect(response.status).toBe(502);
    });
  });

  it('refuses a participant granting or withdrawing anyone a share, their own included', async () => {
    // One participant: the Free plan admits the owner and one other.
    const owner = await bootstrapLocalSession('share-peer-owner');
    const student = await bootstrapLocalSession('share-peer-student');
    const roomId = 'share-peer-room';
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await admit(owner, student, roomId, 'peer');

    await withLiveKitConfigured(false, async () => {
      for (const body of [
        { action: 'allow-screen-share', target: student.accountId },
        { action: 'revoke-screen-share', target: student.accountId },
        { action: 'revoke-screen-share', target: owner.accountId },
      ]) {
        expect((await av(roomId, student, body)).status, JSON.stringify(body)).toBe(403);
      }
    });
  });

  it('only allows a share to an admitted participant who can publish', async () => {
    const owner = await bootstrapLocalSession('share-target-owner');
    const viewer = await bootstrapLocalSession('share-target-viewer');
    const stranger = await bootstrapLocalSession('share-target-stranger');
    const roomId = 'share-target-room';
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await admit(owner, viewer, roomId, 'viewer');

    await withLiveKitConfigured(false, async () => {
      for (const target of [viewer.accountId, stranger.accountId, owner.accountId]) {
        const response = await av(roomId, owner, { action: 'allow-screen-share', target });
        expect(response.status, target).toBe(409);
      }
      expect((await av(roomId, owner, { action: 'allow-screen-share' })).status).toBe(400);
    });
  });

  it('lets a participant end their own share, and nobody end another', async () => {
    const owner = await bootstrapLocalSession('share-end-owner');
    const student = await bootstrapLocalSession('share-end-student');
    const viewer = await bootstrapLocalSession('share-end-viewer');
    const roomId = 'share-end-room';
    // A second room needs a second owner: the Free plan owns one room.
    const viewerOwner = await bootstrapLocalSession('share-end-viewer-owner');
    const viewerRoomId = 'share-end-viewer-room';
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    expect((await writeRoom(viewerRoomId, viewerOwner)).status).toBe(200);
    await admit(owner, student, roomId, 'peer');
    await admit(viewerOwner, viewer, viewerRoomId, 'viewer');

    await withLiveKitConfigured(false, async () => {
      const own = await av(roomId, student, { action: 'end-screen-share' });
      expect(own.status).toBe(200);
      expect(await own.json()).toEqual({ ok: true });
      // The target is always the caller; a named target is not honoured.
      expect((await av(roomId, student, { action: 'end-screen-share', target: owner.accountId })).status).toBe(200);
      expect((await av(viewerRoomId, viewer, { action: 'end-screen-share' })).status).toBe(403);
    });
    // The owner's share is theirs by right and is never narrowed by this path.
    await withLiveKitConfigured(true, async () => {
      const ownerEnd = await av(roomId, owner, { action: 'end-screen-share' });
      expect(ownerEnd.status).toBe(200);
      expect(await ownerEnd.json()).toEqual({ ok: true, skipped: true });
    });
  });

  it('refuses a guest granting a share', async () => {
    const owner = await bootstrapLocalSession('share-guest-owner');
    const roomId = 'share-guest-room';
    expect((await writeRoom(roomId, owner)).status).toBe(200);
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
    const guestCookie = guestAuth.headers.get('set-cookie')!.split(';', 1)[0];

    const allow = await SELF.fetch(`${GUEST}/api/whiteboard/room/${roomId}/av`, {
      method: 'POST',
      headers: { Origin: GUEST, 'content-type': 'application/json', Cookie: guestCookie },
      body: JSON.stringify({ action: 'allow-screen-share', target: owner.accountId }),
    });
    expect(allow.status).toBe(403);
  });
});
