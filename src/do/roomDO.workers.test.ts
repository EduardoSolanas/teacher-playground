import { beforeEach, describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { getIdentityObject, type IdentityDO } from './IdentityDO';
import type { RoomDO } from './RoomDO';
import { ROOM_SETTINGS_KEYS } from '../lib/whiteboard/requestSchemas';
import {
  accessFetch,
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';

function splitRoomWrite(body: Record<string, unknown>) {
  const settings: Record<string, unknown> = {};
  const scene: Record<string, unknown> = { elements: [] };
  for (const [key, value] of Object.entries(body)) {
    if ((ROOM_SETTINGS_KEYS as readonly string[]).includes(key)) {
      settings[key] = value;
    } else if (key !== 'elements') {
      scene[key] = value;
    }
  }
  return { scene, settings };
}

async function writeRoom(
  roomId: string,
  who: LocalAuthSession,
  body: Record<string, unknown> = {},
) {
  const { scene, settings } = splitRoomWrite(body);
  const created = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scene),
  });
  if (created.status !== 200 || Object.keys(settings).length === 0) return created;
  return authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  });
}

let session: LocalAuthSession;

beforeEach(async () => {
  session = await bootstrapLocalSession('room-worker-test');
});

async function createRoom(roomId: string, body: Record<string, unknown> = {}) {
  return writeRoom(roomId, session, body);
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

  it('answers 403 after deletion so a former member cannot distinguish a missing room', async () => {
    await createRoom('deleted-but-member');
    expect((await authenticatedFetch('/api/whiteboard/room/deleted-but-member', session, {
      method: 'DELETE',
    })).status).toBe(200);

    const res = await authenticatedFetch('/api/whiteboard/room/deleted-but-member', session);
    expect(res.status).toBe(403);
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
    expect(after.status).toBe(403);
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

describe('signaling requires granted membership', () => {
  async function signalingUpgrade(who: LocalAuthSession, roomId: string) {
    return authenticatedFetch(`/signaling?room=${roomId}`, who, {
      headers: { Upgrade: 'websocket' },
    });
  }

  it('returns 403 for pending and outsider upgrades; 101 for the owner', async () => {
    const owner = await bootstrapLocalSession('signaling-grant-owner');
    const outsider = await bootstrapLocalSession('signaling-grant-outsider');
    const roomId = 'signaling-grant-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const outsiderRes = await signalingUpgrade(outsider, roomId);
    expect(outsiderRes.status).toBe(403);
    expect(outsiderRes.webSocket).toBeNull();

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, outsider, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'pending-peer', userName: 'Guest', color: '#3498db' }),
    })).status).toBe(200);

    const pendingRes = await signalingUpgrade(outsider, roomId);
    expect(pendingRes.status).toBe(403);
    expect(pendingRes.webSocket).toBeNull();

    const ownerRes = await signalingUpgrade(owner, roomId);
    expect(ownerRes.status).toBe(101);
    expect(ownerRes.webSocket).not.toBeNull();
    ownerRes.webSocket?.accept();
    ownerRes.webSocket?.close();
  });
});

describe('y-webrtc signaling over Durable Object WebSockets', () => {
  async function connect(roomId: string): Promise<WebSocket> {
    expect((await createRoom(roomId)).status).toBe(200);
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

describe('y-websocket document bytes over RoomDO WebSockets', () => {
  async function connectGranted(who: LocalAuthSession, roomId: string): Promise<WebSocket> {
    const res = await authenticatedFetch(`/signaling?room=${roomId}`, who, {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error('no webSocket on response');
    ws.accept();
    return ws;
  }

  async function grantEditor(
    owner: LocalAuthSession,
    editor: LocalAuthSession,
    roomId: string,
  ) {
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, editor, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Editor' }),
    })).status).toBe(201);
    expect((await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/requests/${editor.accountId}`,
      owner,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role: 'peer' }),
      },
    )).status).toBe(200);
  }

  function nextBinaryMessage(ws: WebSocket): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for binary frame')), 2000);
      ws.addEventListener('message', (event: MessageEvent) => {
        clearTimeout(timer);
        if (typeof event.data === 'string') {
          reject(new Error('expected binary frame, got string'));
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          resolve(event.data);
          return;
        }
        const view = event.data as ArrayBufferView;
        const copy = new Uint8Array(view.byteLength);
        copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        resolve(copy.buffer);
      }, { once: true });
    });
  }

  it('relays binary ArrayBuffer frames to other granted peers in the same room', async () => {
    const owner = await bootstrapLocalSession('binary-relay-owner');
    const editor = await bootstrapLocalSession('binary-relay-editor');
    const roomId = 'binary-relay-room';
    const otherRoomId = 'binary-relay-other-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    expect((await writeRoom(otherRoomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);

    const sender = await connectGranted(owner, roomId);
    const receiver = await connectGranted(editor, roomId);
    const otherRoomSocket = await connectGranted(owner, otherRoomId);

    const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    const received = nextBinaryMessage(receiver);
    sender.send(payload.buffer);

    expect(Array.from(new Uint8Array(await received))).toEqual(Array.from(payload));

    let leaked = false;
    otherRoomSocket.addEventListener('message', () => { leaked = true; }, { once: true });
    sender.send(payload.buffer);
    await new Promise((r) => setTimeout(r, 200));
    expect(leaked).toBe(false);
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

  async function openSocket(
    roomId: string,
    authSession: LocalAuthSession,
    options: { create?: boolean } = {},
  ) {
    if (options.create !== false) {
      const created = await writeRoom(roomId, authSession);
      if (created.status !== 403) expect(created.status).toBe(200);
    }
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

    expect((await writeRoom(roomId, target)).status).toBe(200);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, other, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Other' }),
    })).status).toBe(201);
    expect((await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/requests/${other.accountId}`,
      target,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role: 'viewer' }),
      },
    )).status).toBe(200);

    const revokedWs = await openSocket(roomId, target, { create: false });
    const survivorWs = await openSocket(roomId, other, { create: false });
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
    expect((await writeRoom(roomId, subject)).status).toBe(200);

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
    return writeRoom(roomId, who, body);
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
    // of its own leave. After suspend the account is pending, so leave is
    // the waiting-queue withdraw, not a granted presence heartbeat.
    const selfDelete = await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/waiting?peerId=guest-peer`,
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

  it('does not grant host status from hostPeerId when the peer is not the owner', async () => {
    const roomId = 'matrix-no-host-fallback';
    const editor = await bootstrapLocalSession('matrix-labeled-host');
    await createRoomAs(owner, roomId, { hostPeerId: 'solo-peer' });
    await grantPublicRole(owner, editor, roomId, 'peer');
    await joinAs(editor, roomId, 'solo-peer');

    const presence = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, editor);
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

  it('keeps a single membership row so an account cannot be pending and granted', async () => {
    const roomId = 'matrix-one-row';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');
    await joinAs(outsider, roomId, 'guest-peer');

    await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'guest-peer', action: 'approve' }),
    });

    const rows = await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => instance.db.prepare(
        `SELECT role FROM room_members WHERE room_id = ? AND account_id = ?`,
      ).all(roomId, outsider.accountId) as Array<{ role: string }>,
    );
    expect(rows).toEqual([{ role: 'editor' }]);
  });

  it('approves the account bound to the waiting peer, not a client-asserted account', async () => {
    const roomId = 'matrix-approve-bound-account';
    const other = await bootstrapLocalSession('matrix-other-guest');
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');
    await joinAs(outsider, roomId, 'guest-peer');
    await joinAs(other, roomId, 'other-peer');

    const approve = await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'guest-peer',
        action: 'approve',
        accountId: other.accountId,
      }),
    });
    expect(approve.status).toBe(409);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, other)).status).toBe(403);
  });

  it('does not grant membership from a bearer token or Authorization header', async () => {
    const roomId = 'matrix-bearer-not-authz';
    await createRoomAs(owner, roomId);

    const withBearer = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider, {
      headers: { Authorization: 'Bearer creator-token' },
    });
    expect(withBearer.status).toBe(403);

    const createWithBearer = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer creator-token',
      },
      body: JSON.stringify({ elements: [], name: 'Stolen' }),
    });
    expect(createWithBearer.status).toBe(403);

    const read = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner);
    expect(await read.json()).not.toMatchObject({ name: 'Stolen' });
  });

  it('does not select membership from an email in the request body', async () => {
    const roomId = 'matrix-email-not-authz';
    await createRoomAs(owner, roomId, { name: 'Private' });

    const requested = await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, outsider, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Eve', email: 'owner@example.com' }),
    });
    expect(requested.status).toBe(201);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(403);

    const settings = await authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, outsider, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked', email: 'owner@example.com' }),
    });
    expect(settings.status).toBe(403);
    expect(await (await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner)).json()).toMatchObject({
      name: 'Private',
    });
  });

  it('does not grant owner power by forging the creator peerId or hostPeerId', async () => {
    const roomId = 'matrix-forge-creator-peer';
    const attacker = await bootstrapLocalSession('matrix-forge-creator');
    await createRoomAs(owner, roomId, { hostPeerId: 'creator-peer', name: 'Keep' });
    await joinAs(owner, roomId, 'creator-peer');

    expect((await joinAs(attacker, roomId, 'creator-peer')).status).toBe(403);
    expect((await joinAs(attacker, roomId, 'creator-peer-clone')).status).toBe(200);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, attacker, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Stolen', hostPeerId: 'creator-peer' }),
    })).status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, attacker, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', peerId: 'creator-peer' }),
    })).status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, attacker, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'creator-peer', action: 'approve' }),
    })).status).toBe(403);

    expect(await (await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner)).json()).toMatchObject({
      name: 'Keep',
    });
  });

  it('approves a waiting grant by accountId', async () => {
    const roomId = 'matrix-approve-by-account';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');
    await joinAs(outsider, roomId, 'guest-peer');

    const approve = await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: outsider.accountId, action: 'approve' }),
    });
    expect(approve.status).toBe(200);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(200);
  });

  it('kicks the bound account even if the owner names only accountId', async () => {
    const roomId = 'matrix-kick-by-account';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');
    await joinAs(outsider, roomId, 'guest-peer');
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: outsider.accountId, action: 'approve' }),
    });
    await joinAs(outsider, roomId, 'guest-peer');

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', accountId: outsider.accountId }),
    })).status).toBe(200);

    expect((await joinAs(outsider, roomId, 'after-kick')).status).toBe(403);
  });

  it('does not let a forged peerId steal another account\'s grant', async () => {
    const roomId = 'matrix-forged-peer';
    const attacker = await bootstrapLocalSession('matrix-attacker');
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');
    await joinAs(outsider, roomId, 'guest-peer');
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'guest-peer', action: 'approve' }),
    });
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(200);

    const hijack = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, attacker, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'guest-peer', userName: 'Nope', color: '#000000' }),
    });
    expect(hijack.status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, attacker)).status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(200);
  });

  it('denies later requests from a kicked account even with a new peerId', async () => {
    const roomId = 'matrix-kick-survives-peer';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');
    await joinAs(outsider, roomId, 'guest-peer');
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'guest-peer', action: 'approve' }),
    });
    await joinAs(outsider, roomId, 'guest-peer');

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', peerId: 'guest-peer' }),
    })).status).toBe(200);

    const rejoin = await joinAs(outsider, roomId, 'brand-new-peer');
    expect(rejoin.status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(403);

    const requestAgain = await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, outsider, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Eve' }),
    });
    expect(requestAgain.status).toBe(403);
  });

  it('yields a single owner when two accounts create the same room concurrently', async () => {
    const roomId = 'matrix-concurrent-create';
    const other = await bootstrapLocalSession('matrix-concurrent-other');
    const [first, second] = await Promise.all([
      createRoomAs(owner, roomId, { name: 'A' }),
      createRoomAs(other, roomId, { name: 'B' }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 403]);

    const rows = await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => instance.db.prepare(
        `SELECT account_id AS accountId, role FROM room_members WHERE room_id = ?`,
      ).all(roomId) as Array<{ accountId: string; role: string }>,
    );
    expect(rows.filter((row) => row.role === 'owner')).toHaveLength(1);
  });

  it('fails closed on an unknown room section', async () => {
    await createRoomAs(owner, 'matrix-unknown-section');
    const res = await authenticatedFetch('/api/whiteboard/room/matrix-unknown-section/not-a-route', owner);
    expect(res.status).toBe(403);
  });

  async function roomTables(roomId: string) {
    return runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => ({
        rooms: instance.db.prepare(
          `SELECT name, max_users AS maxUsers, elements FROM rooms WHERE room_id = ?`,
        ).all(roomId) as Array<{ name: string | null; maxUsers: number; elements: string }>,
        members: instance.db.prepare(
          `SELECT account_id AS accountId, role FROM room_members WHERE room_id = ? ORDER BY account_id`,
        ).all(roomId) as Array<{ accountId: string; role: string }>,
        presence: instance.db.prepare(
          `SELECT peer_id AS peerId FROM room_presence WHERE room_id = ? ORDER BY peer_id`,
        ).all(roomId) as Array<{ peerId: string }>,
        waiting: instance.db.prepare(
          `SELECT peer_id AS peerId FROM waiting_peers WHERE room_id = ? ORDER BY peer_id`,
        ).all(roomId) as Array<{ peerId: string }>,
        kicked: instance.db.prepare(
          `SELECT peer_id AS peerId FROM kicked_peers WHERE room_id = ? ORDER BY peer_id`,
        ).all(roomId) as Array<{ peerId: string }>,
      }),
    );
  }

  async function grantPublicRole(
    who: LocalAuthSession,
    guest: LocalAuthSession,
    roomId: string,
    role: 'peer' | 'viewer',
  ) {
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, guest, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Guest' }),
    })).status).toBe(201);
    expect((await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/requests/${guest.accountId}`,
      who,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role }),
      },
    )).status).toBe(200);
  }

  it('refuses canvas reads for missing, pending, and banned roles', async () => {
    const roomId = 'matrix-canvas-read';
    await createRoomAs(owner, roomId, { name: 'Board' });
    const before = await roomTables(roomId);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(403);

    await joinAs(outsider, roomId, 'pending-peer');
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, outsider)).status).toBe(403);

    const afterPending = await roomTables(roomId);
    expect(afterPending.rooms).toEqual(before.rooms);

    await joinAs(owner, roomId, 'host-peer');
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'pending-peer', action: 'approve' }),
    });
    await joinAs(outsider, roomId, 'pending-peer');
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', peerId: 'pending-peer' }),
    })).status).toBe(200);

    const afterKick = await roomTables(roomId);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(403);
    expect(await roomTables(roomId)).toEqual(afterKick);
  });

  it('lets a viewer read the board but not publish scene or settings', async () => {
    const roomId = 'matrix-viewer-write';
    const viewer = await bootstrapLocalSession('matrix-viewer');
    await createRoomAs(owner, roomId, { name: 'Original', maxUsers: 3 });
    await grantPublicRole(owner, viewer, roomId, 'viewer');

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, viewer)).status).toBe(200);

    const before = await roomTables(roomId);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, viewer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [{ id: 'rect' }] }),
    })).status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, viewer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked', maxUsers: 9 }),
    })).status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, viewer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked', maxUsers: 9 }),
    })).status).toBe(403);
    expect(await roomTables(roomId)).toEqual(before);
  });

  it('lets an editor publish scene writes but not settings, queue PII, or moderation', async () => {
    const roomId = 'matrix-editor-write';
    const editor = await bootstrapLocalSession('matrix-editor');
    await createRoomAs(owner, roomId, { name: 'Original', maxUsers: 3 });
    await grantPublicRole(owner, editor, roomId, 'peer');
    await joinAs(owner, roomId, 'host-peer');
    await joinAs(outsider, roomId, 'queued-peer');

    const scene = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, editor, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [{ id: 'rect' }] }),
    });
    expect(scene.status).toBe(200);

    const beforeSettings = await roomTables(roomId);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, editor, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [{ id: 'rect' }], name: 'Stolen', maxUsers: 9 }),
    })).status).toBe(400);
    expect(await roomTables(roomId)).toEqual(beforeSettings);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, editor, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Stolen', maxUsers: 9 }),
    })).status).toBe(403);
    expect(await roomTables(roomId)).toEqual(beforeSettings);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, editor)).status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, editor)).status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, editor, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', peerId: 'queued-peer' }),
    })).status).toBe(403);

    const presence = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, editor);
    expect(presence.status).toBe(200);
    const data = await presence.json() as { users: unknown[]; waitingPeers?: unknown };
    expect(Array.isArray(data.users)).toBe(true);
    expect(data.waitingPeers).toBeUndefined();
  });

  it('lets the owner moderate and read queue PII', async () => {
    const roomId = 'matrix-owner-moderate';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');
    await joinAs(outsider, roomId, 'guest-peer');

    const queue = await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner);
    expect(queue.status).toBe(200);
    expect(await queue.json()).toMatchObject({
      waitingPeers: [expect.objectContaining({ peerId: 'guest-peer' })],
    });

    const requests = await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, owner);
    expect(requests.status).toBe(200);
    const listed = await requests.json() as { requests: Array<{ email: string | null; requestId: string }> };
    expect(listed.requests.some((row) => row.requestId === outsider.accountId)).toBe(true);

    const presence = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner);
    const data = await presence.json() as { waitingPeers: Array<{ peerId: string }> };
    expect(data.waitingPeers.map((p) => p.peerId)).toContain('guest-peer');

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'guest-peer', action: 'approve' }),
    })).status).toBe(200);
  });

  it('lets the owner read settings without scene fields', async () => {
    const roomId = 'matrix-owner-get-settings';
    await createRoomAs(owner, roomId, { name: 'Readable', maxUsers: 6, allowFirstUserHost: true });
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [{ id: 'hidden-dot' }] }),
    })).status).toBe(200);

    const response = await authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, owner);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      success: true,
      name: 'Readable',
      maxUsers: 6,
      allowFirstUserHost: true,
    });
    expect(body).toHaveProperty('updated_at');
    expect(body).toHaveProperty('created_at');
    expect(body).not.toHaveProperty('elements');
    expect(body).not.toHaveProperty('viewport');
    expect(JSON.stringify(body)).not.toContain('hidden-dot');
  });

  it('lets the owner change settings and rejects mixed scene/settings bodies', async () => {
    const roomId = 'matrix-settings-split';
    const editor = await bootstrapLocalSession('matrix-settings-editor');
    await createRoomAs(owner, roomId, { name: 'Original', maxUsers: 3 });
    await grantPublicRole(owner, editor, roomId, 'peer');

    const ownerPatch = await authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, owner, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', maxUsers: 5, allowFirstUserHost: true }),
    });
    expect(ownerPatch.status).toBe(200);
    expect(await ownerPatch.json()).toMatchObject({
      name: 'Renamed',
      maxUsers: 5,
      allowFirstUserHost: true,
    });

    const scene = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, editor, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [{ id: 'dot' }] }),
    });
    expect(scene.status).toBe(200);

    const beforeMix = await roomTables(roomId);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, editor, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxUsers: 9 }),
    })).status).toBe(400);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nope', elements: [{ id: 'wipe' }] }),
    })).status).toBe(400);
    expect(await roomTables(roomId)).toEqual(beforeMix);
  });

  function roomHttpRoutes(roomId: string, extras: { requestId: string; peerId: string }) {
    return [
      { name: 'GET /room', method: 'GET', path: `/api/whiteboard/room/${roomId}` },
      { name: 'HEAD /room', method: 'HEAD', path: `/api/whiteboard/room/${roomId}` },
      { name: 'POST /room scene', method: 'POST', path: `/api/whiteboard/room/${roomId}`, body: { elements: [{ id: 'stolen' }] } },
      { name: 'DELETE /room', method: 'DELETE', path: `/api/whiteboard/room/${roomId}` },
      { name: 'GET /settings', method: 'GET', path: `/api/whiteboard/room/${roomId}/settings` },
      { name: 'POST /settings', method: 'POST', path: `/api/whiteboard/room/${roomId}/settings`, body: { name: 'Hijacked' } },
      { name: 'PATCH /settings', method: 'PATCH', path: `/api/whiteboard/room/${roomId}/settings`, body: { name: 'Hijacked' } },
      { name: 'GET /presence', method: 'GET', path: `/api/whiteboard/room/${roomId}/presence` },
      {
        name: 'POST /presence join',
        method: 'POST',
        path: `/api/whiteboard/room/${roomId}/presence`,
        body: { peerId: 'cred-peer', userName: 'Cred', color: '#000000' },
      },
      {
        name: 'POST /presence kick',
        method: 'POST',
        path: `/api/whiteboard/room/${roomId}/presence`,
        body: { action: 'kick', peerId: extras.peerId },
      },
      {
        name: 'POST /presence suspend',
        method: 'POST',
        path: `/api/whiteboard/room/${roomId}/presence`,
        body: { action: 'suspend', peerId: extras.peerId },
      },
      { name: 'DELETE /presence', method: 'DELETE', path: `/api/whiteboard/room/${roomId}/presence?peerId=${extras.peerId}` },
      { name: 'GET /waiting', method: 'GET', path: `/api/whiteboard/room/${roomId}/waiting` },
      {
        name: 'POST /waiting',
        method: 'POST',
        path: `/api/whiteboard/room/${roomId}/waiting`,
        body: { peerId: extras.peerId, action: 'approve' },
      },
      { name: 'DELETE /waiting', method: 'DELETE', path: `/api/whiteboard/room/${roomId}/waiting?peerId=${extras.peerId}` },
      { name: 'GET /access', method: 'GET', path: `/api/whiteboard/room/${roomId}/access` },
      { name: 'GET /requests', method: 'GET', path: `/api/whiteboard/room/${roomId}/requests` },
      {
        name: 'POST /requests',
        method: 'POST',
        path: `/api/whiteboard/room/${roomId}/requests`,
        body: { userName: 'Eve', email: 'eve@hidden.example' },
      },
      {
        name: 'POST /requests/:id',
        method: 'POST',
        path: `/api/whiteboard/room/${roomId}/requests/${extras.requestId}`,
        body: { action: 'approve', role: 'peer' },
      },
    ] as const;
  }

  async function dispatchRoute(
    route: { method: string; path: string; body?: Record<string, unknown> },
    who: LocalAuthSession | 'missing' | 'malformed' | 'expired',
  ): Promise<Response> {
    const init: RequestInit = { method: route.method };
    if (route.body) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(route.body);
    }
    if (who === 'missing') {
      return SELF.fetch(`https://example.com${route.path}`, init);
    }
    if (who === 'malformed' || who === 'expired') {
      return accessFetch(route.path, `cred-${who}`, who, init);
    }
    return authenticatedFetch(route.path, who, init);
  }

  function assertNoRoomDataOrPii(payload: unknown, secret: { boardName: string; email: string }) {
    const text = JSON.stringify(payload);
    expect(text).not.toContain(secret.boardName);
    expect(text).not.toContain(secret.email);
    expect(text).not.toMatch(/waitingPeers/);
    expect(text).not.toMatch(/"elements"/);
  }

  it('rejects missing, malformed, and expired credentials on every room HTTP route without mutating tables', async () => {
    const roomId = 'matrix-cred-table';
    const secret = { boardName: 'SecretBoardBytes', email: 'queued@hidden.example' };
    await createRoomAs(owner, roomId, { name: secret.boardName });
    await joinAs(owner, roomId, 'host-peer');
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, outsider, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Queued', email: secret.email }),
    });
    await joinAs(outsider, roomId, 'guest-peer');
    const before = await roomTables(roomId);
    const routes = roomHttpRoutes(roomId, { requestId: outsider.accountId, peerId: 'guest-peer' });

    for (const variant of ['missing', 'malformed', 'expired'] as const) {
      for (const route of routes) {
        const response = await dispatchRoute(route, variant);
        expect(response.status, `${variant} ${route.name}`).toBe(401);
        if (route.method === 'HEAD') continue;
        const payload = await response.json();
        expect(payload, `${variant} ${route.name}`).toEqual({ error: 'Unauthorized' });
        assertNoRoomDataOrPii(payload, secret);
      }
    }

    expect(await roomTables(roomId)).toEqual(before);
  });

  it('rejects wrong-room and wrong-role callers on every protected route without mutating tables', { timeout: 20_000 }, async () => {
    const roomId = 'matrix-role-table';
    const otherRoom = 'matrix-role-other';
    const secret = { boardName: 'RoleTableBoard', email: 'wait@hidden.example' };
    const viewer = await bootstrapLocalSession('matrix-role-viewer');
    const editor = await bootstrapLocalSession('matrix-role-editor');
    const pending = await bootstrapLocalSession('matrix-role-pending');
    const queued = await bootstrapLocalSession('matrix-role-queued');
    const foreign = await bootstrapLocalSession('matrix-role-foreign');

    await createRoomAs(owner, roomId, { name: secret.boardName });
    await createRoomAs(foreign, otherRoom, { name: 'Elsewhere' });
    await grantPublicRole(owner, viewer, roomId, 'viewer');
    await grantPublicRole(owner, editor, roomId, 'peer');
    await joinAs(owner, roomId, 'host-peer');
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, pending, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Pending', email: secret.email }),
    });
    await joinAs(pending, roomId, 'pending-peer');
    await joinAs(queued, roomId, 'queued-peer');

    const denied: Array<{
      name: string;
      method: string;
      path: string;
      body?: Record<string, unknown>;
      callers: LocalAuthSession[];
    }> = [
      {
        name: 'GET /room',
        method: 'GET',
        path: `/api/whiteboard/room/${roomId}`,
        callers: [outsider, pending, foreign],
      },
      {
        name: 'HEAD /room',
        method: 'HEAD',
        path: `/api/whiteboard/room/${roomId}`,
        callers: [outsider, pending, foreign],
      },
      {
        name: 'POST /room scene',
        method: 'POST',
        path: `/api/whiteboard/room/${roomId}`,
        body: { elements: [{ id: 'stolen' }] },
        callers: [outsider, pending, foreign, viewer],
      },
      {
        name: 'DELETE /room',
        method: 'DELETE',
        path: `/api/whiteboard/room/${roomId}`,
        callers: [outsider, pending, foreign, viewer, editor],
      },
      {
        name: 'GET /settings',
        method: 'GET',
        path: `/api/whiteboard/room/${roomId}/settings`,
        callers: [outsider, pending, foreign, viewer, editor],
      },
      {
        name: 'POST /settings',
        method: 'POST',
        path: `/api/whiteboard/room/${roomId}/settings`,
        body: { name: 'Hijacked' },
        callers: [outsider, pending, foreign, viewer, editor],
      },
      {
        name: 'PATCH /settings',
        method: 'PATCH',
        path: `/api/whiteboard/room/${roomId}/settings`,
        body: { name: 'Hijacked' },
        callers: [outsider, pending, foreign, viewer, editor],
      },
      {
        name: 'GET /presence',
        method: 'GET',
        path: `/api/whiteboard/room/${roomId}/presence`,
        callers: [outsider, pending, foreign],
      },
      {
        name: 'POST /presence kick',
        method: 'POST',
        path: `/api/whiteboard/room/${roomId}/presence`,
        body: { action: 'kick', peerId: 'pending-peer' },
        callers: [outsider, pending, foreign, viewer, editor],
      },
      {
        name: 'POST /presence suspend',
        method: 'POST',
        path: `/api/whiteboard/room/${roomId}/presence`,
        body: { action: 'suspend', peerId: 'pending-peer' },
        callers: [outsider, pending, foreign, viewer, editor],
      },
      {
        name: 'DELETE /presence other',
        method: 'DELETE',
        path: `/api/whiteboard/room/${roomId}/presence?peerId=host-peer`,
        callers: [outsider, pending, foreign, viewer, editor],
      },
      {
        name: 'GET /waiting',
        method: 'GET',
        path: `/api/whiteboard/room/${roomId}/waiting`,
        callers: [outsider, pending, foreign, viewer, editor],
      },
      {
        name: 'POST /waiting',
        method: 'POST',
        path: `/api/whiteboard/room/${roomId}/waiting`,
        body: { peerId: 'pending-peer', action: 'approve' },
        callers: [outsider, pending, foreign, viewer, editor],
      },
      {
        name: 'DELETE /waiting other',
        method: 'DELETE',
        path: `/api/whiteboard/room/${roomId}/waiting?peerId=queued-peer`,
        callers: [outsider, pending, foreign, viewer, editor],
      },
      {
        name: 'GET /requests',
        method: 'GET',
        path: `/api/whiteboard/room/${roomId}/requests`,
        callers: [outsider, pending, foreign, viewer, editor],
      },
      {
        name: 'POST /requests/:id',
        method: 'POST',
        path: `/api/whiteboard/room/${roomId}/requests/${pending.accountId}`,
        body: { action: 'approve', role: 'peer' },
        callers: [outsider, pending, foreign, viewer, editor],
      },
    ];

    const before = await roomTables(roomId);
    for (const route of denied) {
      for (const who of route.callers) {
        const response = await dispatchRoute(route, who);
        expect(response.status, `${who.subject} ${route.name}`).toBe(403);
        if (route.method === 'HEAD') continue;
        const payload = await response.json();
        expect(payload, `${who.subject} ${route.name}`).toEqual({ error: 'Forbidden' });
        assertNoRoomDataOrPii(payload, secret);
      }
    }
    expect(await roomTables(roomId)).toEqual(before);
  });

  it('does not return board bytes or waiting-queue PII to pending or anonymous callers', async () => {
    const roomId = 'matrix-no-pii';
    const secret = { boardName: 'HiddenCanvasName', email: 'pii@hidden.example' };
    await createRoomAs(owner, roomId, { name: secret.boardName });
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [{ id: 'secret-dot' }] }),
    })).status).toBe(200);
    await joinAs(owner, roomId, 'host-peer');
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, outsider, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Queued', email: secret.email }),
    });
    await joinAs(outsider, roomId, 'guest-peer');

    const ownerBoard = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner);
    expect(await ownerBoard.json()).toMatchObject({
      name: secret.boardName,
      elements: [expect.objectContaining({ id: 'secret-dot' })],
    });
    const ownerQueue = await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner);
    expect(await ownerQueue.json()).toMatchObject({
      waitingPeers: [expect.objectContaining({ peerId: 'guest-peer' })],
    });

    for (const path of [
      `/api/whiteboard/room/${roomId}`,
      `/api/whiteboard/room/${roomId}/presence`,
      `/api/whiteboard/room/${roomId}/waiting`,
      `/api/whiteboard/room/${roomId}/requests`,
      `/api/whiteboard/room/${roomId}/settings`,
    ]) {
      const pending = await authenticatedFetch(path, outsider);
      expect(pending.status, path).toBe(403);
      assertNoRoomDataOrPii(await pending.json(), secret);

      const anonymous = await SELF.fetch(`https://example.com${path}`);
      expect(anonymous.status, `anon ${path}`).toBe(401);
      assertNoRoomDataOrPii(await anonymous.json(), secret);
    }

    const ownAccess = await authenticatedFetch(`/api/whiteboard/room/${roomId}/access`, outsider);
    expect(ownAccess.status).toBe(200);
    expect(await ownAccess.json()).toEqual({ status: 'pending' });
  });

  it('stops treating an editor as granted once the editor TTL has elapsed', async () => {
    const roomId = 'matrix-editor-ttl';
    const editor = await bootstrapLocalSession('matrix-ttl-editor');
    await createRoomAs(owner, roomId, { name: 'TtlBoard' });
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [{ id: 'keep' }] }),
    })).status).toBe(200);
    await grantPublicRole(owner, editor, roomId, 'peer');
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, editor)).status).toBe(200);

    await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => instance.db.prepare(
        `UPDATE room_members SET expires_at = 1 WHERE room_id = ? AND account_id = ?`,
      ).run(roomId, editor.accountId),
    );

    const before = await roomTables(roomId);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, editor)).status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, editor, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [{ id: 'after-expiry' }] }),
    })).status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, editor, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Expired' }),
    })).status).toBe(403);
    expect(await (await authenticatedFetch(`/api/whiteboard/room/${roomId}/access`, editor)).json())
      .toEqual({ status: 'none' });
    expect(await roomTables(roomId)).toEqual(before);
    expect(await (await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner)).json())
      .toMatchObject({ name: 'TtlBoard', elements: [expect.objectContaining({ id: 'keep' })] });
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
