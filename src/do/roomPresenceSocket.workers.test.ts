import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { decodePresenceMessage } from '../lib/whiteboard/presenceMessage';
import { ROOM_SETTINGS_KEYS } from '../lib/whiteboard/requestSchemas';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';

/*
 * Split out of roomDO.workers.test.ts for the reason recorded in
 * roomViewport.workers.test.ts and roomCall.workers.test.ts: that file sits at
 * the V8 stack limit under @cloudflare/vitest-pool-workers proxy wrapping, and
 * anything added to it -- here, one extra await in the socket upgrade path --
 * surfaced as "RangeError: Maximum call stack size exceeded" in whichever test
 * happened to run deepest, not in the code that caused it.
 */

const SOCKET_EVENT_DEADLINE_MS = 8_000;

function splitRoomWrite(body: Record<string, unknown>) {
  const settings: Record<string, unknown> = {};
  const scene: Record<string, unknown> = { elements: [] };
  for (const [key, value] of Object.entries(body)) {
    if ((ROOM_SETTINGS_KEYS as readonly string[]).includes(key)) settings[key] = value;
    else scene[key] = value;
  }
  return { scene, settings };
}

async function writeRoom(
  roomId: string,
  who: LocalAuthSession,
  body: Record<string, unknown> = {},
) {
  const { scene } = splitRoomWrite(body);
  return authenticatedFetch(`/api/whiteboard/room/${roomId}`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scene),
  });
}

describe('presence broadcast over WebSocket', () => {
  function nextPresenceMessage(ws: WebSocket): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for presence frame')), SOCKET_EVENT_DEADLINE_MS);
      ws.addEventListener('message', (event: MessageEvent) => {
        clearTimeout(timer);
        if (typeof event.data === 'string') {
          reject(new Error('expected binary frame, got text'));
          return;
        }
        // Decode the binary presence message
        const payload = decodePresenceMessage(new Uint8Array(event.data));
        if (payload === null) {
          reject(new Error('failed to decode presence message'));
          return;
        }
        resolve(payload);
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

    const presenceFrame = nextPresenceMessage(ownerSocket);

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

    const payload = await presenceFrame;
    expect(payload).toBeDefined();
    expect((payload as any).waitingPeers).toBeDefined();
    expect((payload as any).waitingPeers.length).toBeGreaterThan(0);

    ownerSocket.close();
  });

  it('does not broadcast for a heartbeat that changed nothing', async () => {
    /*
     * The client heartbeats this same route every two seconds. Broadcasting on
     * each one had every peer rebuild and re-send a payload for every other
     * peer several times a second — more work for the room than the polling it
     * replaces, and more frames competing with the strokes.
     */
    const owner = await bootstrapLocalSession('presence-heartbeat-owner');
    const roomId = 'presence-heartbeat-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const beat = () => authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'owner-peer', userName: 'Owner', color: '#00ff00' }),
    });

    // The first one is a real join and does change presence.
    expect((await beat()).status).toBe(200);

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

    const frames: ArrayBuffer[] = [];
    ownerSocket.addEventListener('message', (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) frames.push(event.data);
    });

    // Subsequent identical heartbeats move only a timestamp.
    expect((await beat()).status).toBe(200);
    expect((await beat()).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(frames.length).toBe(0);

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

    const presenceFrame = nextPresenceMessage(nonOwnerSocket);

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

    const payload = await presenceFrame;
    expect(payload).toBeDefined();
    expect((payload as any).waitingPeers).toBeUndefined();
    // Should not include account IDs for non-owner
    if ((payload as any).users) {
      for (const user of (payload as any).users) {
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

  it('sends presence as binary frame and does not interfere with binary relay', async () => {
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

    // Get the presence binary frame from someone joining the queue
    const presenceFrame = nextPresenceMessage(ownerSocket);
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

    const payload = await presenceFrame;
    expect(payload).toBeDefined();
    expect((payload as any).waitingPeers).toBeDefined();

    // Now test binary relay still works
    const binaryPayload = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    const binaryFrame = new Promise<ArrayBuffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for binary frame')), SOCKET_EVENT_DEADLINE_MS);
      ownerSocket.addEventListener('message', (event: MessageEvent) => {
        clearTimeout(timer);
        if (!(event.data instanceof ArrayBuffer)) {
          reject(new Error('expected ArrayBuffer'));
          return;
        }
        // Check if this is a presence message (starts with message type)
        const view = new Uint8Array(event.data);
        if (view[0] === 100) {
          // This is a presence message, skip it and wait for the next message
          return;
        }
        resolve(event.data);
      }, { once: true });
    });

    editorSocket.send(binaryPayload.buffer);
    const received = await binaryFrame;
    expect(Array.from(new Uint8Array(received))).toEqual(Array.from(binaryPayload));

    ownerSocket.close();
    editorSocket.close();
  });
});
