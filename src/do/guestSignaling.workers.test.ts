import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import { getIdentityObject, type IdentityDO } from './IdentityDO';
import { RoomDO } from './RoomDO';
import { issueGuestPin } from '../lib/whiteboard/guestPin';
import type { ValidatedSession } from '../lib/identity/sessionStore';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';

const TEACHER = 'https://example.com';
const GUEST = 'https://join.example.com';

function hexRoomId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

async function createTeacherRoom(subject: string): Promise<{
  roomId: string;
  owner: LocalAuthSession;
}> {
  const owner = await bootstrapLocalSession(subject);
  const roomId = hexRoomId();
  const created = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
    method: 'POST',
    headers: { Origin: TEACHER, 'content-type': 'application/json' },
    body: JSON.stringify({ elements: [] }),
  });
  expect(created.status).toBe(200);
  return { roomId, owner };
}

async function pinForRoom(roomId: string): Promise<string> {
  return runInDurableObject(
    env.ROOMS.get(env.ROOMS.idFromName(roomId)),
    (instance: RoomDO) => issueGuestPin(instance.db, roomId, Date.now()),
  );
}

async function mintGuestCookie(roomId: string, displayName = 'Kid'): Promise<string> {
  const pin = await pinForRoom(roomId);
  const response = await SELF.fetch(`${GUEST}/auth/guest`, {
    method: 'POST',
    headers: {
      Origin: GUEST,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ roomId, pin, displayName }),
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return setCookie!.split(';', 1)[0];
}

async function guestFetch(
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Origin', GUEST);
  headers.set('Cookie', cookie);
  return SELF.fetch(`${GUEST}${path}`, { ...init, headers });
}

async function queueGuest(cookie: string, roomId: string): Promise<string> {
  const response = await guestFetch(`/api/whiteboard/room/${roomId}/requests`, cookie, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userName: 'Kid' }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { requestId: string };
  expect(body.requestId).toBeTruthy();
  return body.requestId;
}

async function approveGuestEditor(
  owner: LocalAuthSession,
  roomId: string,
  accountId: string,
): Promise<void> {
  const approval = await authenticatedFetch(
    `/api/whiteboard/room/${roomId}/requests/${accountId}`,
    owner,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', role: 'peer' }),
    },
  );
  expect(approval.status).toBe(200);
}

async function guestSignaling(cookie: string, roomId: string): Promise<Response> {
  return guestFetch(`/signaling?room=${roomId}`, cookie, {
    headers: { Upgrade: 'websocket' },
  });
}

async function authorizeGuestSession(
  cookie: string,
  roomId: string,
): Promise<ValidatedSession> {
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const response = await identity.fetch(new Request('https://identity/sessions/authorize-guest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ roomId }),
  }));
  expect(response.status).toBe(200);
  return response.json() as Promise<ValidatedSession>;
}

function closeSignal(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('socket was not closed immediately after kick')),
      2_000,
    );
    ws.addEventListener('close', (event: CloseEvent) => {
      clearTimeout(timer);
      resolve(event.code);
    }, { once: true });
  });
}

async function readGrantVersion(roomId: string): Promise<number> {
  return runInDurableObject(
    env.ROOMS.get(env.ROOMS.idFromName(roomId)),
    (instance: RoomDO) => {
      const row = instance.db.prepare(
        `SELECT grant_version AS grantVersion FROM rooms WHERE room_id = ?`,
      ).get(roomId) as { grantVersion: number } | undefined;
      return row?.grantVersion ?? 0;
    },
  );
}

interface SocketAttachment {
  accountId?: string;
  sessionId?: string;
  authorizationEpoch?: number;
  roomId?: string;
  grantVersion?: number;
}

async function readSocketAttachments(roomId: string): Promise<SocketAttachment[]> {
  return runInDurableObject(
    env.ROOMS.get(env.ROOMS.idFromName(roomId)),
    (instance: RoomDO) => {
      const ctx = (instance as unknown as { ctx: { getWebSockets(): WebSocket[] } }).ctx;
      return ctx.getWebSockets().map((socket) => socket.deserializeAttachment() as SocketAttachment);
    },
  );
}

describe('guest signaling: pending upgrade is refused', () => {
  it('does not upgrade a queued pending guest', async () => {
    const { roomId } = await createTeacherRoom('guest-signaling-pending-owner');
    const cookie = await mintGuestCookie(roomId);
    await queueGuest(cookie, roomId);

    const pending = await guestSignaling(cookie, roomId);
    expect(pending.status).not.toBe(101);
    expect([401, 403]).toContain(pending.status);
    expect(pending.webSocket).toBeNull();
  });
});

describe('guest signaling: granted upgrade binds identity', () => {
  it('upgrades a granted guest editor and stamps socket attachment', async () => {
    const { roomId, owner } = await createTeacherRoom('guest-signaling-granted-owner');
    const cookie = await mintGuestCookie(roomId);
    const accountId = await queueGuest(cookie, roomId);
    await approveGuestEditor(owner, roomId, accountId);

    const session = await authorizeGuestSession(cookie, roomId);
    expect(session.accountId).toBe(accountId);
    expect(session.sessionId.length).toBeGreaterThan(0);

    const upgraded = await guestSignaling(cookie, roomId);
    expect(upgraded.status).toBe(101);
    const ws = upgraded.webSocket;
    if (!ws) throw new Error('no webSocket on granted guest response');
    ws.accept();

    const attachments = await readSocketAttachments(roomId);
    const attachment = attachments.find((row) => row.accountId === accountId);
    expect(attachment).toEqual({
      accountId,
      sessionId: session.sessionId,
      authorizationEpoch: session.authorizationEpoch,
      roomId,
      grantVersion: await readGrantVersion(roomId),
    });
    ws.close();
  });
});

describe('guest signaling: kick closes the guest socket', () => {
  it('closes the guest socket with 4401 and bumps grant_version', async () => {
    const { roomId, owner } = await createTeacherRoom('guest-signaling-kick-owner');
    const cookie = await mintGuestCookie(roomId);
    const accountId = await queueGuest(cookie, roomId);
    await approveGuestEditor(owner, roomId, accountId);

    const join = await guestFetch(`/api/whiteboard/room/${roomId}/presence`, cookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'kid-peer', userName: 'Kid', color: '#3498db' }),
    });
    expect(join.status).toBe(200);

    const upgraded = await guestSignaling(cookie, roomId);
    expect(upgraded.status).toBe(101);
    const ws = upgraded.webSocket;
    if (!ws) throw new Error('no webSocket on granted guest response');
    ws.accept();
    const closed = closeSignal(ws);

    expect(await readGrantVersion(roomId)).toBe(0);

    const kick = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', accountId }),
    });
    expect(kick.status).toBe(200);

    expect(await closed).toBe(4401);
    expect(await readGrantVersion(roomId)).toBe(1);
  });
});

describe('guest signaling: room-bound cookie cannot cross rooms', () => {
  it('returns 401 at the Worker before RoomDO for a guest cookie on another room', async () => {
    const { roomId: roomA } = await createTeacherRoom('guest-signaling-cross-a');
    const { roomId: roomB } = await createTeacherRoom('guest-signaling-cross-b');
    const cookie = await mintGuestCookie(roomA);

    const crossed = await guestSignaling(cookie, roomB);
    expect(crossed.status).toBe(401);
    expect(crossed.webSocket).toBeNull();
  });
});
