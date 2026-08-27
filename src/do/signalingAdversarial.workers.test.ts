import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { RoomDO } from './RoomDO';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';
import * as Y from 'yjs';
import { encodePresenceMessage, PRESENCE_MESSAGE_TYPE } from '../lib/whiteboard/presenceMessage';
import { encodeUpdateFrame, handleSyncFrame, MESSAGE_SYNC } from '../lib/whiteboard/serverSync';

async function writeRoom(roomId: string, who: LocalAuthSession, body: Record<string, unknown> = { elements: [] }) {
  return authenticatedFetch(`/api/whiteboard/room/${roomId}`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

async function signalingUpgrade(
  who: LocalAuthSession,
  roomId: string,
  origin?: string,
) {
  const headers: Record<string, string> = { Upgrade: 'websocket' };
  if (origin !== undefined) headers.Origin = origin;
  return authenticatedFetch(`/signaling?room=${roomId}`, who, { headers });
}

async function connectGranted(who: LocalAuthSession, roomId: string): Promise<WebSocket> {
  const res = await signalingUpgrade(who, roomId);
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error('no webSocket on response');
  ws.accept();
  return ws;
}

function assertNoBoardBytes(payload: unknown, marker: string) {
  const text = JSON.stringify(payload);
  expect(payload).not.toHaveProperty('elements');
  expect(text).not.toMatch(/"elements"/);
  expect(text).not.toContain(marker);
}

describe('raw-client adversarial: pending/outsider GET must not leak board bytes', () => {
  it('returns 403 without elements for an outsider and a pending waiter', async () => {
    const owner = await bootstrapLocalSession('adv-get-owner');
    const outsider = await bootstrapLocalSession('adv-get-outsider');
    const roomId = 'adv-pending-get-room';
    const marker = 'secret-board-dot';

    expect((await writeRoom(roomId, owner, {
      elements: [{ id: marker }],
    })).status).toBe(200);

    const outsiderGet = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider);
    expect(outsiderGet.status).toBe(403);
    assertNoBoardBytes(await outsiderGet.json(), marker);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, outsider, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'pending-peer', userName: 'Guest', color: '#3498db' }),
    })).status).toBe(200);

    const pendingGet = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider);
    expect(pendingGet.status).toBe(403);
    assertNoBoardBytes(await pendingGet.json(), marker);
  });
});

describe('raw-client adversarial: viewer cannot POST scene', () => {
  it('returns 403 and leaves stored scene unchanged', async () => {
    const owner = await bootstrapLocalSession('adv-scene-owner');
    const viewer = await bootstrapLocalSession('adv-scene-viewer');
    const roomId = 'adv-viewer-scene-room';
    const original = [{ id: 'keep-dot' }];

    expect((await writeRoom(roomId, owner, { elements: original })).status).toBe(200);
    await grantViewer(owner, viewer, roomId);

    const before = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner);
    expect(before.status).toBe(200);
    const beforeBody = await before.json() as { elements: unknown };
    expect(beforeBody.elements).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'keep-dot' })]));

    const hijack = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, viewer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [{ id: 'stolen-dot' }] }),
    });
    expect(hijack.status).toBe(403);

    const after = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner);
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({
      elements: [expect.objectContaining({ id: 'keep-dot' })],
    });
  });
});

describe('raw-client adversarial: signaling Origin', () => {
  it('does not upgrade when Origin is wrong', async () => {
    const owner = await bootstrapLocalSession('adv-origin-owner');
    const roomId = 'adv-signaling-origin-room';
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const rejected = await signalingUpgrade(owner, roomId, 'https://attacker.example');
    expect(rejected.status).not.toBe(101);
    expect([401, 403]).toContain(rejected.status);
    expect(rejected.webSocket).toBeNull();
  });
});

describe('raw-client adversarial: viewer JSON publish does not fan out', () => {
  it('does not change the owner socket received frames', async () => {
    const owner = await bootstrapLocalSession('adv-publish-owner');
    const viewer = await bootstrapLocalSession('adv-publish-viewer');
    const roomId = 'adv-viewer-publish-room';

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
});

describe('binary frame relay security', () => {
  it('does not relay forged presence frames from an editor peer', async () => {
    const owner = await bootstrapLocalSession('relay-owner');
    const editor = await bootstrapLocalSession('relay-editor');
    const roomId = 'relay-presence-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const editorSocket = await connectGranted(editor, roomId);

    try {
      const presenceFrames: Uint8Array[] = [];
      ownerSocket.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          const frame = new Uint8Array(event.data);
          // Extract message type from leading varint
          try {
            const decoder = decoding.createDecoder(frame);
            const msgType = decoding.readVarUint(decoder);
            if (msgType === PRESENCE_MESSAGE_TYPE) {
              presenceFrames.push(frame);
            }
          } catch {
            // Ignore malformed frames
          }
        }
      });

      // Editor sends a forged presence frame claiming the owner is kicked
      const presencePayload = encodePresenceMessage({ isKicked: true });
      editorSocket.send(presencePayload.buffer as ArrayBuffer);

      // Wait for any relay to arrive
      await new Promise((r) => setTimeout(r, 500));

      // No presence frame should have been relayed to owner
      expect(presenceFrames).toHaveLength(0);
    } finally {
      try {
        ownerSocket.close();
      } catch {
        // Already closed
      }
      try {
        editorSocket.close();
      } catch {
        // Already closed
      }
    }
  });

  it('still relays ordinary Yjs sync frames from editor peers', async () => {
    const owner = await bootstrapLocalSession('relay-sync-owner');
    const editor = await bootstrapLocalSession('relay-sync-editor');
    const roomId = 'relay-sync-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const editorSocket = await connectGranted(editor, roomId);

    try {
      const syncFrames: Uint8Array[] = [];
      ownerSocket.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          const frame = new Uint8Array(event.data);
          // Extract message type from leading varint
          try {
            const decoder = decoding.createDecoder(frame);
            const msgType = decoding.readVarUint(decoder);
            if (msgType === MESSAGE_SYNC) {
              syncFrames.push(frame);
            }
          } catch {
            // Ignore malformed frames
          }
        }
      });

      // Editor sends a Yjs sync frame (sync step 1)
      const syncEncoder = encoding.createEncoder();
      encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
      encoding.writeVarUint(syncEncoder, 0); // sync step 1
      const syncFrame = encoding.toUint8Array(syncEncoder);

      editorSocket.send(syncFrame.buffer as ArrayBuffer);

      // Wait for relay to arrive
      await new Promise((r) => setTimeout(r, 500));

      // Sync frame should have been relayed
      expect(syncFrames.length).toBeGreaterThan(0);
    } finally {
      try {
        ownerSocket.close();
      } catch {
        // Already closed
      }
      try {
        editorSocket.close();
      } catch {
        // Already closed
      }
    }
  });
});

/**
 * Polls a condition the object satisfies asynchronously, up to a deadline.
 *
 * Fifteen seconds for the same reason the socket deadlines in
 * roomDO.workers.test.ts are: a short net reports a loaded runner as a hang.
 */
async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 750; attempt += 1) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('abnormal disconnect', () => {
  it("sweeps a departed peer's cursor when the socket dies with an error", async () => {
    const owner = await bootstrapLocalSession('error-owner');
    const witness = await bootstrapLocalSession('error-witness');
    const roomId = 'error-handler-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, witness, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const witnessSocket = await connectGranted(witness, roomId);

    // The witness keeps its own copy of the document, so what the room decides
    // about the departed cursor is observable without reaching into the object.
    const mirror = new Y.Doc();
    witnessSocket.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        handleSyncFrame(mirror, new Uint8Array(event.data));
      }
    });

    try {
      const seed = new Y.Doc();
      seed.getMap('cursors').set('ghost-peer', { x: 1, y: 2 });
      ownerSocket.send(encodeUpdateFrame(Y.encodeStateAsUpdate(seed)).buffer as ArrayBuffer);
      await waitUntil(() => mirror.getMap('cursors').has('ghost-peer'), 'the cursor to arrive');

      // workerd routes an error close to webSocketError, not webSocketClose, so
      // this is the path a network drop or a crashed tab actually takes.
      await runInDurableObject(
        env.ROOMS.get(env.ROOMS.idFromName(roomId)),
        async (instance: RoomDO) => {
          const ctx = (instance as unknown as { ctx: { getWebSockets(): WebSocket[] } }).ctx;
          const server = ctx.getWebSockets().find((socket) => {
            const attachment = socket.deserializeAttachment() as { accountId?: string } | null;
            return attachment?.accountId === owner.accountId;
          });
          if (!server) throw new Error('no server-side socket for the owner');
          await instance.webSocketError(server, new Error('abnormal disconnect'));
        },
      );

      await waitUntil(
        () => !mirror.getMap('cursors').has('ghost-peer'),
        'the departed cursor to be swept',
      );
    } finally {
      try {
        ownerSocket.close();
      } catch {
        // Already closed by the error handler.
      }
      witnessSocket.close();
    }
  });
});
