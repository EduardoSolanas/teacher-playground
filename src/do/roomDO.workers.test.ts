import { beforeEach, describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
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

  it('returns 404 for a room that does not exist', async () => {
    const res = await authenticatedFetch('/api/whiteboard/room/nope', session);
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
      body: JSON.stringify({ accountId }),
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
