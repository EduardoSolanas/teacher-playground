import { beforeEach, describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { getIdentityObject, type IdentityDO } from './IdentityDO';
import { RoomDO } from './RoomDO';
import { ROOM_SETTINGS_KEYS } from '../lib/whiteboard/requestSchemas';
import { MAX_BODY_BYTES } from '../lib/worker/requestGuard';
import { issueGuestPin } from '../lib/whiteboard/guestPin';
import {
  accessFetch,
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';
/*
 * How long a socket event may take before the test gives up.
 *
 * These are nets, not assertions: nothing here measures how fast a close or a
 * frame arrives, and no test passes by being slow. At 2s they failed in
 * batches on a loaded CI runner — the suite stretched from ~130s to ~370s and
 * sockets that do close were reported as never closing. Generous enough that
 * only a genuinely hung socket trips it.
 */
const SOCKET_EVENT_DEADLINE_MS = 15_000;


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

async function joinPresence(
  who: LocalAuthSession,
  roomId: string,
  clientPeerId: string,
  extra: Record<string, unknown> = {},
) {
  const res = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      peerId: clientPeerId,
      userName: extra.userName ?? clientPeerId,
      color: extra.color ?? '#3498db',
      ...extra,
    }),
  });
  let peerId = clientPeerId;
  try {
    const data = await res.clone().json() as { peerId?: string };
    if (typeof data.peerId === 'string') peerId = data.peerId;
  } catch {
    // Non-JSON error bodies still expose status to the caller.
  }
  return { res, status: res.status, ok: res.ok, peerId };
}

async function joinEditorPeer(editor: LocalAuthSession, roomId: string): Promise<string> {
  const joined = await joinPresence(editor, roomId, 'editor-peer', {
    userName: 'Editor',
    color: '#3498db',
  });
  expect(joined.status).toBe(200);
  return joined.peerId;
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
  session = await bootstrapLocalSession(`room-worker-test-${crypto.randomUUID()}`);
});

async function createRoom(roomId: string, body: Record<string, unknown> = {}) {
  return writeRoom(roomId, session, body);
}

describe('Worker routing into RoomDO', () => {
  it('creates a room and reads it back', async () => {
    const created = await createRoom('alpha', { name: 'Algebra', maxUsers: 2 });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({
      success: true,
      name: 'Algebra',
      maxUsers: 2,
    });

    const fetched = await authenticatedFetch('/api/whiteboard/room/alpha', session);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({
      room_id: 'alpha',
      name: 'Algebra',
      maxUsers: 2,
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
    expect(res.status).toBe(410);
  });

  it('isolates state between rooms', async () => {
    const other = await bootstrapLocalSession(`room-isolate-b-${crypto.randomUUID()}`);
    await createRoom('room-a', { name: 'A' });
    expect((await writeRoom('room-b', other, { name: 'B' })).status).toBe(200);

    const a = await (await authenticatedFetch('/api/whiteboard/room/room-a', session)).json();
    const b = await (await authenticatedFetch('/api/whiteboard/room/room-b', other)).json();

    expect((a as { name: string }).name).toBe('A');
    expect((b as { name: string }).name).toBe('B');
  });

  it('deletes a room', async () => {
    await createRoom('doomed');
    const del = await authenticatedFetch('/api/whiteboard/room/doomed', session, { method: 'DELETE' });
    expect(del.status).toBe(200);

    const after = await authenticatedFetch('/api/whiteboard/room/doomed', session);
    expect(after.status).toBe(410);
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
      const timer = setTimeout(() => reject(new Error('timed out')), SOCKET_EVENT_DEADLINE_MS);
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
    a.send(JSON.stringify({ type: 'publish', topic: 'room', data: 'hello' }));

    const payload = JSON.parse(await received);
    expect(payload).toMatchObject({
      type: 'publish',
      topic: 'room',
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
    a.send(JSON.stringify({ type: 'publish', topic: 'room', data: 1 }));

    expect(JSON.parse(await own)).toMatchObject({ type: 'publish', topic: 'room', data: 1 });
  });

  it('does not leak a publish across rooms', async () => {
    const a = await connect('room-one');
    const other = await bootstrapLocalSession(`signal-leak-${crypto.randomUUID()}`);
    expect((await writeRoom('room-two', other)).status).toBe(200);
    const outsider = await connectGranted(other, 'room-two');

    let leaked = false;
    outsider.addEventListener('message', () => { leaked = true; }, { once: true });

    a.send(JSON.stringify({ type: 'publish', topic: 'room', data: 1 }));
    await new Promise((r) => setTimeout(r, 200));

    expect(leaked).toBe(false);
  });

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

  async function grantViewer(
    owner: LocalAuthSession,
    viewer: LocalAuthSession,
    roomId: string,
  ) {
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, viewer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Viewer' }),
    })).status).toBe(201);
    expect((await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/requests/${viewer.accountId}`,
      owner,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role: 'viewer' }),
      },
    )).status).toBe(200);
  }

  it('does not deliver JSON publish to viewer peers', async () => {
    const owner = await bootstrapLocalSession('publish-viewer-recipient-owner');
    const viewer = await bootstrapLocalSession('publish-viewer-recipient-viewer');
    const roomId = 'publish-viewer-recipient-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantViewer(owner, viewer, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const viewerSocket = await connectGranted(viewer, roomId);

    let received = false;
    viewerSocket.addEventListener('message', () => { received = true; }, { once: true });

    ownerSocket.send(JSON.stringify({ type: 'publish', topic: 'room', data: 'hello' }));

    await new Promise((r) => setTimeout(r, 200));
    expect(received).toBe(false);
  });

  it('does not fan out JSON publish from a viewer', async () => {
    const owner = await bootstrapLocalSession('publish-viewer-owner');
    const viewer = await bootstrapLocalSession('publish-viewer-viewer');
    const roomId = 'publish-viewer-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantViewer(owner, viewer, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const viewerSocket = await connectGranted(viewer, roomId);

    let received = false;
    ownerSocket.addEventListener('message', () => { received = true; }, { once: true });

    viewerSocket.send(JSON.stringify({ type: 'publish', topic: 'room', data: 'hello' }));

    await new Promise((r) => setTimeout(r, 200));
    expect(received).toBe(false);
  });

  it('replies to an application-level ping', async () => {
    const ws = await connect('ping-room');
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'ping' }));
    expect(JSON.parse(await reply)).toEqual({ type: 'pong' });
  });

  it('drops unknown JSON signaling types without relaying', async () => {
    const a = await connect('unknown-type-room');
    const b = await connect('unknown-type-room');

    let received = false;
    b.addEventListener('message', () => { received = true; }, { once: true });

    a.send(JSON.stringify({ type: 'explode', data: 'boom' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toBe(false);
  });

  it('does not relay a JSON publish with a topic other than room', async () => {
    const a = await connect('topic-mismatch-room');
    const b = await connect('topic-mismatch-room');

    let received = false;
    b.addEventListener('message', () => { received = true; }, { once: true });

    a.send(JSON.stringify({ type: 'publish', topic: 'not-the-room', data: 'hello' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toBe(false);
  });
});

describe('signaling sessionId binding', () => {
  function roomStub(roomId: string) {
    return env.ROOMS.get(env.ROOMS.idFromName(roomId));
  }

  it('stamps sessionId from the validated session and ignores forged query params', async () => {
    const owner = await bootstrapLocalSession('sessionid-stamp-owner');
    const roomId = 'sessionid-stamp-room';
    const current = await authenticatedFetch('/auth/session/current', owner);
    expect(current.status).toBe(200);
    const { sessionId: realSessionId } = (await current.json()) as { sessionId: string };

    const forgedSessionId = '0'.repeat(64);
    expect(forgedSessionId).not.toBe(realSessionId);

    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const res = await authenticatedFetch(
      `/signaling?room=${roomId}&sessionId=${forgedSessionId}&accountId=attacker&accountEpoch=999`,
      owner,
      { headers: { Upgrade: 'websocket' } },
    );
    expect(res.status).toBe(101);
    expect(res.webSocket).not.toBeNull();
    res.webSocket?.accept();

    const attachment = await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      const ctx = (instance as unknown as { ctx: { getWebSockets(): WebSocket[] } }).ctx;
      const sockets = ctx.getWebSockets();
      return sockets[0]?.deserializeAttachment() as {
        sessionId?: string;
        accountId?: string;
      } | undefined;
    });
    expect(attachment?.sessionId).toBe(realSessionId);
    expect(attachment?.sessionId).not.toBe(forgedSessionId);
    expect(attachment?.accountId).toBe(owner.accountId);
    res.webSocket?.close();
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

  async function grantViewer(
    owner: LocalAuthSession,
    viewer: LocalAuthSession,
    roomId: string,
  ) {
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, viewer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Viewer' }),
    })).status).toBe(201);
    expect((await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/requests/${viewer.accountId}`,
      owner,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role: 'viewer' }),
      },
    )).status).toBe(200);
  }

  function nextBinaryMessage(ws: WebSocket): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for binary frame')), SOCKET_EVENT_DEADLINE_MS);
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
    const otherOwner = await bootstrapLocalSession('binary-relay-other-owner');
    const editor = await bootstrapLocalSession('binary-relay-editor');
    const roomId = 'binary-relay-room';
    const otherRoomId = 'binary-relay-other-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    expect((await writeRoom(otherRoomId, otherOwner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);

    const sender = await connectGranted(owner, roomId);
    const receiver = await connectGranted(editor, roomId);
    const otherRoomSocket = await connectGranted(otherOwner, otherRoomId);

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

  it('does not relay binary ArrayBuffer frames from a viewer', async () => {
    const owner = await bootstrapLocalSession('binary-viewer-owner');
    const viewer = await bootstrapLocalSession('binary-viewer-viewer');
    const roomId = 'binary-viewer-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantViewer(owner, viewer, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const viewerSocket = await connectGranted(viewer, roomId);

    let received = false;
    ownerSocket.addEventListener('message', () => { received = true; }, { once: true });

    const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    viewerSocket.send(payload.buffer);

    await new Promise((r) => setTimeout(r, 200));
    expect(received).toBe(false);

    const ownerPayload = new Uint8Array([0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11]);
    const receivedFromOwner = nextBinaryMessage(viewerSocket);
    ownerSocket.send(ownerPayload.buffer);
    expect(Array.from(new Uint8Array(await receivedFromOwner))).toEqual(Array.from(ownerPayload));
  });
});

describe('signaling socket caps', () => {
  async function signalingUpgrade(who: LocalAuthSession, roomId: string) {
    return authenticatedFetch(`/signaling?room=${roomId}`, who, {
      headers: { Upgrade: 'websocket' },
    });
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

  it('rejects a fifth signaling socket for the same granted account', async () => {
    const owner = await bootstrapLocalSession('socket-cap-owner');
    const roomId = 'socket-cap-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const sockets: WebSocket[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await signalingUpgrade(owner, roomId);
      expect(res.status).toBe(101);
      const ws = res.webSocket;
      if (!ws) throw new Error('no webSocket on response');
      ws.accept();
      sockets.push(ws);
    }

    const fifth = await signalingUpgrade(owner, roomId);
    expect(fifth.status).toBe(403);
    expect(await fifth.json()).toEqual({ error: 'Too many connections' });
    expect(fifth.webSocket).toBeNull();

    for (const ws of sockets) ws.close();
  });

  it('still accepts a different account when one account is at its socket cap', async () => {
    const owner = await bootstrapLocalSession('socket-cap-isolation-owner');
    const editor = await bootstrapLocalSession('socket-cap-isolation-editor');
    const roomId = 'socket-cap-isolation-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);

    for (let i = 0; i < 4; i += 1) {
      const res = await signalingUpgrade(owner, roomId);
      expect(res.status).toBe(101);
      res.webSocket!.accept();
    }

    const editorRes = await signalingUpgrade(editor, roomId);
    expect(editorRes.status).toBe(101);
    expect(editorRes.webSocket).not.toBeNull();
    editorRes.webSocket!.accept();
    editorRes.webSocket!.close();
  });

  it('rejects the next signaling socket when the room is at its socket cap', async () => {
    const previousCap = RoomDO.signalingMaxSocketsPerRoomForTests;
    RoomDO.signalingMaxSocketsPerRoomForTests = 2;
    const sockets: WebSocket[] = [];
    try {
      const owner = await bootstrapLocalSession('room-socket-cap-owner');
      const roomId = 'room-socket-cap-room';

      expect((await writeRoom(roomId, owner)).status).toBe(200);

      for (let i = 0; i < 2; i += 1) {
        const res = await signalingUpgrade(owner, roomId);
        expect(res.status).toBe(101);
        const ws = res.webSocket;
        if (!ws) throw new Error('no webSocket on response');
        ws.accept();
        sockets.push(ws);
      }

      const extra = await signalingUpgrade(owner, roomId);
      expect(extra.status).toBe(403);
      expect(await extra.json()).toEqual({ error: 'Too many connections' });
      expect(extra.webSocket).toBeNull();
    } finally {
      RoomDO.signalingMaxSocketsPerRoomForTests = previousCap;
      for (const ws of sockets) ws.close();
    }
  });
});

describe('signaling message rate limit', () => {
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

  function closeSignal(ws: WebSocket): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket was not closed')), SOCKET_EVENT_DEADLINE_MS);
      ws.addEventListener('close', (event: CloseEvent) => {
        clearTimeout(timer);
        resolve(event.code);
      }, { once: true });
    });
  }

  function nextMessage(ws: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), SOCKET_EVENT_DEADLINE_MS);
      ws.addEventListener('message', (event: MessageEvent) => {
        clearTimeout(timer);
        resolve(String(event.data));
      }, { once: true });
    });
  }

  it('closes with 1008 when a granted owner exceeds SIGNALING_MAX_MESSAGES_PER_WINDOW', async () => {
    const owner = await bootstrapLocalSession('rate-limit-owner');
    const roomId = 'rate-limit-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const ws = await connectGranted(owner, roomId);
    const closed = closeSignal(ws);

    for (let i = 0; i < 60; i += 1) {
      ws.send(JSON.stringify({ type: 'subscribe', topics: ['room'] }));
    }
    ws.send(JSON.stringify({ type: 'subscribe', topics: ['room'] }));

    expect(await closed).toBe(1008);
  });

  it('still relays a peer under the rate limit while the attacker is closed', async () => {
    const owner = await bootstrapLocalSession('rate-limit-isolation-owner');
    const editor = await bootstrapLocalSession('rate-limit-isolation-editor');
    const roomId = 'rate-limit-isolation-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);

    const attacker = await connectGranted(owner, roomId);
    const survivor = await connectGranted(editor, roomId);

    const attackerClosed = closeSignal(attacker);
    for (let i = 0; i < 61; i += 1) {
      attacker.send(JSON.stringify({ type: 'subscribe', topics: ['room'] }));
    }
    expect(await attackerClosed).toBe(1008);

    const received = nextMessage(survivor);
    survivor.send(JSON.stringify({ type: 'publish', topic: 'room', data: 'ok' }));
    expect(JSON.parse(await received)).toMatchObject({ type: 'publish', topic: 'room', data: 'ok' });
    expect(survivor.readyState).toBe(WebSocket.OPEN);
  });
});

describe('signaling message size limit', () => {
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

  function closeSignal(ws: WebSocket): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket was not closed')), SOCKET_EVENT_DEADLINE_MS);
      ws.addEventListener('close', (event: CloseEvent) => {
        clearTimeout(timer);
        resolve(event.code);
      }, { once: true });
    });
  }

  function nextBinaryMessage(ws: WebSocket): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for binary frame')), SOCKET_EVENT_DEADLINE_MS);
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

  it('closes with 1009 when a granted owner sends a binary frame over MAX_BODY_BYTES', async () => {
    const owner = await bootstrapLocalSession('oversized-binary-owner');
    const roomId = 'oversized-binary-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const ws = await connectGranted(owner, roomId);
    const closed = closeSignal(ws);

    const oversized = new Uint8Array(MAX_BODY_BYTES + 1);
    ws.send(oversized.buffer);

    expect(await closed).toBe(1009);
  });

  it('closes with 1009 when a granted owner sends a string frame over MAX_BODY_BYTES', async () => {
    const owner = await bootstrapLocalSession('oversized-string-owner');
    const roomId = 'oversized-string-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const ws = await connectGranted(owner, roomId);
    const closed = closeSignal(ws);

    ws.send('x'.repeat(MAX_BODY_BYTES + 1));

    expect(await closed).toBe(1009);
  });

  it('still relays a 1-byte binary frame to other granted peers', async () => {
    const owner = await bootstrapLocalSession('small-binary-owner');
    const editor = await bootstrapLocalSession('small-binary-editor');
    const roomId = 'small-binary-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);

    const sender = await connectGranted(owner, roomId);
    const receiver = await connectGranted(editor, roomId);

    const payload = new Uint8Array([0x42]);
    const received = nextBinaryMessage(receiver);
    sender.send(payload.buffer);

    expect(Array.from(new Uint8Array(await received))).toEqual([0x42]);
  });
});

describe('static asset serving', () => {
  it('serves the app shell at the root', async () => {
    const res = await accessFetch('/', 'room-worker-test');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves the placeholder room page for an arbitrary room URL', async () => {
    const res = await accessFetch(`/whiteboard/${'a'.repeat(32)}`, 'room-worker-test');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves the same page regardless of room id', async () => {
    const aRes = await accessFetch(`/whiteboard/${'a'.repeat(32)}`, 'room-worker-test');
    const bRes = await accessFetch(`/whiteboard/${'b'.repeat(32)}`, 'room-worker-test');
    expect(aRes.status).toBe(200);
    expect(bRes.status).toBe(200);
    const a = await aRes.text();
    const b = await bRes.text();
    // Per-response CSP nonces differ; the placeholder document is otherwise identical.
    const withoutNonce = (html: string) => html.replace(/\snonce="[a-f0-9]+"/g, '');
    expect(withoutNonce(a)).toBe(withoutNonce(b));
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
    const res = await SELF.fetch(`${BASE}/whiteboard/${'c'.repeat(32)}`);
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

  /**
   * The alarm resolving only means the Durable Object called close(); the close
   * event still has to be delivered to this side of the socket. Every
   * assertion here waits for that instead of racing it.
   */
  async function expectClosed(signal: { closed: boolean }) {
    await vi.waitFor(() => {
      expect(signal.closed).toBe(true);
    }, { timeout: SOCKET_EVENT_DEADLINE_MS, interval: 20 });
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

    await expectClosed(closed);
  });

  it('closes an established socket when the account is disabled', async () => {
    const roomId = 'revoke-room-disabled';
    const subject = await bootstrapLocalSession('revoke-disabled');
    const ws = await openSocket(roomId, subject);
    const closed = closeSignal(ws);

    await changeAccount('disable', subject.accountId);
    await runDurableObjectAlarm(roomStub(roomId));

    await expectClosed(closed);
  });

  it('evicts LiveKit when alarm closes revoked sockets after account disable', async () => {
    const roomId = 'revoke-livekit-disabled';
    const subject = await bootstrapLocalSession('revoke-livekit-disabled');
    await openSocket(roomId, subject);

    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      instance.liveKitEvictCalls = [];
      instance.evictLiveKitParticipant = async (input) => {
        instance.liveKitEvictCalls!.push({
          roomId: input.roomId,
          identity: input.identity,
        });
        return { ok: true };
      };
    });

    await changeAccount('disable', subject.accountId);
    await runDurableObjectAlarm(roomStub(roomId));

    // The alarm closes the socket and evicts from LiveKit asynchronously, so
    // reading the calls once races the eviction and saw an empty array on a
    // slow runner. Poll until it lands, or fail on the deadline.
    await vi.waitFor(async () => {
      const calls = await runInDurableObject(
        roomStub(roomId),
        (instance: RoomDO) => [...(instance.liveKitEvictCalls ?? [])],
      );
      expect(calls).toEqual([{ roomId, identity: subject.accountId }]);
    }, { timeout: SOCKET_EVENT_DEADLINE_MS, interval: 25 });
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

    await expectClosed(revoked);

    // Checked only once the revoked socket has actually closed, so this is a
    // real "the other account survived" assertion rather than one that passes
    // because nothing has happened yet.
    expect(survivor.closed).toBe(false);
  });
});

describe('kick closes live signaling sockets', () => {
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

  it('closes the kicked account signaling socket immediately without waiting for alarm', async () => {
    const owner = await bootstrapLocalSession('kick-signal-owner');
    const editor = await bootstrapLocalSession('kick-signal-editor');
    const roomId = 'kick-signal-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);
    const editorPeerId = await joinEditorPeer(editor, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const editorSocket = await connectGranted(editor, roomId);
    const editorClosed = closeSignal(editorSocket);

    const kick = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', peerId: editorPeerId }),
    });
    expect(kick.status).toBe(200);

    expect(await editorClosed).toBe(4401);
    expect(ownerSocket.readyState).toBe(WebSocket.OPEN);
  });

  it('does not relay binary frames from a kicked peer after its socket closes', async () => {
    const owner = await bootstrapLocalSession('kick-binary-owner');
    const editor = await bootstrapLocalSession('kick-binary-editor');
    const roomId = 'kick-binary-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);
    const editorPeerId = await joinEditorPeer(editor, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const editorSocket = await connectGranted(editor, roomId);
    const editorClosed = closeSignal(editorSocket);

    const kick = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', peerId: editorPeerId }),
    });
    expect(kick.status).toBe(200);
    expect(await editorClosed).toBe(4401);

    let received = false;
    ownerSocket.addEventListener('message', () => { received = true; }, { once: true });
    const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    try {
      editorSocket.send(payload.buffer);
    } catch {
      // Closed socket may reject send; either way the owner must not receive it.
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toBe(false);
  });
});

describe('kick and suspend evict LiveKit participant', () => {
  type LiveKitEvictCall = { roomId: string; identity: string };

  function roomStub(roomId: string) {
    return env.ROOMS.get(env.ROOMS.idFromName(roomId));
  }

  async function installEvictSpy(roomId: string) {
    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      instance.liveKitEvictCalls = [];
      instance.evictLiveKitParticipant = async (input) => {
        instance.liveKitEvictCalls!.push({
          roomId: input.roomId,
          identity: input.identity,
        });
        return { ok: true };
      };
    });
  }

  async function readEvictCalls(roomId: string): Promise<LiveKitEvictCall[]> {
    return runInDurableObject(
      roomStub(roomId),
      (instance: RoomDO) => [...(instance.liveKitEvictCalls ?? [])],
    );
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

  it('evicts LiveKit once when kicking an account', async () => {
    const owner = await bootstrapLocalSession('livekit-kick-owner');
    const editor = await bootstrapLocalSession('livekit-kick-editor');
    const roomId = 'livekit-kick-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);
    const editorPeerId = await joinEditorPeer(editor, roomId);

    await installEvictSpy(roomId);

    const kick = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', peerId: editorPeerId }),
    });
    expect(kick.status).toBe(200);

    expect(await readEvictCalls(roomId)).toEqual([
      { roomId, identity: editor.accountId },
    ]);
  });

  it('evicts LiveKit once when suspending an account', async () => {
    const owner = await bootstrapLocalSession('livekit-suspend-owner');
    const editor = await bootstrapLocalSession('livekit-suspend-editor');
    const roomId = 'livekit-suspend-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);
    const editorPeerId = await joinEditorPeer(editor, roomId);

    await installEvictSpy(roomId);

    const suspend = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'suspend', peerId: editorPeerId }),
    });
    expect(suspend.status).toBe(200);

    expect(await readEvictCalls(roomId)).toEqual([
      { roomId, identity: editor.accountId },
    ]);
  });

  it('still returns 200 when LiveKit eviction fails', async () => {
    const owner = await bootstrapLocalSession('livekit-fail-owner');
    const editor = await bootstrapLocalSession('livekit-fail-editor');
    const roomId = 'livekit-fail-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);
    const editorPeerId = await joinEditorPeer(editor, roomId);

    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      instance.evictLiveKitParticipant = async () => ({ ok: false, status: 503 });
    });

    const kick = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', peerId: editorPeerId }),
    });
    expect(kick.status).toBe(200);
  });
});

describe('kick increments room grant version', () => {
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

  it('increments grant_version and closes the kicked signaling socket', async () => {
    const owner = await bootstrapLocalSession('grant-kick-owner');
    const editor = await bootstrapLocalSession('grant-kick-editor');
    const roomId = 'grant-kick-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);
    const editorPeerId = await joinEditorPeer(editor, roomId);

    expect(await readGrantVersion(roomId)).toBe(0);

    const editorSocket = await connectGranted(editor, roomId);
    const editorClosed = closeSignal(editorSocket);

    const kick = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', peerId: editorPeerId }),
    });
    expect(kick.status).toBe(200);

    expect(await editorClosed).toBe(4401);
    expect(await readGrantVersion(roomId)).toBe(1);
  });

  it('still upgrades a different granted user after a kick', async () => {
    const owner = await bootstrapLocalSession('grant-survivor-owner');
    const kicked = await bootstrapLocalSession('grant-survivor-kicked');
    const survivor = await bootstrapLocalSession('grant-survivor-other');
    const roomId = 'grant-survivor-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, kicked, roomId);
    await grantEditor(owner, survivor, roomId);

    const kickedJoin = await joinPresence(kicked, roomId, 'kicked-peer', {
      userName: 'Kicked',
      color: '#3498db',
    });
    expect(kickedJoin.status).toBe(200);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', peerId: kickedJoin.peerId }),
    })).status).toBe(200);

    const res = await authenticatedFetch(`/signaling?room=${roomId}`, survivor, {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(101);
  });

  it('still denies the kicked account on presence and signaling', async () => {
    const owner = await bootstrapLocalSession('grant-ban-owner');
    const editor = await bootstrapLocalSession('grant-ban-editor');
    const roomId = 'grant-ban-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);
    const editorPeerId = await joinEditorPeer(editor, roomId);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', peerId: editorPeerId }),
    })).status).toBe(200);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, editor, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'new-peer', userName: 'Editor', color: '#3498db' }),
    })).status).toBe(403);

    const res = await authenticatedFetch(`/signaling?room=${roomId}`, editor, {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(403);
  });
});

describe('suspend increments room grant version', () => {
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

  function closeSignal(ws: WebSocket): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('socket was not closed immediately after suspend')),
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

  it('increments grant_version and closes the suspended signaling socket', async () => {
    const owner = await bootstrapLocalSession('grant-suspend-owner');
    const editor = await bootstrapLocalSession('grant-suspend-editor');
    const roomId = 'grant-suspend-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);
    const editorPeerId = await joinEditorPeer(editor, roomId);

    expect(await readGrantVersion(roomId)).toBe(0);

    const editorSocket = await connectGranted(editor, roomId);
    const editorClosed = closeSignal(editorSocket);

    const suspend = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'suspend', peerId: editorPeerId }),
    });
    expect(suspend.status).toBe(200);

    expect(await editorClosed).toBe(4401);
    expect(await readGrantVersion(roomId)).toBe(1);
  });
});

describe('stale grant version drops signaling publishes', () => {
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

  async function bumpGrantVersion(roomId: string): Promise<void> {
    await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => {
        instance.db.prepare(
          `UPDATE rooms SET grant_version = grant_version + 1 WHERE room_id = ?`,
        ).run(roomId);
      },
    );
  }

  it('does not relay binary when attachment grantVersion is stale', async () => {
    const owner = await bootstrapLocalSession('stale-binary-owner');
    const editor = await bootstrapLocalSession('stale-binary-editor');
    const roomId = 'stale-binary-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);
    await joinEditorPeer(editor, roomId);

    const ownerRes = await authenticatedFetch(`/signaling?room=${roomId}`, owner, {
      headers: { Upgrade: 'websocket' },
    });
    expect(ownerRes.status).toBe(101);
    const ownerSocket = ownerRes.webSocket!;
    ownerSocket.accept();

    const editorRes = await authenticatedFetch(`/signaling?room=${roomId}`, editor, {
      headers: { Upgrade: 'websocket' },
    });
    expect(editorRes.status).toBe(101);
    const editorSocket = editorRes.webSocket!;
    editorSocket.accept();

    await bumpGrantVersion(roomId);

    let received = false;
    ownerSocket.addEventListener('message', () => { received = true; }, { once: true });
    editorSocket.send(new Uint8Array([0x01, 0x02, 0x03, 0x04]).buffer);
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toBe(false);
  });

  it('does not relay publish JSON when attachment grantVersion is stale', async () => {
    const owner = await bootstrapLocalSession('stale-publish-owner');
    const editor = await bootstrapLocalSession('stale-publish-editor');
    const roomId = 'stale-publish-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);
    await joinEditorPeer(editor, roomId);

    const ownerRes = await authenticatedFetch(`/signaling?room=${roomId}`, owner, {
      headers: { Upgrade: 'websocket' },
    });
    expect(ownerRes.status).toBe(101);
    const ownerSocket = ownerRes.webSocket!;
    ownerSocket.accept();

    const editorRes = await authenticatedFetch(`/signaling?room=${roomId}`, editor, {
      headers: { Upgrade: 'websocket' },
    });
    expect(editorRes.status).toBe(101);
    const editorSocket = editorRes.webSocket!;
    editorSocket.accept();

    await bumpGrantVersion(roomId);

    let received = false;
    ownerSocket.addEventListener('message', () => { received = true; }, { once: true });
    editorSocket.send(JSON.stringify({
      type: 'publish',
      topic: 'room',
      data: { peerId: 'editor-peer' },
    }));
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toBe(false);
  });

  it('closes the socket with 4401 when grantVersion is stale on a subscribe frame', async () => {
    const owner = await bootstrapLocalSession('stale-close-owner');
    const editor = await bootstrapLocalSession('stale-close-editor');
    const roomId = 'stale-close-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);
    await joinEditorPeer(editor, roomId);

    const ownerRes = await authenticatedFetch(`/signaling?room=${roomId}`, owner, {
      headers: { Upgrade: 'websocket' },
    });
    expect(ownerRes.status).toBe(101);
    ownerRes.webSocket!.accept();

    const editorRes = await authenticatedFetch(`/signaling?room=${roomId}`, editor, {
      headers: { Upgrade: 'websocket' },
    });
    expect(editorRes.status).toBe(101);
    const editorSocket = editorRes.webSocket!;
    editorSocket.accept();

    await bumpGrantVersion(roomId);

    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('stale socket was not closed')),
        2_000,
      );
      editorSocket.addEventListener('close', (event: CloseEvent) => {
        clearTimeout(timer);
        resolve(event.code);
      }, { once: true });
    });

    editorSocket.send(JSON.stringify({ type: 'subscribe', topics: ['room'] }));
    expect(await closed).toBe(4401);
  });

  it('closes the socket with 4401 when grantVersion is stale on a ping frame', async () => {
    const owner = await bootstrapLocalSession('stale-ping-owner');
    const editor = await bootstrapLocalSession('stale-ping-editor');
    const roomId = 'stale-ping-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);
    await joinEditorPeer(editor, roomId);

    const editorRes = await authenticatedFetch(`/signaling?room=${roomId}`, editor, {
      headers: { Upgrade: 'websocket' },
    });
    expect(editorRes.status).toBe(101);
    const editorSocket = editorRes.webSocket!;
    editorSocket.accept();

    await bumpGrantVersion(roomId);

    let pongReceived = false;
    editorSocket.addEventListener('message', () => { pongReceived = true; }, { once: true });

    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('stale socket was not closed on ping')),
        2_000,
      );
      editorSocket.addEventListener('close', (event: CloseEvent) => {
        clearTimeout(timer);
        resolve(event.code);
      }, { once: true });
    });

    editorSocket.send(JSON.stringify({ type: 'ping' }));
    expect(await closed).toBe(4401);
    await new Promise((r) => setTimeout(r, 100));
    expect(pongReceived).toBe(false);
  });
});

describe('alarm purges expired editor grants', () => {
  function roomStub(roomId: string) {
    return env.ROOMS.get(env.ROOMS.idFromName(roomId));
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

  it('deletes expired editor rows and refuses signaling reconnect', async () => {
    const owner = await bootstrapLocalSession('purge-expired-owner');
    const editor = await bootstrapLocalSession('purge-expired-editor');
    const roomId = 'purge-expired-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);

    const open = await authenticatedFetch(`/signaling?room=${roomId}`, editor, {
      headers: { Upgrade: 'websocket' },
    });
    expect(open.status).toBe(101);
    open.webSocket!.accept();

    await runInDurableObject(
      roomStub(roomId),
      (instance: RoomDO) => {
        instance.db.prepare(
          `UPDATE room_members SET expires_at = 1 WHERE room_id = ? AND account_id = ?`,
        ).run(roomId, editor.accountId);
      },
    );

    await runDurableObjectAlarm(roomStub(roomId));

    const row = await runInDurableObject(
      roomStub(roomId),
      (instance: RoomDO) => instance.db.prepare(
        `SELECT role FROM room_members WHERE room_id = ? AND account_id = ?`,
      ).get(roomId, editor.accountId),
    );
    expect(row).toBeUndefined();

    const reconnect = await authenticatedFetch(`/signaling?room=${roomId}`, editor, {
      headers: { Upgrade: 'websocket' },
    });
    expect(reconnect.status).toBe(403);
  });

  it('purges expired waiting and kicked rows on alarm even with no sockets', async () => {
    const owner = await bootstrapLocalSession('idle-purge-owner');
    const roomId = 'idle-purge-room';
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const waitingTtl = 24 * 60 * 60 * 1000;
    const kickedTtl = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      instance.db.prepare(
        `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
         VALUES (?, 'stale-wait', 'Wait', '#111111', ?, 'w-stale')`,
      ).run(roomId, now - waitingTtl);
      instance.db.prepare(
        `INSERT INTO kicked_peers (room_id, peer_id, kicked_at) VALUES (?, 'stale-kick', ?)`,
      ).run(roomId, now - kickedTtl);
      instance.db.prepare(
        `INSERT INTO room_members (
           room_id, account_id, role, display_name, email,
           requested_at, created_at, updated_at, expires_at
         ) VALUES (?, 'stale-pending', 'pending', NULL, NULL, ?, ?, ?, NULL)`,
      ).run(roomId, now - waitingTtl, now, now);
    });

    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => instance.alarm());

    const leftover = await runInDurableObject(roomStub(roomId), (instance: RoomDO) => ({
      waiting: instance.db.prepare(
        `SELECT COUNT(*) AS n FROM waiting_peers WHERE room_id = ?`,
      ).get(roomId) as { n: number },
      kicked: instance.db.prepare(
        `SELECT COUNT(*) AS n FROM kicked_peers WHERE room_id = ?`,
      ).get(roomId) as { n: number },
      pending: instance.db.prepare(
        `SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND account_id = 'stale-pending'`,
      ).get(roomId) as { n: number },
    }));
    expect(leftover.waiting.n).toBe(0);
    expect(leftover.kicked.n).toBe(0);
    expect(leftover.pending.n).toBe(0);
  });

  it('purges expired waiting rows on the next successful HTTP request', async () => {
    const owner = await bootstrapLocalSession('http-purge-owner');
    const roomId = 'http-purge-room';
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const waitingTtl = 24 * 60 * 60 * 1000;
    const now = Date.now();

    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      instance.db.prepare(
        `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
         VALUES (?, 'stale-wait', 'Wait', '#111111', ?, 'w-stale')`,
      ).run(roomId, now - waitingTtl);
    });

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner)).status).toBe(200);

    const leftover = await runInDurableObject(
      roomStub(roomId),
      (instance: RoomDO) => instance.db.prepare(
        `SELECT COUNT(*) AS n FROM waiting_peers WHERE room_id = ?`,
      ).get(roomId) as { n: number },
    );
    expect(leftover.n).toBe(0);
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
    owner = await bootstrapLocalSession(`matrix-owner-${crypto.randomUUID()}`);
    outsider = await bootstrapLocalSession(`matrix-outsider-${crypto.randomUUID()}`);
  });

  async function createRoomAs(who: LocalAuthSession, roomId: string, body: Record<string, unknown> = {}) {
    return writeRoom(roomId, who, body);
  }

  function joinAs(who: LocalAuthSession, roomId: string, peerId: string) {
    return joinPresence(who, roomId, peerId);
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

    const members = await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName('matrix-closed')),
      (instance: RoomDO) => instance.db.prepare(
        `SELECT account_id AS accountId, role FROM room_members WHERE room_id = ?`,
      ).all('matrix-closed') as Array<{ accountId: string; role: string }>,
    );
    expect(members).toEqual([{ accountId: owner.accountId, role: 'owner' }]);
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
    const guest = await joinAs(outsider, roomId, 'guest-peer');

    const del = await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/presence?peerId=${encodeURIComponent(guest.peerId)}`,
      owner,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(403);

    // guest-peer is a non-host peer, so it's queued in the waiting list rather
    // than admitted straight into room_presence — the refused delete must
    // leave it there either way.
    const presence = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner);
    const data = (await presence.json()) as { waitingPeers: Array<{ peerId: string }> };
    expect(data.waitingPeers.map((p) => p.peerId)).toContain(guest.peerId);
  });

  it('does not let an outsider occupy the owner peer label by posting it', async () => {
    const roomId = `sec004-owner-label-${crypto.randomUUID()}`;
    await createRoomAs(owner, roomId);
    const ownerJoin = await joinAs(owner, roomId, 'host-peer');
    expect(ownerJoin.status).toBe(200);
    const ownerBody = await ownerJoin.res.json() as {
      peerId: string;
      users: Array<{ peerId: string }>;
    };
    const ownerPeerId = ownerJoin.peerId;
    expect(ownerPeerId).toMatch(/^user-[0-9a-f]{32}$/);
    expect(ownerPeerId).not.toBe('host-peer');
    expect(ownerBody.users.map((user) => user.peerId)).toContain(ownerPeerId);

    const hijack = await joinAs(outsider, roomId, ownerPeerId);
    if (hijack.ok) {
      expect(hijack.peerId).not.toBe(ownerPeerId);
    } else {
      expect(hijack.status).toBe(403);
    }

    const presence = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner);
    const data = await presence.json() as {
      users: Array<{ peerId: string }>;
      waitingPeers: Array<{ peerId: string }>;
    };
    expect(data.users.map((user) => user.peerId)).toContain(ownerPeerId);
    expect(data.waitingPeers.map((peer) => peer.peerId)).not.toContain(ownerPeerId);
  });

  it('refuses claiming a peerId already bound to another account', async () => {
    const roomId = 'matrix-presence-claim';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');
    const guest = await joinAs(outsider, roomId, 'guest-peer');

    const hijack = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: guest.peerId, userName: 'Hijacker', color: '#000000' }),
    });
    expect(hijack.status).toBe(403);

    // Untouched: the peer's original name from joinAs, not the hijack attempt.
    // guest-peer is a non-host peer, so it's in the waiting list, not
    // room_presence.
    const presence = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner);
    const data = (await presence.json()) as { waitingPeers: Array<{ peerId: string; userName: string }> };
    expect(data.waitingPeers.find((p) => p.peerId === guest.peerId)?.userName).toBe('guest-peer');
  });

  it('does not transfer a peer to the moderator when the owner suspends it', async () => {
    const roomId = 'matrix-presence-moderate-binding';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');
    const guest = await joinAs(outsider, roomId, 'guest-peer');
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: guest.peerId, action: 'approve' }),
    });
    // Re-join so the admitted presence row is bound to the guest's account.
    await joinAs(outsider, roomId, 'guest-peer');

    const suspend = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'suspend', peerId: guest.peerId }),
    });
    expect(suspend.status).toBe(200);

    // Moderating a peer names someone else's peer. It must not rebind that
    // peer to the moderator's account, or the real owner would be locked out
    // of its own leave. After suspend the account is pending, so leave is
    // the waiting-queue withdraw, not a granted presence heartbeat.
    const selfDelete = await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/waiting?peerId=${encodeURIComponent(guest.peerId)}`,
      outsider,
      { method: 'DELETE' },
    );
    expect(selfDelete.status).toBe(200);
  });

  it('lets a caller remove its own peer', async () => {
    const roomId = 'matrix-presence-self-delete';
    await createRoomAs(owner, roomId);
    const host = await joinAs(owner, roomId, 'host-peer');

    const del = await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/presence?peerId=${encodeURIComponent(host.peerId)}`,
      owner,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(200);

    const presence = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner);
    const data = (await presence.json()) as { users: Array<{ peerId: string }> };
    expect(data.users.map((u) => u.peerId)).not.toContain(host.peerId);
  });

  it('does not grant host status from hostPeerId when the peer is not the owner', async () => {
    const roomId = 'matrix-no-host-fallback';
    const editor = await bootstrapLocalSession('matrix-labeled-host');
    await createRoomAs(owner, roomId, { hostPeerId: 'solo-peer' });
    await grantPublicRole(owner, editor, roomId, 'peer');
    const editorJoin = await joinAs(editor, roomId, 'solo-peer');

    const presence = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, editor);
    const data = (await presence.json()) as { users: Array<{ peerId: string; isHost: boolean }> };
    expect(data.users).toEqual([
      expect.objectContaining({ peerId: editorJoin.peerId, isHost: false }),
    ]);
  });

  it('grants membership when the owner approves a waiting peer', async () => {
    const roomId = 'matrix-approval';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');

    // The guest is queued, and cannot read the board yet.
    const guest = await joinAs(outsider, roomId, 'guest-peer');
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(403);

    const approve = await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: guest.peerId, action: 'approve' }),
    });
    expect(approve.status).toBe(200);

    // Admission is what grants the board, and it survives the peer going idle.
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(200);
  });

  it('does not let an approved member delete the room', async () => {
    const roomId = 'matrix-member-delete';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');
    const guest = await joinAs(outsider, roomId, 'guest-peer');
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: guest.peerId, action: 'approve' }),
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
    const guest = await joinAs(outsider, roomId, 'guest-peer');

    await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: guest.peerId, action: 'approve' }),
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
    const guest = await joinAs(outsider, roomId, 'guest-peer');
    await joinAs(other, roomId, 'other-peer');

    const approve = await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: guest.peerId,
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
    const host = await joinAs(owner, roomId, 'creator-peer');

    expect((await joinAs(attacker, roomId, host.peerId)).status).toBe(403);
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
    const guest = await joinAs(outsider, roomId, 'guest-peer');
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: guest.peerId, action: 'approve' }),
    });
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(200);

    const hijack = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, attacker, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: guest.peerId, userName: 'Nope', color: '#000000' }),
    });
    expect(hijack.status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, attacker)).status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(200);
  });

  it('denies later requests from a kicked account even with a new peerId', async () => {
    const roomId = 'matrix-kick-survives-peer';
    await createRoomAs(owner, roomId);
    await joinAs(owner, roomId, 'host-peer');
    const guest = await joinAs(outsider, roomId, 'guest-peer');
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: guest.peerId, action: 'approve' }),
    });
    await joinAs(outsider, roomId, 'guest-peer');

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', peerId: guest.peerId }),
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
    expect(statuses[0]).toBe(200);
    // Which refusal the loser gets depends on whether the two creates actually
    // overlapped. A sequential second create is stopped by authorize(), which
    // sees the room and returns 403. A genuine overlap passes that check --
    // the room did not exist yet for either request -- and is stopped by the
    // create path instead, which reports the collision as 409 (the documented
    // "existing room -> 409" behaviour). Both are correct refusals; the
    // invariant under test is that exactly one owner row survives.
    expect([403, 409]).toContain(statuses[1]);

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

    const pending = await joinAs(outsider, roomId, 'pending-peer');
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, outsider)).status).toBe(403);

    const afterPending = await roomTables(roomId);
    expect(afterPending.rooms).toEqual(before.rooms);

    await joinAs(owner, roomId, 'host-peer');
    await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: pending.peerId, action: 'approve' }),
    });
    await joinAs(outsider, roomId, 'pending-peer');
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', peerId: pending.peerId }),
    })).status).toBe(200);

    const afterKick = await roomTables(roomId);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider)).status).toBe(403);
    expect(await roomTables(roomId)).toEqual(afterKick);
  });

  it('lets a viewer read the board but not publish scene or settings', async () => {
    const roomId = 'matrix-viewer-write';
    const viewer = await bootstrapLocalSession('matrix-viewer');
    await createRoomAs(owner, roomId, { name: 'Original', maxUsers: 2 });
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
    await createRoomAs(owner, roomId, { name: 'Original', maxUsers: 2 });
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
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, editor, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'queued-peer', action: 'approve' }),
    })).status).toBe(403);
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
    const guest = await joinAs(outsider, roomId, 'guest-peer');

    const queue = await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner);
    expect(queue.status).toBe(200);
    expect(await queue.json()).toMatchObject({
      waitingPeers: [expect.objectContaining({ peerId: guest.peerId })],
    });

    const requests = await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, owner);
    expect(requests.status).toBe(200);
    const listed = await requests.json() as { requests: Array<{ email: string | null; requestId: string }> };
    expect(listed.requests.some((row) => row.requestId === outsider.accountId)).toBe(true);

    const presence = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner);
    const data = await presence.json() as { waitingPeers: Array<{ peerId: string }> };
    expect(data.waitingPeers.map((p) => p.peerId)).toContain(guest.peerId);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: guest.peerId, action: 'approve' }),
    })).status).toBe(200);
  });

  it('lets the owner read settings without scene fields', async () => {
    const roomId = 'matrix-owner-get-settings';
    await createRoomAs(owner, roomId, { name: 'Readable', maxUsers: 2, allowFirstUserHost: true });
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
      maxUsers: 2,
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
    await createRoomAs(owner, roomId, { name: 'Original', maxUsers: 2 });
    await grantPublicRole(owner, editor, roomId, 'peer');

    const ownerPatch = await authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, owner, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', maxUsers: 1, allowFirstUserHost: true }),
    });
    expect(ownerPatch.status).toBe(200);
    expect(await ownerPatch.json()).toMatchObject({
      name: 'Renamed',
      maxUsers: 1,
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

  it('rejects missing, malformed, and expired credentials on every room HTTP route without mutating tables', { timeout: 20_000 }, async () => {
    const roomId = `matrix-cred-table-${crypto.randomUUID()}`;
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

  it('rejects wrong-room and wrong-role callers on every protected route without mutating tables', { timeout: 40_000 }, async () => {
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

  it('does not return board bytes or waiting-queue PII to pending or anonymous callers', { timeout: 20_000 }, async () => {
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
    const guest = await joinAs(outsider, roomId, 'guest-peer');

    const ownerBoard = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner);
    expect(await ownerBoard.json()).toMatchObject({
      name: secret.boardName,
      elements: [expect.objectContaining({ id: 'secret-dot' })],
    });
    const ownerQueue = await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner);
    expect(await ownerQueue.json()).toMatchObject({
      waitingPeers: [expect.objectContaining({ peerId: guest.peerId })],
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
    expect(await roomTables(roomId)).toEqual(before);
    expect(await (await authenticatedFetch(`/api/whiteboard/room/${roomId}/access`, editor)).json())
      .toEqual({ status: 'none' });
    expect(await roomTables(roomId)).toEqual({
      ...before,
      members: before.members.filter((row) => row.accountId !== editor.accountId),
    });
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

describe('SEC-005 room existence before persist', () => {
  it('returns 404 and writes nothing when POSTing presence to a never-created room', async () => {
    const who = await bootstrapLocalSession('sec005-presence-missing');
    const roomId = `sec005-never-${crypto.randomUUID()}`;

    const res = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, who, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'ghost-peer',
        userName: 'Ghost',
        color: '#3498db',
      }),
    });
    expect(res.status).toBe(404);

    const counts = await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => {
        const count = (table: string) =>
          (instance.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE room_id = ?`).get(roomId) as {
            n: number;
          }).n;
        return {
          waiting: count('waiting_peers'),
          presence: count('room_presence'),
          members: count('room_members'),
        };
      },
    );
    expect(counts.waiting).toBe(0);
    expect(counts.presence).toBe(0);
    expect(counts.members).toBe(0);
  });

  it('returns 404 for a signaling upgrade when the room was never created', async () => {
    const who = await bootstrapLocalSession('sec005-signaling-missing');
    const roomId = `sec005-sig-${crypto.randomUUID()}`;
    const res = await authenticatedFetch(`/signaling?room=${roomId}`, who, {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(404);
    expect(res.webSocket).toBeNull();
  });

  it('still reports access status none for a never-created room so create quotas can apply', async () => {
    const who = await bootstrapLocalSession('sec005-access-missing');
    const roomId = `sec005-access-${crypto.randomUUID()}`;
    const res = await authenticatedFetch(`/api/whiteboard/room/${roomId}/access`, who);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'none' });
  });
});

describe('raise hand presence action', () => {
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

  it('lets an admitted editor raise a hand that GET presence and heartbeats still report', async () => {
    const owner = await bootstrapLocalSession(`raise-owner-${crypto.randomUUID()}`);
    const editor = await bootstrapLocalSession(`raise-editor-${crypto.randomUUID()}`);
    const roomId = `raise-hand-${crypto.randomUUID()}`;

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);
    const editorPeerId = await joinEditorPeer(editor, roomId);
    await joinPresence(owner, roomId, 'host-peer', { userName: 'Host' });

    const raised = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, editor, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'raise-hand' }),
    });
    expect(raised.status).toBe(200);
    const raisedBody = await raised.json() as { users: Array<{ peerId: string; handRaised?: boolean }> };
    expect(raisedBody.users.find((user) => user.peerId === editorPeerId)?.handRaised).toBe(true);

    const listed = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { users: Array<{ peerId: string; handRaised?: boolean }> };
    expect(listedBody.users.find((user) => user.peerId === editorPeerId)?.handRaised).toBe(true);

    const heartbeat = await joinPresence(editor, roomId, 'editor-peer', { userName: 'Editor' });
    expect(heartbeat.status).toBe(200);
    const heartbeatBody = await heartbeat.res.json() as {
      users: Array<{ peerId: string; handRaised?: boolean }>;
    };
    expect(heartbeatBody.users.find((user) => user.peerId === editorPeerId)?.handRaised).toBe(true);
  });

  it('rejects raise-hand from an outsider', async () => {
    const owner = await bootstrapLocalSession(`raise-out-owner-${crypto.randomUUID()}`);
    const outsider = await bootstrapLocalSession(`raise-out-${crypto.randomUUID()}`);
    const roomId = `raise-out-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const raised = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, outsider, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'raise-hand' }),
    });
    expect(raised.status).toBe(403);
  });
});

describe('guest-verify route', () => {
  async function guestVerify(roomId: string, pin: string) {
    const res = await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => {
        return instance.fetch(
          new Request('https://room/room/guest-verify?roomId=' + roomId, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pin }),
          }),
        );
      },
    );
    return { status: res.status, body: await res.text() };
  }

  it('returns 200 { ok: true } for a valid PIN on a guest-enabled room', async () => {
    const owner = await bootstrapLocalSession(`guest-verify-owner-${crypto.randomUUID()}`);
    const roomId = `guest-verify-room-valid-${crypto.randomUUID()}`;

    // Create and enable guest access
    await writeRoom(roomId, owner);
    const pin = await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => {
        return issueGuestPin(instance.db, roomId, Date.now());
      },
    );

    const res = await guestVerify(roomId, pin);
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json).toEqual({ ok: true });
  });

  it('returns 403 with generic body for wrong PIN', async () => {
    const owner = await bootstrapLocalSession(`guest-verify-wrong-pin-${crypto.randomUUID()}`);
    const roomId = `guest-verify-room-wrong-${crypto.randomUUID()}`;

    await writeRoom(roomId, owner);
    await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => {
        return issueGuestPin(instance.db, roomId, Date.now());
      },
    );

    const res = await guestVerify(roomId, '000000');
    expect(res.status).toBe(403);
  });

  it('returns 403 with generic body for guest-disabled room', async () => {
    const owner = await bootstrapLocalSession(`guest-verify-disabled-${crypto.randomUUID()}`);
    const roomId = `guest-verify-room-disabled-${crypto.randomUUID()}`;

    await writeRoom(roomId, owner);
    // guest_access defaults to 0, so room is guest-disabled

    const res = await guestVerify(roomId, '123456');
    expect(res.status).toBe(403);
  });

  it('returns 403 with generic body for missing room', async () => {
    const nonexistent = `guest-verify-nonexistent-${crypto.randomUUID()}`;
    const res = await guestVerify(nonexistent, '123456');
    expect(res.status).toBe(403);
  });

  it('returns 403 with generic body for expired PIN', async () => {
    const owner = await bootstrapLocalSession(`guest-verify-expired-${crypto.randomUUID()}`);
    const roomId = `guest-verify-room-expired-${crypto.randomUUID()}`;

    await writeRoom(roomId, owner);
    const now = Date.now();
    await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => {
        return issueGuestPin(instance.db, roomId, now - 13 * 60 * 60 * 1000); // 13 hours ago
      },
    );

    const res = await guestVerify(roomId, '123456');
    expect(res.status).toBe(403);
  });

  it('returns 403 with generic body for locked-out room even with correct PIN', async () => {
    const owner = await bootstrapLocalSession(`guest-verify-lockout-${crypto.randomUUID()}`);
    const roomId = `guest-verify-room-lockout-${crypto.randomUUID()}`;

    await writeRoom(roomId, owner);
    const pin = await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => {
        const p = issueGuestPin(instance.db, roomId, Date.now());
        // Manually set lockout
        instance.db.prepare(
          'UPDATE rooms SET guest_lockout_until = ? WHERE room_id = ?'
        ).run(Date.now() + 15 * 60 * 1000, roomId);
        return p;
      },
    );

    const res = await guestVerify(roomId, pin);
    expect(res.status).toBe(403);
  });

  it('returns byte-identical 403 responses for wrong PIN and guest-disabled', async () => {
    const owner = await bootstrapLocalSession(`guest-verify-byte-eq-${crypto.randomUUID()}`);
    const wrongRoomId = `guest-verify-room-wrong-eq-${crypto.randomUUID()}`;
    const disabledRoomId = `guest-verify-room-disabled-eq-${crypto.randomUUID()}`;

    await writeRoom(wrongRoomId, owner);
    await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(wrongRoomId)),
      (instance: RoomDO) => {
        return issueGuestPin(instance.db, wrongRoomId, Date.now());
      },
    );

    await writeRoom(disabledRoomId, owner);
    // disabled room has guest_access = 0

    const wrongRes = await guestVerify(wrongRoomId, '000000');
    const disabledRes = await guestVerify(disabledRoomId, '123456');

    expect(wrongRes.status).toBe(disabledRes.status);
    expect(wrongRes.body).toBe(disabledRes.body);
  });

  it('returns multi-case byte-identical 403 responses (wrong PIN, guest-disabled, non-existent)', async () => {
    const owner = await bootstrapLocalSession(`guest-verify-byte-multi-${crypto.randomUUID()}`);
    const wrongPinRoomId = `gvbyte-wrong-${crypto.randomUUID().slice(0,8)}`;
    const disabledRoomId = `gvbyte-disabled-${crypto.randomUUID().slice(0,8)}`;
    const nonexistentRoomId = `gvbyte-nonexist-${crypto.randomUUID().slice(0,8)}`;

    // Setup room with enabled guest access for wrong PIN test
    await writeRoom(wrongPinRoomId, owner);
    await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(wrongPinRoomId)),
      (instance: RoomDO) => {
        return issueGuestPin(instance.db, wrongPinRoomId, Date.now());
      },
    );

    // Setup disabled room
    await writeRoom(disabledRoomId, owner);

    // Get all three guest-verify responses
    const wrongPinRes = await guestVerify(wrongPinRoomId, '000000');
    const disabledRes = await guestVerify(disabledRoomId, '123456');
    const nonexistentRes = await guestVerify(nonexistentRoomId, '123456');

    // All must have the same status (generic 403 oracle protection)
    expect(wrongPinRes.status).toBe(403);
    expect(disabledRes.status).toBe(403);
    expect(nonexistentRes.status).toBe(403);

    // Body text must be byte-identical (no distinguishing information)
    expect(wrongPinRes.body).toBe(disabledRes.body);
    expect(wrongPinRes.body).toBe(nonexistentRes.body);
  });

  it('tombstoned room returns generic 403 (oracle protection) via direct RoomDO call', async () => {
    const roomId = `gvtomb-${crypto.randomUUID().slice(0,8)}`;

    // Create room, then manually tombstone it in the DO
    await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => {
        // Issue a PIN first
        issueGuestPin(instance.db, roomId, Date.now());
        // Manually tombstone it by marking it as deleted
        instance.db.prepare('INSERT OR REPLACE INTO room_tombstones (room_id, deleted_at) VALUES (?, ?)').run(roomId, Date.now());
        return Promise.resolve(new Response(''));
      },
    );

    // Verify it's actually tombstoned: authenticated request returns 410
    const tombstoneCheckRes = await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => {
        return instance.fetch(
          new Request('https://room/room?roomId=' + roomId + '&accountId=test', {
            method: 'GET',
          }),
        );
      },
    );
    expect(tombstoneCheckRes.status).toBe(410);

    // Now verify guest-verify returns generic 403 for tombstoned room
    const guestVerifyRes = await guestVerify(roomId, '123456');
    expect(guestVerifyRes.status).toBe(403);
  });

  it('returns 401 for empty section without accountId', async () => {
    const res = await SELF.fetch('https://example.com/api/whiteboard/room/test-room', {
      method: 'GET',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for /settings without accountId', async () => {
    const res = await SELF.fetch('https://example.com/api/whiteboard/room/test-room/settings', {
      method: 'GET',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for /presence without accountId', async () => {
    const res = await SELF.fetch('https://example.com/api/whiteboard/room/test-room/presence', {
      method: 'GET',
    });
    expect(res.status).toBe(401);
  });

  it('response does not contain room name, members, queue, or PIN', async () => {
    const owner = await bootstrapLocalSession(`guest-verify-no-pii-${crypto.randomUUID()}`);
    const roomId = `guest-verify-room-pii-${crypto.randomUUID()}`;

    await writeRoom(roomId, owner, { name: 'Secret Class' });
    const pin = await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => {
        return issueGuestPin(instance.db, roomId, Date.now());
      },
    );

    const res = await guestVerify(roomId, pin);
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body).not.toContain('Secret Class');
    expect(body).not.toContain('name');
    expect(body).not.toContain('member');
    expect(body).not.toContain('queue');
    expect(body).not.toContain(pin);
  });

  // Regression: control flow ordering - accountId check must come BEFORE tombstone check for non-guest routes
  it('returns 401 (not 410) for tombstoned room without accountId on non-guest section', async () => {
    const owner = await bootstrapLocalSession(`ordering-regression-${crypto.randomUUID()}`);
    const roomId = `ordering-regression-room-${crypto.randomUUID()}`;

    await writeRoom(roomId, owner);
    await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, { method: 'DELETE' });

    // Call RoomDO directly with tombstoned room and no accountId on the empty section
    const res = await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => {
        return instance.fetch(
          new Request('https://room/room?roomId=' + roomId, {
            method: 'GET',
          }),
        );
      },
    );

    // Must return 401 (accountId required) not 410 (tombstone)
    expect(res.status).toBe(401);
  });

  it('returns 401 (not 410) for tombstoned room without accountId on /presence', async () => {
    const owner = await bootstrapLocalSession(`ordering-presence-${crypto.randomUUID()}`);
    const roomId = `ordering-presence-room-${crypto.randomUUID()}`;

    await writeRoom(roomId, owner);
    await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, { method: 'DELETE' });

    const res = await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => {
        return instance.fetch(
          new Request('https://room/room/presence?roomId=' + roomId, {
            method: 'GET',
          }),
        );
      },
    );

    // Must return 401 (accountId required) not 410 (tombstone)
    expect(res.status).toBe(401);
  });

  it('returns 410 for tombstoned room WITH accountId', async () => {
    const owner = await bootstrapLocalSession(`ordering-with-account-${crypto.randomUUID()}`);
    const roomId = `ordering-with-account-room-${crypto.randomUUID()}`;

    await writeRoom(roomId, owner);
    await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, { method: 'DELETE' });

    const res = await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)),
      (instance: RoomDO) => {
        return instance.fetch(
          new Request('https://room/room?roomId=' + roomId + '&accountId=' + owner.accountId, {
            method: 'GET',
          }),
        );
      },
    );

    // With valid accountId, tombstone response should be returned (410)
    expect(res.status).toBe(410);
  });
});

describe('guest authorization matrix', () => {
  let owner: LocalAuthSession;
  let guest: LocalAuthSession;
  let roomId: string;

  beforeEach(async () => {
    owner = await bootstrapLocalSession(`guest-owner-${crypto.randomUUID()}`);
    guest = await bootstrapLocalSession(`guest-account-${crypto.randomUUID()}`);
    roomId = `guest-room-${crypto.randomUUID()}`;
    // Create room as owner
    expect((await writeRoom(roomId, owner, { name: 'Guest Test Room' })).status).toBe(200);
  });

  // Helper to call RoomDO directly as guest
  async function guestFetch(
    path: string,
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH' = 'GET',
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const roomStub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    return runInDurableObject(roomStub, (instance: RoomDO) => {
      // Extract path and query string if present
      const [pathPart, queryPart] = path.split('?');
      const baseUrl = `https://room/room${pathPart}`;
      // Build full URL with both existing query params and our auth params
      const separator = queryPart ? '&' : '?';
      const url = `${baseUrl}${queryPart ? '?' + queryPart + '&' : '?'}roomId=${roomId}&accountId=${guest.accountId}&guest=1`;
      const request = new Request(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return instance.fetch(request);
    });
  }

  // Helper to approve guest as editor
  async function approveGuestAsEditor() {
    const approval = await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/requests/${guest.accountId}`,
      owner,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role: 'peer' }),
      },
    );
    expect(approval.status).toBe(200);
    // Verify the approval succeeded by checking the member role
    const access = await authenticatedFetch(`/api/whiteboard/room/${roomId}/access`, guest);
    const accessData = await access.json() as { role?: string };
    expect(accessData.role).toBe('peer');
  }

  // Helper to approve guest as viewer
  async function approveGuestAsViewer() {
    const approval = await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/requests/${guest.accountId}`,
      owner,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role: 'viewer' }),
      },
    );
    expect(approval.status).toBe(200);
    // Verify the approval succeeded
    const access = await authenticatedFetch(`/api/whiteboard/room/${roomId}/access`, guest);
    const accessData = await access.json() as { role?: string };
    expect(accessData.role).toBe('viewer');
  }

  describe('guest denials', () => {
    it('denies POST /room on non-existent room (create)', async () => {
      const newRoomId = `guest-create-denied-${crypto.randomUUID()}`;
      const roomStub = env.ROOMS.get(env.ROOMS.idFromName(newRoomId));
      const res = await runInDurableObject(roomStub, (instance: RoomDO) => {
        const url = `https://room/room?roomId=${newRoomId}&accountId=${guest.accountId}&guest=1`;
        return instance.fetch(
          new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ elements: [] }),
          }),
        );
      });
      expect(res.status).toBe(403);
    });

    it('denies DELETE /room', async () => {
      const res = await guestFetch('', 'DELETE');
      expect(res.status).toBe(403);
    });

    it('denies GET /settings', async () => {
      const res = await guestFetch('/settings', 'GET');
      expect(res.status).toBe(403);
    });

    it('denies POST /settings', async () => {
      const res = await guestFetch('/settings', 'POST', { name: 'Hacked' });
      expect(res.status).toBe(403);
    });

    it('denies PATCH /settings', async () => {
      const res = await guestFetch('/settings', 'PATCH', { name: 'Hacked' });
      expect(res.status).toBe(403);
    });

    it('denies GET /waiting', async () => {
      const res = await guestFetch('/waiting', 'GET');
      expect(res.status).toBe(403);
    });

    it('denies GET /requests', async () => {
      const res = await guestFetch('/requests', 'GET');
      expect(res.status).toBe(403);
    });

    it('denies POST /requests/:rid (approve)', async () => {
      const res = await guestFetch(`/requests/${guest.accountId}`, 'POST', {
        action: 'approve',
        role: 'peer',
      });
      expect(res.status).toBe(403);
    });

    it('denies POST /presence with action kick', async () => {
      const res = await guestFetch('/presence', 'POST', { action: 'kick', peerId: 'some-peer' });
      expect(res.status).toBe(403);
    });

    it('denies POST /presence with action suspend', async () => {
      const res = await guestFetch('/presence', 'POST', { action: 'suspend', peerId: 'some-peer' });
      expect(res.status).toBe(403);
    });
  });

  describe('guest permissions', () => {
    it('allows POST /requests (self) and stores email as NULL', async () => {
      const res = await guestFetch('/requests', 'POST', { userName: 'Guest User' });
      expect(res.status).toBe(201);

      // Verify email is NULL in the database
      const roomStub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      const row = await runInDurableObject(roomStub, (instance: RoomDO) => {
        return instance.db.prepare(
          `SELECT email FROM room_members WHERE room_id = ? AND account_id = ?`,
        ).get(roomId, guest.accountId) as { email: string | null } | undefined;
      });
      expect(row?.email).toBeNull();
    });

    it('allows GET /access', async () => {
      const res = await guestFetch('/access', 'GET');
      expect(res.status).toBe(200);
    });

    it('allows POST /presence join as self', async () => {
      const res = await guestFetch('/presence', 'POST', {
        peerId: 'guest-peer-123',
        userName: 'Guest User',
        color: '#3498db',
      });
      expect(res.status).toBe(200);
    });

    it('allows DELETE /waiting with own peerId', async () => {
      // First create a waiting entry
      const roomStub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      const peerId = `guest-peer-${crypto.randomUUID()}`;
      await runInDurableObject(roomStub, (instance: RoomDO) => {
        instance.db.prepare(
          `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
           VALUES (?, ?, 'Guest', '#3498db', ?, ?)`,
        ).run(roomId, peerId, Date.now(), guest.accountId);
      });

      const res = await guestFetch(`/waiting?peerId=${peerId}`, 'DELETE');
      expect(res.status).toBe(200);
    });

    it('denies DELETE /waiting with another peer\'s id', async () => {
      const res = await guestFetch(`/waiting?peerId=other-peer`, 'DELETE');
      expect(res.status).toBe(403);
    });

    it('allows GET /room after approval as editor', async () => {
      // First queue the request
      const reqRes = await guestFetch('/requests', 'POST', { userName: 'Guest' });
      expect(reqRes.status).toBe(201);

      // Approve as editor
      await approveGuestAsEditor();

      // Now GET /room should work
      const res = await guestFetch('', 'GET');
      expect(res.status).toBe(200);
    });

    it('allows POST /room (scene write) after approval as editor', async () => {
      // First queue the request
      const reqRes = await guestFetch('/requests', 'POST', { userName: 'Guest' });
      expect(reqRes.status).toBe(201);

      // Approve as editor
      await approveGuestAsEditor();

      // Now POST /room (scene write) should work
      const res = await guestFetch('', 'POST', { elements: [{ id: 'test' }] });
      expect(res.status).toBe(200);
    });

    it('allows GET /room after approval as viewer', async () => {
      // First queue the request
      const reqRes = await guestFetch('/requests', 'POST', { userName: 'Guest' });
      expect(reqRes.status).toBe(201);

      // Approve as viewer
      await approveGuestAsViewer();

      // Now GET /room should work
      const res = await guestFetch('', 'GET');
      expect(res.status).toBe(200);
    });

    it('denies POST /room (scene write) after approval as viewer', async () => {
      // First queue the request
      const reqRes = await guestFetch('/requests', 'POST', { userName: 'Guest' });
      expect(reqRes.status).toBe(201);

      // Approve as viewer
      await approveGuestAsViewer();

      // Now POST /room (scene write) should be denied
      const res = await guestFetch('', 'POST', { elements: [{ id: 'test' }] });
      expect(res.status).toBe(403);
    });

    it('denies GET /settings even after approval as editor', async () => {
      // Queue and approve as editor
      const reqRes = await guestFetch('/requests', 'POST', { userName: 'Guest' });
      expect(reqRes.status).toBe(201);
      await approveGuestAsEditor();

      // Even with editor role, guests cannot access settings
      const res = await guestFetch('/settings', 'GET');
      expect(res.status).toBe(403);
    });

    it('denies GET /settings when guest=1 is stamped on the owner account', async () => {
      const roomStub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      const res = await runInDurableObject(roomStub, (instance: RoomDO) => {
        const url = `https://room/room/settings?roomId=${roomId}&accountId=${owner.accountId}&guest=1`;
        return instance.fetch(new Request(url, { method: 'GET' }));
      });
      expect(res.status).toBe(403);
    });

    it('denies POST /settings when guest=1 is stamped on the owner account', async () => {
      const roomStub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      const res = await runInDurableObject(roomStub, (instance: RoomDO) => {
        const url = `https://room/room/settings?roomId=${roomId}&accountId=${owner.accountId}&guest=1`;
        return instance.fetch(new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Hacked' }),
        }));
      });
      expect(res.status).toBe(403);
    });
  });

  describe('regression: non-guest paths unchanged', () => {
    it('still allows owner GET /room', async () => {
      const res = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner);
      expect(res.status).toBe(200);
    });

    it('still allows owner POST /room (scene write)', async () => {
      const res = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ elements: [{ id: 'owner-edit' }] }),
      });
      expect(res.status).toBe(200);
    });

    it('still denies non-guest outsider GET /room', async () => {
      const outsider = await bootstrapLocalSession(`guest-outsider-${crypto.randomUUID()}`);
      const res = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider);
      expect(res.status).toBe(403);
    });
  });
});

describe('presence broadcast over WebSocket', () => {
  function nextTextMessage(ws: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for text frame')), SOCKET_EVENT_DEADLINE_MS);
      ws.addEventListener('message', (event: MessageEvent) => {
        clearTimeout(timer);
        if (typeof event.data !== 'string') {
          reject(new Error('expected text frame, got binary'));
          return;
        }
        resolve(event.data);
      }, { once: true });
    });
  }

  it('broadcasts a presence frame to an owner when a peer joins the waiting queue', async () => {
    const owner = await bootstrapLocalSession('presence-broadcast-owner');
    const requester = await bootstrapLocalSession('presence-broadcast-requester');
    const roomId = 'presence-broadcast-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const ownerSocket = await vi.waitFor(async () => {
      const res = await authenticatedFetch(`/signaling?room=${roomId}`, owner, {
        headers: { Upgrade: 'websocket' },
      });
      expect(res.status).toBe(101);
      const ws = res.webSocket;
      if (!ws) throw new Error('no webSocket on response');
      ws.accept();
      return ws;
    }, { timeout: SOCKET_EVENT_DEADLINE_MS });

    const presenceFrame = nextTextMessage(ownerSocket);

    // Requester joins waiting queue
    const joinRes = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, requester, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'requester-peer',
        userName: 'Requester',
        color: '#ff0000',
      }),
    });
    expect(joinRes.status).toBe(200);

    const frame = JSON.parse(await presenceFrame);
    expect(frame.type).toBe('presence');
    expect(frame.payload).toBeDefined();
    expect(frame.payload.waitingPeers).toBeDefined();
    expect(frame.payload.waitingPeers.length).toBeGreaterThan(0);

    ownerSocket.close();
  });

  it('does not send waitingPeers in presence frame to a non-owner peer', async () => {
    const owner = await bootstrapLocalSession('presence-noqueue-owner');
    const nonOwner = await bootstrapLocalSession('presence-noqueue-nonowner');
    const roomId = 'presence-noqueue-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);

    // Approve non-owner as editor
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, nonOwner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'NonOwner' }),
    })).status).toBe(201);

    expect((await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/requests/${nonOwner.accountId}`,
      owner,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role: 'peer' }),
      },
    )).status).toBe(200);

    const nonOwnerSocket = await vi.waitFor(async () => {
      const res = await authenticatedFetch(`/signaling?room=${roomId}`, nonOwner, {
        headers: { Upgrade: 'websocket' },
      });
      expect(res.status).toBe(101);
      const ws = res.webSocket;
      if (!ws) throw new Error('no webSocket on response');
      ws.accept();
      return ws;
    }, { timeout: SOCKET_EVENT_DEADLINE_MS });

    const presenceFrame = nextTextMessage(nonOwnerSocket);

    // Another requester joins waiting queue
    const requester = await bootstrapLocalSession('presence-noqueue-requester');
    const joinRes = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, requester, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'requester-peer',
        userName: 'Requester',
        color: '#ff0000',
      }),
    });
    expect(joinRes.status).toBe(200);

    const frame = JSON.parse(await presenceFrame);
    expect(frame.type).toBe('presence');
    expect(frame.payload).toBeDefined();
    expect(frame.payload.waitingPeers).toBeUndefined();
    // Should not include account IDs for non-owner
    if (frame.payload.users) {
      for (const user of frame.payload.users) {
        expect(user.accountId).toBeUndefined();
      }
    }

    nonOwnerSocket.close();
  });

  it('does not deliver presence frames to a socket in a different room', async () => {
    const owner = await bootstrapLocalSession('presence-isolate-owner');
    const requester = await bootstrapLocalSession('presence-isolate-requester');
    const other = await bootstrapLocalSession('presence-isolate-other');
    const roomId = 'presence-isolate-room';
    const otherRoomId = 'presence-isolate-other-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    expect((await writeRoom(otherRoomId, other)).status).toBe(200);

    const otherSocket = await vi.waitFor(async () => {
      const res = await authenticatedFetch(`/signaling?room=${otherRoomId}`, other, {
        headers: { Upgrade: 'websocket' },
      });
      expect(res.status).toBe(101);
      const ws = res.webSocket;
      if (!ws) throw new Error('no webSocket on response');
      ws.accept();
      return ws;
    }, { timeout: SOCKET_EVENT_DEADLINE_MS });

    let leaked = false;
    otherSocket.addEventListener('message', () => { leaked = true; }, { once: true });

    // Requester joins waiting queue in different room
    const joinRes = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, requester, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'requester-peer',
        userName: 'Requester',
        color: '#ff0000',
      }),
    });
    expect(joinRes.status).toBe(200);

    await new Promise((r) => setTimeout(r, 200));
    expect(leaked).toBe(false);

    otherSocket.close();
  });

  it('sends presence as text frame and does not interfere with binary relay', async () => {
    const owner = await bootstrapLocalSession('presence-binary-owner');
    const editor = await bootstrapLocalSession('presence-binary-editor');
    const roomId = 'presence-binary-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);

    // Approve editor
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

    const ownerSocket = await vi.waitFor(async () => {
      const res = await authenticatedFetch(`/signaling?room=${roomId}`, owner, {
        headers: { Upgrade: 'websocket' },
      });
      expect(res.status).toBe(101);
      const ws = res.webSocket;
      if (!ws) throw new Error('no webSocket on response');
      ws.accept();
      return ws;
    }, { timeout: SOCKET_EVENT_DEADLINE_MS });

    const editorSocket = await vi.waitFor(async () => {
      const res = await authenticatedFetch(`/signaling?room=${roomId}`, editor, {
        headers: { Upgrade: 'websocket' },
      });
      expect(res.status).toBe(101);
      const ws = res.webSocket;
      if (!ws) throw new Error('no webSocket on response');
      ws.accept();
      return ws;
    }, { timeout: SOCKET_EVENT_DEADLINE_MS });

    // Get the presence text frame from someone joining the queue
    const presenceFrame = nextTextMessage(ownerSocket);
    const requester = await bootstrapLocalSession('presence-binary-requester');
    const joinRes = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, requester, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'requester-peer',
        userName: 'Requester',
        color: '#ff0000',
      }),
    });
    expect(joinRes.status).toBe(200);

    const frame = JSON.parse(await presenceFrame);
    expect(frame.type).toBe('presence');

    // Now test binary relay still works
    const binaryPayload = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    const binaryFrame = new Promise<ArrayBuffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for binary frame')), SOCKET_EVENT_DEADLINE_MS);
      ownerSocket.addEventListener('message', (event: MessageEvent) => {
        clearTimeout(timer);
        if (typeof event.data === 'string') {
          // This is a text frame, skip it and wait for the next message
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

    editorSocket.send(binaryPayload.buffer);
    const received = await binaryFrame;
    expect(Array.from(new Uint8Array(received))).toEqual(Array.from(binaryPayload));

    ownerSocket.close();
    editorSocket.close();
  });
});
