import { beforeEach, describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, SELF } from 'cloudflare:test';
import { getIdentityObject, type IdentityDO } from './IdentityDO';
import {
  accessFetch,
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';

let session: LocalAuthSession;

beforeEach(async () => {
  session = await bootstrapLocalSession('room-worker-test');
});

async function createRoom(roomId: string, body: Record<string, unknown> = {}) {
  return authenticatedFetch(`/api/whiteboard/room/${roomId}`, session, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ elements: [], ...body }),
  });
}

describe('Worker routing into RoomDO', () => {
  it('creates a room and reads it back', async () => {
    const created = await createRoom('alpha', { name: 'Algebra', maxUsers: 4 });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({
      success: true,
      name: 'Algebra',
      maxUsers: 4,
    });

    const fetched = await authenticatedFetch('/api/whiteboard/room/alpha', session);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({
      room_id: 'alpha',
      name: 'Algebra',
      maxUsers: 4,
      elements: [],
    });
  });

  it('answers 403 for a room the caller does not belong to, existing or not', async () => {
    // Deliberately identical for an absent room and someone else's room, so the
    // response cannot be used to enumerate which room ids exist.
    const absent = await authenticatedFetch('/api/whiteboard/room/nope', session);
    expect(absent.status).toBe(403);

    const other = await bootstrapLocalSession('room-owner-elsewhere');
    await authenticatedFetch('/api/whiteboard/room/someone-elses', other, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    });
    const existing = await authenticatedFetch('/api/whiteboard/room/someone-elses', session);
    expect(existing.status).toBe(403);
  });

  it('still reports 404 to a member whose room has been deleted', async () => {
    await createRoom('deleted-but-member');
    expect((await authenticatedFetch('/api/whiteboard/room/deleted-but-member', session, {
      method: 'DELETE',
    })).status).toBe(200);

    const res = await authenticatedFetch('/api/whiteboard/room/deleted-but-member', session);
    expect(res.status).toBe(404);
  });

  it('isolates state between rooms', async () => {
    await createRoom('room-a', { name: 'A' });
    await createRoom('room-b', { name: 'B' });

    const a = await (await authenticatedFetch('/api/whiteboard/room/room-a', session)).json();
    const b = await (await authenticatedFetch('/api/whiteboard/room/room-b', session)).json();

    expect((a as { name: string }).name).toBe('A');
    expect((b as { name: string }).name).toBe('B');
  });

  it('deletes a room', async () => {
    await createRoom('doomed');
    const del = await authenticatedFetch('/api/whiteboard/room/doomed', session, { method: 'DELETE' });
    expect(del.status).toBe(200);

    const after = await authenticatedFetch('/api/whiteboard/room/doomed', session);
    expect(after.status).toBe(404);
  });

  it('routes the presence sub-path', async () => {
    await createRoom('present');
    const res = await authenticatedFetch('/api/whiteboard/room/present/presence', session);
    expect(res.status).toBe(200);
  });

  it('rejects unknown paths', async () => {
    const res = await accessFetch('/nothing/here', 'room-worker-test');
    expect(res.status).toBe(404);
  });
});

describe('y-webrtc signaling over Durable Object WebSockets', () => {
  async function connect(roomId: string): Promise<WebSocket> {
    const res = await authenticatedFetch(`/signaling?room=${roomId}`, session, {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error('no webSocket on response');
    ws.accept();
    return ws;
  }

  function nextMessage(ws: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), 2000);
      ws.addEventListener('message', (event: MessageEvent) => {
        clearTimeout(timer);
        resolve(String(event.data));
      }, { once: true });
    });
  }

  it('requires a room on the signaling URL', async () => {
    const res = await authenticatedFetch('/signaling', session, {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-websocket request', async () => {
    const res = await authenticatedFetch('/signaling?room=x', session);
    expect(res.status).toBe(426);
  });

  it('fans a publish out to the other peer in the same room', async () => {
    const a = await connect('signal-room');
    const b = await connect('signal-room');

    const received = nextMessage(b);
    a.send(JSON.stringify({ type: 'publish', topic: 'whiteboard-signal-room', data: 'hello' }));

    const payload = JSON.parse(await received);
    expect(payload).toMatchObject({
      type: 'publish',
      topic: 'whiteboard-signal-room',
      data: 'hello',
    });
    // y-webrtc uses this to learn how many peers are on the topic.
    expect(payload.clients).toBe(2);
  });

  // The previous signaling implementation sent a publish to every subscriber including the publisher, and
  // y-webrtc relies on that for peer discovery; it de-duplicates by peer id.
  it('echoes a publish back to its sender, as the reference server does', async () => {
    const a = await connect('echo-room');
    await connect('echo-room');

    const own = nextMessage(a);
    a.send(JSON.stringify({ type: 'publish', topic: 't', data: 1 }));

    expect(JSON.parse(await own)).toMatchObject({ type: 'publish', topic: 't', data: 1 });
  });

  it('does not leak a publish across rooms', async () => {
    const a = await connect('room-one');
    const outsider = await connect('room-two');

    let leaked = false;
    outsider.addEventListener('message', () => { leaked = true; }, { once: true });

    a.send(JSON.stringify({ type: 'publish', topic: 't', data: 1 }));
    await new Promise((r) => setTimeout(r, 200));

    expect(leaked).toBe(false);
  });

  it('replies to an application-level ping', async () => {
    const ws = await connect('ping-room');
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'ping' }));
    expect(JSON.parse(await reply)).toEqual({ type: 'pong' });
  });
});

describe('static asset serving', () => {
  it('serves the app shell at the root', async () => {
    const res = await accessFetch('/', 'room-worker-test');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves the placeholder room page for an arbitrary room URL', async () => {
    const res = await accessFetch('/whiteboard/some-room-id', 'room-worker-test');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves the same page regardless of room id', async () => {
    const a = await (await accessFetch('/whiteboard/room-aaa', 'room-worker-test')).text();
    const b = await (await accessFetch('/whiteboard/room-bbb', 'room-worker-test')).text();
    expect(a).toBe(b);
  });
});

describe('public marketing surface (SEC-015)', () => {
  const BASE = 'https://example.com';

  it('serves the landing page with no Access credential at all', async () => {
    const res = await SELF.fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves /pricing with no credential and without X-Robots-Tag', async () => {
    const res = await SELF.fetch(`${BASE}/pricing`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toBeNull();
  });

  it('still gates the app: /whiteboard/<room> requires Access', async () => {
    const res = await SELF.fetch(`${BASE}/whiteboard/some-room`);
    expect(res.status).toBe(401);
  });

  it('still gates the API: /api/whiteboard/room/<id> requires Access', async () => {
    const res = await SELF.fetch(`${BASE}/api/whiteboard/room/x`);
    expect(res.status).toBe(401);
  });

  it('rejects a POST to the public root with no credential (public is read-only)', async () => {
    const res = await SELF.fetch(`${BASE}/`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('revocation closes live signaling sockets', () => {
  const IDENTITY_BASE = 'https://identity';

  function identity() {
    return getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  }

  function roomStub(roomId: string) {
    return env.ROOMS.get(env.ROOMS.idFromName(roomId));
  }

  async function changeAccount(path: 'revoke-all' | 'disable', accountId: string) {
    return identity().fetch(`${IDENTITY_BASE}/accounts/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId, actor: 'test-operator', reason: 'automated test' }),
    });
  }

  async function openSocket(roomId: string, authSession: LocalAuthSession) {
    const res = await authenticatedFetch(`/signaling?room=${roomId}`, authSession, {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    return ws;
  }

  function closeSignal(ws: WebSocket): { closed: boolean; code?: number } {
    const state = { closed: false } as { closed: boolean; code?: number };
    ws.addEventListener('close', (event: CloseEvent) => {
      state.closed = true;
      state.code = event.code;
    }, { once: true });
    return state;
  }

  it('closes an established socket after the account epoch advances', async () => {
    const roomId = 'revoke-room-epoch';
    const subject = await bootstrapLocalSession('revoke-epoch');
    const ws = await openSocket(roomId, subject);
    const closed = closeSignal(ws);

    // Socket survives a check while the account is still authorized.
    await runDurableObjectAlarm(roomStub(roomId));
    expect(closed.closed).toBe(false);

    await changeAccount('revoke-all', subject.accountId);
    await runDurableObjectAlarm(roomStub(roomId));

    expect(closed.closed).toBe(true);
  });

  it('closes an established socket when the account is disabled', async () => {
    const roomId = 'revoke-room-disabled';
    const subject = await bootstrapLocalSession('revoke-disabled');
    const ws = await openSocket(roomId, subject);
    const closed = closeSignal(ws);

    await changeAccount('disable', subject.accountId);
    await runDurableObjectAlarm(roomStub(roomId));

    expect(closed.closed).toBe(true);
  });

  it('leaves another account\'s socket open when one account is revoked', async () => {
    const roomId = 'revoke-room-isolated';
    const target = await bootstrapLocalSession('revoke-isolated-target');
    const other = await bootstrapLocalSession('revoke-isolated-other');

    const revokedWs = await openSocket(roomId, target);
    const survivorWs = await openSocket(roomId, other);
    const revoked = closeSignal(revokedWs);
    const survivor = closeSignal(survivorWs);

    await changeAccount('revoke-all', target.accountId);
    await runDurableObjectAlarm(roomStub(roomId));

    expect(revoked.closed).toBe(true);
    expect(survivor.closed).toBe(false);
  });
});

describe('revocation check runs without being triggered by hand', () => {
  it('closes a revoked socket on its own scheduled alarm', async () => {
    const roomId = 'revoke-room-selfscheduled';
    const subject = await bootstrapLocalSession('revoke-self-scheduled');

    const res = await authenticatedFetch(`/signaling?room=${roomId}`, subject, {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();

    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('socket was not closed by the scheduled alarm')),
        5_000,
      );
      ws.addEventListener('close', (event: CloseEvent) => {
        clearTimeout(timer);
        resolve(event.code);
      }, { once: true });
    });

    await getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>)
      .fetch('https://identity/accounts/revoke-all', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: subject.accountId, actor: 'test-operator', reason: 'automated test' }),
      });

    // Deliberately no runDurableObjectAlarm(): this proves the object
    // re-schedules and fires its own check.
    expect(await closed).toBe(4401);
  });
});

describe('room authorization matrix', () => {
  let owner: LocalAuthSession;
  let outsider: LocalAuthSession;

  beforeEach(async () => {
    owner = await bootstrapLocalSession('matrix-owner');
    outsider = await bootstrapLocalSession('matrix-outsider');
  });

  async function createRoomAs(who: LocalAuthSession, roomId: string, body: Record<string, unknown> = {}) {
    return authenticatedFetch(`/api/whiteboard/room/${roomId}`, who, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [], ...body }),
    });
  }

  function joinAs(who: LocalAuthSession, roomId: string, peerId: string) {
    return authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, who, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId, userName: peerId, color: '#3498db' }),
    });
  }

  it('makes the creator the owner and lets it read its own board', async () => {
    expect((await createRoomAs(owner, 'matrix-basic', { name: 'Mine' })).status).toBe(200);

    const read = await authenticatedFetch('/api/whiteboard/room/matrix-basic', owner);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ name: 'Mine' });
  });

  it('refuses an outsider reading, writing, or deleting the board', async () => {
    await createRoomAs(owner, 'matrix-closed', { name: 'Private' });

    expect((await authenticatedFetch('/api/whiteboard/room/matrix-closed', outsider)).status).toBe(403);
    expect((await createRoomAs(outsider, 'matrix-closed', { name: 'Hijacked' })).status).toBe(403);
    expect((await authenticatedFetch('/api/whiteboard/room/matrix-closed', outsider, {
      method: 'DELETE',
    })).status).toBe(403);

    // The board is unchanged after every refusal.
    const read = await authenticatedFetch('/api/whiteboard/room/matrix-closed', owner);
    expect(await read.json()).toMatchObject({ name: 'Private' });
  });

  it('refuses an outsider moderating the waiting queue', async () => {
    await createRoomAs(owner, 'matrix-moderation');
    await joinAs(owner, 'matrix-moderation', 'host-peer');
    await joinAs(outsider, 'matrix-moderation', 'guest-peer');

    expect((await authenticatedFetch('/api/whiteboard/room/matrix-moderation/waiting', outsider)).status).toBe(403);

    const selfApprove = await authenticatedFetch('/api/whiteboard/room/matrix-moderation/waiting', outsider, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'guest-peer', action: 'approve' }),
    });
    expect(selfApprove.status).toBe(403);

    // Still refused the board after trying to admit itself.
    expect((await authenticatedFetch('/api/whiteboard/room/matrix-moderation', outsider)).status).toBe(403);
  });

  it('refuses a non-owner kicking or suspending a peer', async () => {
    await createRoomAs(owner, 'matrix-kick');
    await joinAs(owner, 'matrix-kick', 'host-peer');

    for (const action of ['kick', 'suspend']) {
      const response = await authenticatedFetch('/api/whiteboard/room/matrix-kick/presence', outsider, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, peerId: 'host-peer' }),
      });
      expect(response.status, action).toBe(403);
    }
  });

  it('refuses removing a peer bound to another account, leaving it in place', async () => {
    const roomId = 'matrix-presence-delete';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');
    await joinAs(outsider, roomId, 'guest-peer');

    const del = await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/presence?peerId=guest-peer`,
      owner,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(403);

    // guest-peer is a non-host peer, so it's queued in the waiting list rather
    // than admitted straight into room_presence — the refused delete must
    // leave it there either way.
    const presence = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner);
    const data = (await presence.json()) as { waitingPeers: Array<{ peerId: string }> };
    expect(data.waitingPeers.map((p) => p.peerId)).toContain('guest-peer');
  });

  it('refuses claiming a peerId already bound to another account', async () => {
    const roomId = 'matrix-presence-claim';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');
    await joinAs(outsider, roomId, 'guest-peer');

    const hijack = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'guest-peer', userName: 'Hijacker', color: '#000000' }),
    });
    expect(hijack.status).toBe(403);

    // Untouched: the peer's original name from joinAs, not the hijack attempt.
    // guest-peer is a non-host peer, so it's in the waiting list, not
    // room_presence.
    const presence = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner);
    const data = (await presence.json()) as { waitingPeers: Array<{ peerId: string; userName: string }> };
    expect(data.waitingPeers.find((p) => p.peerId === 'guest-peer')?.userName).toBe('guest-peer');
  });

  it('does not transfer a peer to the moderator when the owner suspends it', async () => {
    const roomId = 'matrix-presence-moderate-binding';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');
    await joinAs(outsider, roomId, 'guest-peer');
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'guest-peer', action: 'approve' }),
    });
    // Re-join so the admitted presence row is bound to the guest's account.
    await joinAs(outsider, roomId, 'guest-peer');

    const suspend = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'suspend', peerId: 'guest-peer' }),
    });
    expect(suspend.status).toBe(200);

    // Moderating a peer names someone else's peer. It must not rebind that
    // peer to the moderator's account, or the real owner would be locked out
    // of its own leave and heartbeat.
    const selfDelete = await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/presence?peerId=guest-peer`,
      outsider,
      { method: 'DELETE' },
    );
    expect(selfDelete.status).toBe(200);
  });

  it('lets a caller remove its own peer', async () => {
    const roomId = 'matrix-presence-self-delete';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');

    const del = await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/presence?peerId=host-peer`,
      owner,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(200);

    const presence = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner);
    const data = (await presence.json()) as { users: Array<{ peerId: string }> };
    expect(data.users.map((u) => u.peerId)).not.toContain('host-peer');
  });

  it('does not grant host status to the first peer when no host is recorded', async () => {
    const roomId = 'matrix-no-host-fallback';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'solo-peer');

    const presence = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner);
    const data = (await presence.json()) as { users: Array<{ peerId: string; isHost: boolean }> };
    expect(data.users).toEqual([
      expect.objectContaining({ peerId: 'solo-peer', isHost: false }),
    ]);
  });

  it('grants membership when the owner approves a waiting peer', async () => {
    const roomId = 'matrix-approval';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');

    // The guest is queued, and cannot read the board yet.
    await joinAs(outsider, roomId, 'guest-peer');
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(403);

    const approve = await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'guest-peer', action: 'approve' }),
    });
    expect(approve.status).toBe(200);

    // Admission is what grants the board, and it survives the peer going idle.
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(200);
  });

  it('does not let an approved member delete the room', async () => {
    const roomId = 'matrix-member-delete';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');
    await joinAs(outsider, roomId, 'guest-peer');
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'guest-peer', action: 'approve' }),
    });
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(200);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider, {
      method: 'DELETE',
    })).status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner)).status).toBe(200);
  });
});

describe('A/V token route (/api/av/token)', () => {
  it('requires a session and a roomId', async () => {
    const missingRoom = await authenticatedFetch('/api/av/token', session, { method: 'POST' });
    expect(missingRoom.status).toBe(400);

    const unauthed = await accessFetch('/api/av/token?roomId=av-room', 'av-no-session', 'valid', {
      method: 'POST',
      headers: { Origin: 'https://example.com' },
    });
    expect(unauthed.status).toBe(401);
  });

  it('refuses GET: join tokens are minted only via origin-guarded POST', async () => {
    // SameSite=Lax sends the session cookie on top-level GET navigations, and
    // the origin guard deliberately exempts GETs. A GET that mints a
    // credential would combine those two exemptions, so the route is
    // POST-only.
    await createRoom('av-room-get');
    const viaGet = await authenticatedFetch('/api/av/token?roomId=av-room-get', session);
    expect(viaGet.status).toBe(405);
  });

  it('returns 403 for outsiders and 503 for admitted peers when LiveKit is unset', async () => {
    const owner = session;
    const outsider = await bootstrapLocalSession('av-outsider');
    await createRoom('av-room-core');

    const denied = await authenticatedFetch('/api/av/token?roomId=av-room-core', outsider, {
      method: 'POST',
    });
    expect(denied.status).toBe(403);

    // Without LIVEKIT_* bindings the admitted owner still cannot mint a token.
    const unconfigured = await authenticatedFetch('/api/av/token?roomId=av-room-core', owner, {
      method: 'POST',
    });
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ reason: 'unconfigured' });
  });

  it('refuses waiting peers even after they have a presence row queued', async () => {
    const owner = session;
    const guest = await bootstrapLocalSession('av-waiting-guest');
    const roomId = 'av-room-waiting';
    await createRoom(roomId);
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'host-av', userName: 'Host', color: '#111' }),
    });
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, guest, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'guest-av', userName: 'Guest', color: '#222' }),
    });

    const waitingToken = await authenticatedFetch(
      `/api/av/token?roomId=${roomId}&identity=guest-av`,
      guest,
      { method: 'POST' },
    );
    expect(waitingToken.status).toBe(403);
  });
});
