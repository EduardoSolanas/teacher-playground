import { beforeEach, describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { env, runInDurableObject } from 'cloudflare:test';
import type { RoomDO } from './RoomDO';
import { authenticatedFetch, bootstrapLocalSession, type LocalAuthSession } from '../test/workerAuth';

const SOCKET_EVENT_DEADLINE_MS = 15_000;

let session: LocalAuthSession;

beforeEach(async () => {
  session = await bootstrapLocalSession(`shared-types-guard-${crypto.randomUUID()}`);
});

function roomStub(roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)) as DurableObjectStub<RoomDO>;
}

function openSocket(who: LocalAuthSession, roomId: string): Promise<WebSocket> {
  return (async () => {
    const res = await authenticatedFetch(`/signaling?room=${roomId}`, who, {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error('no webSocket on response');
    ws.accept();
    return ws;
  })();
}

function nextBinaryMessage(ws: WebSocket): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), SOCKET_EVENT_DEADLINE_MS);
    ws.addEventListener('message', (event: MessageEvent) => {
      clearTimeout(timer);
      if (event.data instanceof ArrayBuffer) resolve(event.data);
    }, { once: true });
  });
}

function updateFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

describe('client writes to non-scene shared types are bounded', () => {
  it('prunes a flooded fileReady map, an invented type, and junk in viewport and call', async () => {
    const owner = session;
    const editorSession = await bootstrapLocalSession(`shared-types-editor-${crypto.randomUUID()}`);
    const roomId = crypto.randomUUID().replace(/-/g, '');
    const stub = roomStub(roomId);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    // Editor becomes an admitted writer: the exact role the guard has to constrain.
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, editorSession, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Editor' }),
    })).status).toBe(201);
    expect((await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/requests/${editorSession.accountId}`,
      owner,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role: 'peer' }),
      },
    )).status).toBe(200);

    const ownerSocket = await openSocket(owner, roomId);
    const editorSocket = await openSocket(editorSession, roomId);

    // Collect everything the owner is relayed from the moment before the
    // hostile frame goes out, so nothing can slip past the listener.
    const relayed: Uint8Array[] = [];
    ownerSocket.addEventListener('message', (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) relayed.push(new Uint8Array(event.data));
    });

    // One frame carrying everything an admitted but hostile editor can reach
    // outside the scene: a flooded fileReady, a type the app never defines,
    // junk keys in the viewport map, and forged call state.
    const malicious = new Y.Doc();
    const fileReady = malicious.getMap('fileReady');
    for (let i = 0; i < 2000; i += 1) {
      fileReady.set(`flood-${i}`, `x`.repeat(200));
    }
    fileReady.set('real-file-id-1', Date.now());
    fileReady.set('real-file-id-2', Date.now());
    malicious.getMap('evil').set('payload', 'y'.repeat(1000));
    const evilList = malicious.getArray('evil-list');
    for (let i = 0; i < 100; i += 1) evilList.push([`z`.repeat(500)]);
    malicious.getMap('viewport').set('x', 10);
    malicious.getMap('viewport').set('zoomBypass', 'huge-string-value'.repeat(20));
    malicious.getMap('call').set('active', true);

    editorSocket.send(updateFrame(Y.encodeStateAsUpdate(malicious)));

    // Give the server time to apply, prune, and relay.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const serverState = await runInDurableObject(stub, async (instance) => {
      const serverDoc = await (instance as unknown as {
        getRoomDoc: (roomId: string) => Promise<Y.Doc>;
      }).getRoomDoc(roomId);
      return {
        fileReadySize: serverDoc.getMap('fileReady').size,
        evilSize: serverDoc.getMap('evil').size,
        evilListLength: serverDoc.getArray('evil-list').length,
        viewportSize: serverDoc.getMap('viewport').size,
        callSize: serverDoc.getMap('call').size,
        snapshotBytes: Y.encodeStateAsUpdate(serverDoc).byteLength,
      };
    });

    expect(serverState.fileReadySize).toBe(2);
    expect(serverState.evilSize).toBe(0);
    expect(serverState.evilListLength).toBe(0);
    expect(serverState.callSize).toBe(0);
    expect(serverState.viewportSize).toBe(1);
    // The flood never entered the authoritative document, so the persisted
    // snapshot stays at the size of the room's real state.
    expect(serverState.snapshotBytes).toBeLessThan(5000);

    // The relayed diff must not carry the flood to peers either.
    const peerDoc = new Y.Doc();
    for (const frame of relayed) {
      try {
        const decoder = decoding.createDecoder(frame);
        decoding.readVarUint(decoder);
        syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), peerDoc, 'peer');
      } catch {
        // Presence and other private frames are not sync messages.
      }
    }
    expect(peerDoc.getMap('fileReady').size).toBeLessThanOrEqual(2);
    expect(peerDoc.getMap('evil').size).toBe(0);
    expect(peerDoc.getArray('evil-list').length).toBe(0);

    ownerSocket.close();
    editorSocket.close();
  });
});
