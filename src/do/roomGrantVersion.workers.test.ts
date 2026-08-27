import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import * as Y from 'yjs';
import { ROOM_SETTINGS_KEYS } from '../lib/whiteboard/requestSchemas';
import { encodeUpdateFrame } from '../lib/whiteboard/serverSync';
import { RoomDO } from './RoomDO';
import { authenticatedFetch, bootstrapLocalSession, type LocalAuthSession } from '../test/workerAuth';

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

  /**
   * The close code if the socket closes within the deadline, otherwise null.
   *
   * Resolving the same value on both paths would make "still open" and "closed"
   * indistinguishable, and the assertion would hold whether or not the bug is
   * present.
   */
  function closeCodeWithin(ws: WebSocket, ms: number): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      ws.addEventListener('close', (event: CloseEvent) => {
        clearTimeout(timer);
        resolve(event.code);
      }, { once: true });
    });
  }

  it('does not close other granted sockets when kicking one account', async () => {
    const owner = await bootstrapLocalSession('grant-survives-owner');
    const kicked = await bootstrapLocalSession('grant-survives-kicked');
    const bystander = await bootstrapLocalSession('grant-survives-bystander');
    const roomId = 'grant-survives-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, kicked, roomId);
    await grantEditor(owner, bystander, roomId);

    const kickedPeerId = await joinEditorPeer(kicked, roomId);

    // Open sockets for owner and bystander BEFORE the kick (pre-kick grant version)
    const ownerSocket = await connectGranted(owner, roomId);
    const bystanderSocket = await connectGranted(bystander, roomId);

    // Kick the third peer
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'kick', peerId: kickedPeerId }),
    })).status).toBe(200);

    // Owner sends a binary frame. It has to be a real sync frame: the object
    // relays the y-protocol types and drops everything else, so an arbitrary
    // byte string would prove nothing about whether the socket still works.
    const doc = new Y.Doc();
    doc.getMap('cursors').set('probe-peer', { x: 1, y: 2 });
    const payload = encodeUpdateFrame(Y.encodeStateAsUpdate(doc));
    const bystanderReceived = nextBinaryMessage(bystanderSocket);
    const ownerClosed = closeCodeWithin(ownerSocket, 1_000);

    ownerSocket.send(payload.buffer as ArrayBuffer);

    try {
      // Before the fix this was 4401: the kick bumped the room's grant version,
      // and the owner's own attachment then read as revoked.
      expect(await ownerClosed).toBe(null);
      expect(Array.from(new Uint8Array(await bystanderReceived))).toEqual(Array.from(payload));
    } finally {
      // A socket left open here outlives the test and exhausts the runtime for
      // whatever runs after it.
      ownerSocket.close();
      bystanderSocket.close();
    }
  });
});
