import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import * as Y from 'yjs';
import { getIdentityObject, type IdentityDO } from './IdentityDO';
import { REVOCATION_CHECK_INTERVAL_MS, RoomDO } from './RoomDO';
import { encodeUpdateFrame } from '../lib/whiteboard/serverSync';
import { encodeFollowMessage, decodeFollowMessage } from '../lib/whiteboard/followMessage';
import { encodeCallMessage } from '../lib/whiteboard/callMessage';
import { snapshotChunkKey, snapshotMetaKey } from '../lib/whiteboard/snapshotChunks';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';

const SOCKET_EVENT_DEADLINE_MS = 15_000;

function stub(roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

function internals(instance: RoomDO) {
  return instance as unknown as {
    checkIntervalMs: number;
    docs: Map<string, Y.Doc>;
    dirtyRooms: Set<string>;
    projectionDirtyRooms: Set<string>;
    activeFollow: unknown;
    lastRevocationCheckAt: number;
    flushDirtyDocs(): Promise<void>;
    sweepDepartedCursors(roomId: string): void;
    sweepOrphanFiles(roomId: string, now: number): Promise<void>;
  };
}

async function writeRoom(roomId: string, owner: LocalAuthSession) {
  return authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ elements: [] }),
  });
}

async function joinPresence(
  who: LocalAuthSession,
  roomId: string,
  clientPeerId: string,
) {
  const res = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      peerId: clientPeerId,
      userName: clientPeerId,
      color: '#3498db',
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

function directFetch(
  roomId: string,
  path: string,
  who: LocalAuthSession,
  init: RequestInit = {},
  guest = false,
): Promise<Response> {
  const [pathname, query] = path.split('?');
  const search = new URLSearchParams(query ?? '');
  search.set('roomId', roomId);
  search.set('accountId', who.accountId);
  if (guest) search.set('guest', '1');
  return runInDurableObject(stub(roomId), (instance: RoomDO) => (
    instance.fetch(new Request(`https://room/room${pathname}?${search.toString()}`, init))
  ));
}

async function openSocket(who: LocalAuthSession, roomId: string): Promise<WebSocket> {
  const res = await authenticatedFetch(`/signaling?room=${roomId}`, who, {
    headers: { Upgrade: 'websocket' },
  });
  expect(res.status).toBe(101);
  const socket = res.webSocket;
  if (!socket) throw new Error('no webSocket on response');
  socket.accept();
  return socket;
}

async function grantViewer(owner: LocalAuthSession, viewer: LocalAuthSession, roomId: string) {
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

async function grantEditor(owner: LocalAuthSession, editor: LocalAuthSession, roomId: string) {
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

async function disableAccount(accountId: string): Promise<void> {
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const response = await identity.fetch('https://identity/accounts/disable', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, actor: 'test-operator', reason: 'direct guard coverage' }),
  });
  expect(response.status).toBe(200);
}

function nextFollow(socket: WebSocket): Promise<ReturnType<typeof decodeFollowMessage>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for follow frame')),
      SOCKET_EVENT_DEADLINE_MS,
    );
    const listener = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const payload = decodeFollowMessage(new Uint8Array(event.data));
      if (!payload) return;
      clearTimeout(timer);
      socket.removeEventListener('message', listener);
      resolve(payload);
    };
    socket.addEventListener('message', listener);
  });
}

function nextJsonMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for json message')),
      SOCKET_EVENT_DEADLINE_MS,
    );
    const listener = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      clearTimeout(timer);
      socket.removeEventListener('message', listener);
      resolve(JSON.parse(event.data));
    };
    socket.addEventListener('message', listener);
  });
}

function cursorFrame(peerId: string): ArrayBuffer {
  const doc = new Y.Doc();
  doc.getMap('cursors').set(peerId, { x: 1, y: 2 });
  const bytes = encodeUpdateFrame(Y.encodeStateAsUpdate(doc));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('RoomDO method and lifecycle guards', () => {
  it('rejects a direct request that carries no roomId', async () => {
    const res = await runInDurableObject(
      stub(`no-room-id-${crypto.randomUUID()}`),
      (instance: RoomDO) => instance.fetch(new Request('https://room/room')),
    );
    expect(res.status).toBe(400);
  });

  it('answers the guest-verify generic 403 when the body carries no pin', async () => {
    const owner = await bootstrapLocalSession(`guard-verify-owner-${crypto.randomUUID()}`);
    const roomId = `guard-verify-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const nullBody = await runInDurableObject(stub(roomId), (instance: RoomDO) => (
      instance.fetch(new Request(`https://room/room/guest-verify?roomId=${roomId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'null',
      }))
    ));
    expect(nullBody.status).toBe(403);

    const emptyPin = await runInDurableObject(stub(roomId), (instance: RoomDO) => (
      instance.fetch(new Request(`https://room/room/guest-verify?roomId=${roomId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: '' }),
      }))
    ));
    expect(emptyPin.status).toBe(403);
  });

  it('refuses unsupported methods on every hand-rolled section', async () => {
    const owner = await bootstrapLocalSession(`guard-methods-${crypto.randomUUID()}`);
    const roomId = `guard-methods-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const cases: Array<[string, string, number]> = [
      ['PUT', '', 403],
      ['PUT', '/settings', 403],
      ['POST', '/stats', 403],
      ['PATCH', '/waiting', 403],
      ['PATCH', '/presence', 403],
      ['DELETE', '/requests', 403],
      ['GET', '/files', 403],
      ['GET', '/files/not-a-real-action', 403],
      ['GET', '/erasure', 403],
      ['GET', '/av', 403],
      ['GET', '/requests/any-id', 404],
    ];
    for (const [method, path, status] of cases) {
      const res = await directFetch(roomId, path, owner, { method });
      expect(res.status, `${method} ${path}`).toBe(status);
    }
  });

  it('refuses owner-only surfaces to a guest', async () => {
    const owner = await bootstrapLocalSession(`guard-guest-owner-${crypto.randomUUID()}`);
    const guest = await bootstrapLocalSession(`guard-guest-account-${crypto.randomUUID()}`);
    const roomId = `guard-guest-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guestAccess: true }),
    })).status).toBe(200);

    const cases: Array<[string, string]> = [
      ['POST', '/clear'],
      ['GET', '/stats'],
      ['GET', '/library'],
    ];
    for (const [method, path] of cases) {
      const res = await directFetch(roomId, path, guest, { method }, true);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('lets the owner remove a waiting peer and refuses a removal without a peer id', async () => {
    const owner = await bootstrapLocalSession(`guard-wait-owner-${crypto.randomUUID()}`);
    const roomId = `guard-wait-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    const joined = await joinPresence(owner, roomId, 'owner-wait-peer');
    expect(joined.status).toBe(200);

    const withoutPeer = await directFetch(roomId, '/waiting', owner, { method: 'DELETE' });
    expect(withoutPeer.status).toBe(403);

    const withPeer = await directFetch(
      roomId,
      `/waiting?peerId=${joined.peerId}`,
      owner,
      { method: 'DELETE' },
    );
    expect(withPeer.status).toBe(200);
  });

  it('refuses a presence removal without a peer id even for a granted owner', async () => {
    const owner = await bootstrapLocalSession(`guard-presence-owner-${crypto.randomUUID()}`);
    const roomId = `guard-presence-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const res = await directFetch(roomId, '/presence', owner, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('does not treat HEAD /access on an unknown room as an authenticated read', async () => {
    const owner = await bootstrapLocalSession(`guard-head-owner-${crypto.randomUUID()}`);
    const roomId = `guard-head-missing-${crypto.randomUUID()}`;
    const res = await directFetch(roomId, '/access', owner, { method: 'HEAD' });
    expect(res.status).toBe(404);
  });

  it('refuses POST /access and answers HEAD /settings without a body', async () => {
    const owner = await bootstrapLocalSession(`guard-head2-owner-${crypto.randomUUID()}`);
    const roomId = `guard-head2-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const posted = await directFetch(roomId, '/access', owner, { method: 'POST' });
    expect(posted.status).toBe(403);

    const head = await directFetch(roomId, '/settings', owner, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('authorizes file writes by role and refuses a viewer', async () => {
    const owner = await bootstrapLocalSession(`guard-files-owner-${crypto.randomUUID()}`);
    const viewer = await bootstrapLocalSession(`guard-files-viewer-${crypto.randomUUID()}`);
    const roomId = `guard-files-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantViewer(owner, viewer, roomId);

    const ownerWrite = await directFetch(roomId, '/files/authorize-write', owner);
    expect(ownerWrite.status).toBe(200);
    const viewerWrite = await directFetch(roomId, '/files/authorize-write', viewer);
    expect(viewerWrite.status).toBe(403);
    const viewerRead = await directFetch(roomId, '/files/authorize-read', viewer);
    expect(viewerRead.status).toBe(200);
  });

  it('allows only POST for file reserve and settle', async () => {
    const owner = await bootstrapLocalSession(`guard-reserve-owner-${crypto.randomUUID()}`);
    const roomId = `guard-reserve-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    expect((await directFetch(roomId, '/files/reserve', owner)).status).toBe(405);
    expect((await directFetch(roomId, '/files/settle', owner)).status).toBe(405);
  });

  it('validates direct signaling upgrades before accepting a socket', async () => {
    const owner = await bootstrapLocalSession(`guard-signal-owner-${crypto.randomUUID()}`);
    const roomId = `guard-signal-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const noAuth = await runInDurableObject(stub(roomId), (instance: RoomDO) => (
      instance.fetch(new Request(`https://room/signaling?roomId=${roomId}`, {
        headers: { Upgrade: 'websocket' },
      }))
    ));
    expect(noAuth.status).toBe(401);

    const noRoom = await runInDurableObject(stub(roomId), (instance: RoomDO) => (
      instance.fetch(new Request(
        'https://room/signaling?accountId=someone&sessionId=session&accountEpoch=0',
        { headers: { Upgrade: 'websocket' } },
      ))
    ));
    expect(noRoom.status).toBe(400);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'DELETE',
    })).status).toBe(200);

    const tombstoned = await runInDurableObject(stub(roomId), (instance: RoomDO) => (
      instance.fetch(new Request(
        `https://room/signaling?roomId=${roomId}&accountId=${owner.accountId}&sessionId=session&accountEpoch=0`,
        { headers: { Upgrade: 'websocket' } },
      ))
    ));
    expect(tombstoned.status).toBe(410);
  });

  it('reopens a board empty when snapshot metadata points at a missing chunk', async () => {
    const owner = await bootstrapLocalSession(`guard-chunks-owner-${crypto.randomUUID()}`);
    const roomId = `guard-chunks-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    await runInDurableObject(stub(roomId), async (_instance: RoomDO, state) => {
      await state.storage.put(snapshotMetaKey(roomId), 2);
      await state.storage.put(snapshotChunkKey(roomId, 0), new Uint8Array([1, 2, 3]));
    });

    const res = await directFetch(roomId, '/stats', owner);
    expect(res.status).toBe(200);
  });

  it('closes an alarm socket whose attachment cannot identify an account', async () => {
    const readyState = await runInDurableObject(
      stub(`guard-orphan-${crypto.randomUUID()}`),
      async (instance: RoomDO, state) => {
        const pair = new WebSocketPair();
        const server = pair[1];
        state.acceptWebSocket(server);
        server.serializeAttachment({ sessionId: 'orphan-session' });
        await instance.alarm();
        return server.readyState;
      },
    );
    expect(readyState).not.toBe(WebSocket.OPEN);
  });

  it('fails closed on messages from sockets with unreadable identity attachments', async () => {
    const readyStates = await runInDurableObject(
      stub(`guard-stale-${crypto.randomUUID()}`),
      async (instance: RoomDO, state) => {
        const noRoom = new WebSocketPair();
        state.acceptWebSocket(noRoom[1]);
        noRoom[1].serializeAttachment({
          accountId: 'ghost',
          sessionId: 'session',
          authorizationEpoch: 0,
          grantVersion: 1,
        });
        await instance.webSocketMessage(noRoom[1], 'ping');

        const noVersion = new WebSocketPair();
        state.acceptWebSocket(noVersion[1]);
        noVersion[1].serializeAttachment({
          accountId: 'ghost',
          sessionId: 'session',
          authorizationEpoch: 0,
          roomId: 'some-room',
        });
        await instance.webSocketMessage(noVersion[1], 'ping');

        const noRoomClose = new WebSocketPair();
        state.acceptWebSocket(noRoomClose[1]);
        noRoomClose[1].serializeAttachment({ accountId: 'ghost', sessionId: 'session', grantVersion: 1 });
        await instance.webSocketClose(noRoomClose[1], 1000, 'test', true);

        return [noRoom[1].readyState, noVersion[1].readyState, noRoomClose[1].readyState];
      },
    );
    for (const readyState of readyStates) expect(readyState).not.toBe(WebSocket.OPEN);
  });

  it('takes an ungranted account off the call when its socket speaks, but not a merely stale one', async () => {
    /*
     * Phase 10: media must die with the grant. Kick, suspend, ban and the
     * revocation alarm already evict LiveKit; a socket found ungranted on its
     * next message was closed and left its owner in the call.
     */
    const owner = await bootstrapLocalSession(`guard-evict-owner-${crypto.randomUUID()}`);
    const roomId = `guard-evict-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const outcome = await runInDurableObject(stub(roomId), async (instance: RoomDO, state) => {
      const evicted: { roomId: string; identity: string }[] = [];
      instance.evictLiveKitParticipant = async (input) => {
        evicted.push({ roomId: input.roomId, identity: input.identity });
        return { ok: true };
      };
      const grantVersion = (instance as unknown as { db: { prepare(sql: string): { get(...args: unknown[]): unknown } } })
        .db.prepare('SELECT grant_version AS v FROM rooms WHERE room_id = ?')
        .get(roomId) as { v: number };

      const ungranted = new WebSocketPair();
      state.acceptWebSocket(ungranted[1]);
      ungranted[1].serializeAttachment({
        accountId: 'account-without-a-grant',
        sessionId: 'session',
        authorizationEpoch: 0,
        roomId,
        grantVersion: grantVersion.v,
      });
      await instance.webSocketMessage(ungranted[1], 'ping');

      // The owner still holds the room: an old grant version closes the socket
      // (it must reconnect and re-stamp) but is no reason to cut the call.
      const staleOwner = new WebSocketPair();
      state.acceptWebSocket(staleOwner[1]);
      staleOwner[1].serializeAttachment({
        accountId: owner.accountId,
        sessionId: 'session',
        authorizationEpoch: 0,
        roomId,
        grantVersion: grantVersion.v - 1,
      });
      await instance.webSocketMessage(staleOwner[1], 'ping');
      await Promise.resolve();

      return {
        evicted,
        ungrantedOpen: ungranted[1].readyState === WebSocket.OPEN,
        staleOwnerOpen: staleOwner[1].readyState === WebSocket.OPEN,
      };
    });

    expect(outcome.ungrantedOpen).toBe(false);
    expect(outcome.staleOwnerOpen).toBe(false);
    expect(outcome.evicted).toEqual([{ roomId, identity: 'account-without-a-grant' }]);
  });

  it('refuses a signaling upgrade that carries no session, before accepting a socket', async () => {
    /*
     * The Worker stamps the verified session hash onto every upgrade it
     * forwards; the room refuses one without it rather than trusting whoever
     * holds the binding to have done so. No socket is accepted.
     */
    const owner = await bootstrapLocalSession(`guard-nosession-owner-${crypto.randomUUID()}`);
    const roomId = `guard-nosession-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const upgrade = (query: string) => stub(roomId).fetch(
      `https://room/signaling?${query}`,
      { headers: { Upgrade: 'websocket' } },
    );
    const base = `room=${encodeURIComponent(roomId)}&roomId=${encodeURIComponent(roomId)}&accountId=${encodeURIComponent(owner.accountId)}&accountEpoch=0`;
    for (const query of [base, `${base}&sessionId=`]) {
      const response = await upgrade(query);
      expect(response.status, query).toBe(401);
      expect(response.webSocket).toBeNull();
    }
    const open = await runInDurableObject(stub(roomId), (_instance: RoomDO, state) => state.getWebSockets().length);
    expect(open).toBe(0);
  });

  it('keeps the active guide while another owner tab remains open', async () => {
    const owner = await bootstrapLocalSession(`guard-tabs-owner-${crypto.randomUUID()}`);
    const roomId = `guard-tabs-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const first = await openSocket(owner, roomId);
    const second = await openSocket(owner, roomId);
    const follower = nextFollow(second);
    first.send(encodeFollowMessage({ active: true, viewport: { x: 1, y: 2, zoom: 1 } }));
    await expect(follower).resolves.toEqual({ active: true, viewport: { x: 1, y: 2, zoom: 1 } });

    await runInDurableObject(stub(roomId), async (instance: RoomDO) => {
      const sockets = (instance as unknown as { ctx: DurableObjectState }).ctx.getWebSockets();
      await instance.webSocketClose(sockets[0], 1000, 'tab closed', true);
      expect(internals(instance).activeFollow).not.toBeNull();
      await instance.webSocketClose(sockets[1], 1000, 'tab closed', true);
      expect(internals(instance).activeFollow).toBeNull();
    });
  });

  it('revokes duplicate sessions for the same account in one alarm', async () => {
    const owner = await bootstrapLocalSession(`guard-dup-owner-${crypto.randomUUID()}`);
    const roomId = `guard-dup-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const first = await openSocket(owner, roomId);
    const second = await openSocket(owner, roomId);
    const closed = { first: false, second: false };
    first.addEventListener('close', () => { closed.first = true; }, { once: true });
    second.addEventListener('close', () => { closed.second = true; }, { once: true });

    await disableAccount(owner.accountId);
    await runInDurableObject(stub(roomId), (instance: RoomDO) => {
      internals(instance).lastRevocationCheckAt = Date.now() - internals(instance).checkIntervalMs;
    });
    await runDurableObjectAlarm(stub(roomId));

    await vi.waitFor(() => {
      expect(closed.first).toBe(true);
      expect(closed.second).toBe(true);
    }, { timeout: SOCKET_EVENT_DEADLINE_MS, interval: 20 });
  });

  it('skips sockets whose attachment belongs to another room or no account', async () => {
    const owner = await bootstrapLocalSession(`guard-fanout-owner-${crypto.randomUUID()}`);
    const editor = await bootstrapLocalSession(`guard-fanout-editor-${crypto.randomUUID()}`);
    const roomId = `guard-fanout-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [{ id: 'seed-element' }] }),
    })).status).toBe(200);

    const ownerSocket = await openSocket(owner, roomId);
    await runInDurableObject(stub(roomId), (_instance: RoomDO, state) => {
      const foreign = new WebSocketPair();
      state.acceptWebSocket(foreign[1]);
      foreign[1].serializeAttachment({
        accountId: 'ghost',
        sessionId: 'session',
        authorizationEpoch: 0,
        roomId: 'some-other-room',
        grantVersion: 1,
      });

      const anonymous = new WebSocketPair();
      state.acceptWebSocket(anonymous[1]);
      anonymous[1].serializeAttachment({ roomId, grantVersion: 1 });
    });

    ownerSocket.send(encodeFollowMessage({ active: true, viewport: { x: 0, y: 0, zoom: 1 } }));
    ownerSocket.send(encodeCallMessage({
      active: true,
      hostAccountId: owner.accountId,
      startedAt: Date.now(),
    }));

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/clear`, owner, {
      method: 'POST',
    })).status).toBe(200);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', accountId: editor.accountId }),
    })).status).toBe(200);

    const echo = nextJsonMessage(ownerSocket);
    ownerSocket.send(JSON.stringify({ type: 'publish', topic: 'room', data: 'fanout' }));
    expect(await echo).toMatchObject({ type: 'publish', data: 'fanout' });

    const pong = nextJsonMessage(ownerSocket);
    ownerSocket.send(JSON.stringify({ type: 'ping' }));
    expect(await pong).toEqual({ type: 'pong' });
  });

  it('ignores a publish frame with no topic', async () => {
    const owner = await bootstrapLocalSession(`guard-topic-owner-${crypto.randomUUID()}`);
    const editor = await bootstrapLocalSession(`guard-topic-editor-${crypto.randomUUID()}`);
    const roomId = `guard-topic-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);

    const ownerSocket = await openSocket(owner, roomId);
    const editorSocket = await openSocket(editor, roomId);

    let received = false;
    editorSocket.addEventListener('message', () => { received = true; }, { once: true });
    ownerSocket.send(JSON.stringify({ type: 'publish' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toBe(false);

    const pong = nextJsonMessage(ownerSocket);
    ownerSocket.send(JSON.stringify({ type: 'ping' }));
    expect(await pong).toEqual({ type: 'pong' });
  });

  it('clears the guide and notifies peers when the owner stops following', async () => {
    const owner = await bootstrapLocalSession(`guard-follow-owner-${crypto.randomUUID()}`);
    const editor = await bootstrapLocalSession(`guard-follow-editor-${crypto.randomUUID()}`);
    const roomId = `guard-follow-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);

    const ownerSocket = await openSocket(owner, roomId);
    const editorSocket = await openSocket(editor, roomId);

    const started = nextFollow(editorSocket);
    ownerSocket.send(encodeFollowMessage({ active: true, viewport: { x: 5, y: 6, zoom: 1 } }));
    await expect(started).resolves.toEqual({ active: true, viewport: { x: 5, y: 6, zoom: 1 } });

    const stopped = nextFollow(editorSocket);
    ownerSocket.send(encodeFollowMessage({ active: false }));
    await expect(stopped).resolves.toEqual({ active: false });

    const active = await runInDurableObject(stub(roomId), (instance: RoomDO) => (
      internals(instance).activeFollow
    ));
    expect(active).toBeNull();
  });

  it('drops a dirty document when its room row has disappeared', async () => {
    const owner = await bootstrapLocalSession(`guard-dirty-owner-${crypto.randomUUID()}`);
    const roomId = `guard-dirty-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    const socket = await openSocket(owner, roomId);

    socket.send(cursorFrame('first-peer'));
    await expect.poll(() => runInDurableObject(stub(roomId), (_instance: RoomDO, state) => (
      state.storage.get(snapshotMetaKey(roomId))
    )), { timeout: SOCKET_EVENT_DEADLINE_MS, interval: 50 }).toBeTruthy();

    socket.send(cursorFrame('second-peer'));
    await expect.poll(() => runInDurableObject(stub(roomId), (instance: RoomDO) => (
      internals(instance).dirtyRooms.has(roomId)
    )), { timeout: SOCKET_EVENT_DEADLINE_MS, interval: 50 }).toBe(true);

    /*
     * The room flushes itself behind the test's back: the drawing throttle and
     * the revocation alarm both call flushDirtyDocs, and a flush landing
     * between "seen dirty" and "delete the row" clears the flag while leaving
     * the document cached -- correct product behavior, fatal to the
     * precondition. So the deletion is retried: every attempt re-dirties the
     * room with a fresh frame, and only an attempt whose dirty check and
     * DELETE run in the same synchronous breath -- no await between them for
     * an alarm to slip through -- is accepted as evidence.
     */
    await expect.poll(async () => {
      socket.send(cursorFrame('retry-peer'));
      await expect.poll(() => runInDurableObject(stub(roomId), (instance: RoomDO) => (
        internals(instance).dirtyRooms.has(roomId)
      )), { timeout: SOCKET_EVENT_DEADLINE_MS, interval: 50 }).toBe(true);

      const after = await runInDurableObject(stub(roomId), async (instance: RoomDO) => {
        const room = internals(instance);
        if (!room.dirtyRooms.has(roomId)) return null;
        instance.db.prepare('DELETE FROM rooms WHERE room_id = ?').run(roomId);
        await room.flushDirtyDocs();
        return {
          hasDoc: room.docs.has(roomId),
          dirtyCount: room.dirtyRooms.size,
        };
      });
      return after ?? 'flushed-early';
    }, { timeout: SOCKET_EVENT_DEADLINE_MS, interval: 50 }).toEqual({
      hasDoc: false,
      dirtyCount: 0,
    });
  });

  it('drops a pending projection when its room row has disappeared', async () => {
    const owner = await bootstrapLocalSession(`guard-projection-owner-${crypto.randomUUID()}`);
    const roomId = `guard-projection-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const after = await runInDurableObject(stub(roomId), async (instance: RoomDO, state) => {
      await state.storage.put(`ydoc-projection:${roomId}`, true);
      await (instance as unknown as { restoreProjectionRetries(): Promise<void> })
        .restoreProjectionRetries();
      instance.db.prepare('DELETE FROM rooms WHERE room_id = ?').run(roomId);
      await internals(instance).flushDirtyDocs();
      return {
        pending: internals(instance).projectionDirtyRooms.size,
        marker: await state.storage.get(`ydoc-projection:${roomId}`),
      };
    });
    expect(after.pending).toBe(0);
    expect(after.marker).toBeUndefined();
  });

  it('refuses a granted write when the room has no owner row', async () => {
    const owner = await bootstrapLocalSession(`guard-ownerless-owner-${crypto.randomUUID()}`);
    const editor = await bootstrapLocalSession(`guard-ownerless-editor-${crypto.randomUUID()}`);
    const roomId = `guard-ownerless-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);

    await runInDurableObject(stub(roomId), (instance: RoomDO) => {
      instance.db.prepare(`DELETE FROM room_members WHERE room_id = ? AND role = 'owner'`).run(roomId);
    });

    const res = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, editor, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [{ id: 'write' }] }),
    });
    expect(res.status).toBe(403);
  });

  it('skips file cleanup when the board-files bucket is not bound', async () => {
    const roomId = `guard-nobucket-${crypto.randomUUID()}`;
    const completed = await runInDurableObject(stub(roomId), async (_instance: RoomDO, state) => {
      const probe = new RoomDO(state, {});
      await (probe as unknown as { purgeRoomFiles(id: string): Promise<void> }).purgeRoomFiles(roomId);
      await internals(probe).sweepOrphanFiles(roomId, Date.now() + 7 * 24 * 60 * 60 * 1000);
      return true;
    });
    expect(completed).toBe(true);
  });

  it('leaves the cursor of a peer that is still present', async () => {
    const owner = await bootstrapLocalSession(`guard-cursor-owner-${crypto.randomUUID()}`);
    const roomId = `guard-cursor-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    const joined = await joinPresence(owner, roomId, 'present-peer');
    expect(joined.status).toBe(200);

    const socket = await openSocket(owner, roomId);
    socket.send(cursorFrame(joined.peerId));
    await expect.poll(() => runInDurableObject(stub(roomId), (instance: RoomDO) => (
      internals(instance).docs.get(roomId)?.getMap('cursors').has(joined.peerId) ?? false
    )), { timeout: SOCKET_EVENT_DEADLINE_MS, interval: 50 }).toBe(true);

    const stillPresent = await runInDurableObject(stub(roomId), (instance: RoomDO) => {
      internals(instance).sweepDepartedCursors(roomId);
      return internals(instance).docs.get(roomId)?.getMap('cursors').has(joined.peerId) ?? false;
    });
    expect(stillPresent).toBe(true);
  });

  it('keeps room files when the stored projection is not an array', async () => {
    const owner = await bootstrapLocalSession(`guard-orphan-owner-${crypto.randomUUID()}`);
    const roomId = `guard-orphan-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    const key = `rooms/${roomId}/files/guarded-file`;
    await env.BOARD_FILES.put(key, new Uint8Array([1, 2, 3]));

    await runInDurableObject(stub(roomId), async (instance: RoomDO) => {
      instance.db.prepare('UPDATE rooms SET elements = ? WHERE room_id = ?')
        .run('"not-an-array"', roomId);
      await internals(instance).sweepOrphanFiles(roomId, Date.now() + 7 * 24 * 60 * 60 * 1000);
    });

    expect(await env.BOARD_FILES.head(key)).not.toBeNull();
  });

  it('ignores a revocation interval override below the floor', async () => {
    const configured = await runInDurableObject(
      stub(`guard-interval-${crypto.randomUUID()}`),
      (_instance: RoomDO, state) => [
        internals(new RoomDO(state, { REVOCATION_CHECK_INTERVAL_MS: '10' })).checkIntervalMs,
        internals(new RoomDO(state, { REVOCATION_CHECK_INTERVAL_MS: 'not-a-number' })).checkIntervalMs,
        internals(new RoomDO(state, { REVOCATION_CHECK_INTERVAL_MS: '120' })).checkIntervalMs,
      ],
    );
    expect(configured[0]).toBe(REVOCATION_CHECK_INTERVAL_MS);
    expect(configured[1]).toBe(REVOCATION_CHECK_INTERVAL_MS);
    expect(configured[2]).toBe(120);
  });

  it('writes a board near the snapshot budget and drops an oversized projection', async () => {
    const owner = await bootstrapLocalSession(`guard-budget-owner-${crypto.randomUUID()}`);
    const roomId = `guard-budget-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    const socket = await openSocket(owner, roomId);

    const client = new Y.Doc();
    const element = new Y.Map();
    element.set('id', 'big-element');
    element.set('padding', 'x'.repeat(1_600_000));
    client.getArray('elements').push([element]);
    socket.send(encodeUpdateFrame(Y.encodeStateAsUpdate(client)).buffer as ArrayBuffer);

    await expect.poll(() => runInDurableObject(stub(roomId), (_instance: RoomDO, state) => (
      state.storage.get(snapshotMetaKey(roomId))
    )), { timeout: SOCKET_EVENT_DEADLINE_MS, interval: 50 }).toBeTruthy();

    const projection = await runInDurableObject(stub(roomId), async (instance: RoomDO, state) => {
      await instance.alarm();
      return {
        marker: await state.storage.get(`ydoc-projection:${roomId}`),
        pending: internals(instance).projectionDirtyRooms.size,
      };
    });
    expect(projection.marker).toBeUndefined();
    expect(projection.pending).toBe(0);
  });
});
