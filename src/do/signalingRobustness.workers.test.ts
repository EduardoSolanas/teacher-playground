import { describe, expect, it, afterEach } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';
import { SIGNALING_MAX_SOCKETS_PER_ACCOUNT } from '../lib/worker/requestGuard';
import { MESSAGE_SYNC } from '../lib/whiteboard/serverSync';
import { RoomDO } from './RoomDO';

/*
 * How long a socket event may take before the test gives up. Matched to the
 * deadline in roomDO.workers.test.ts, which documents why a one-second net
 * reports healthy sockets as hung on a loaded runner.
 */
const SOCKET_EVENT_DEADLINE_MS = 15_000;

async function writeRoom(roomId: string, who: LocalAuthSession, body: Record<string, unknown> = { elements: [] }) {
  return authenticatedFetch(`/api/whiteboard/room/${roomId}`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

/**
 * Builds a valid Yjs sync step 1 frame (what a fresh client sends to signal its state).
 * Used to verify sockets are still usable after receiving malformed frames.
 */
function buildSyncStepOneFrame(): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, new Y.Doc());
  return encoding.toUint8Array(encoder);
}

/**
 * Waits for a binary message on the given socket, racing against a timeout.
 * Returns the message data or throws if timeout expires.
 */
function nextBinaryMessage(ws: WebSocket, timeoutMs: number = SOCKET_EVENT_DEADLINE_MS): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for binary frame'));
    }, timeoutMs);
    ws.addEventListener('message', (event: MessageEvent) => {
      clearTimeout(timer);
      if (event.data instanceof ArrayBuffer) {
        resolve(event.data);
      } else {
        reject(new Error('expected binary frame'));
      }
    }, { once: true });
  });
}

describe('signaling robustness: per-account socket cap', () => {
  afterEach(() => {
    RoomDO.signalingMaxSocketsPerRoomForTests = null;
  });

  it('refuses upgrade when account reaches SIGNALING_MAX_SOCKETS_PER_ACCOUNT', async () => {
    const owner = await bootstrapLocalSession('rob-peraccount-owner');
    const peer = await bootstrapLocalSession('rob-peraccount-peer');
    const roomId = 'rob-peraccount-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, peer, roomId);

    const sockets: WebSocket[] = [];
    try {
      // Open up to the limit
      for (let i = 0; i < SIGNALING_MAX_SOCKETS_PER_ACCOUNT; i++) {
        const res = await signalingUpgrade(peer, roomId);
        expect(res.status).toBe(101);
        const ws = res.webSocket;
        if (!ws) throw new Error('no webSocket on response');
        ws.accept();
        sockets.push(ws);
      }

      // The next upgrade should be refused with 403
      const rejected = await signalingUpgrade(peer, roomId);
      expect(rejected.status).toBe(403);
      expect(rejected.webSocket).toBeNull();
    } finally {
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {
          // Already closed
        }
      }
    }
  });

  it('allows different account to connect when one account hits cap', async () => {
    const owner = await bootstrapLocalSession('rob-peraccount-owner2');
    const peer1 = await bootstrapLocalSession('rob-peraccount-peer1');
    const peer2 = await bootstrapLocalSession('rob-peraccount-peer2');
    const roomId = 'rob-peraccount-room2';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, peer1, roomId);
    await grantEditor(owner, peer2, roomId);

    const peer1Sockets: WebSocket[] = [];

    try {
      // Fill up peer1's quota
      for (let i = 0; i < SIGNALING_MAX_SOCKETS_PER_ACCOUNT; i++) {
        const res = await signalingUpgrade(peer1, roomId);
        expect(res.status).toBe(101);
        const ws = res.webSocket;
        if (!ws) throw new Error('no webSocket on response');
        ws.accept();
        peer1Sockets.push(ws);
      }

      // Peer1 is at cap
      let rejected = await signalingUpgrade(peer1, roomId);
      expect(rejected.status).toBe(403);

      // But peer2 should still be able to connect
      const peer2Res = await signalingUpgrade(peer2, roomId);
      expect(peer2Res.status).toBe(101);
      const peer2Ws = peer2Res.webSocket;
      if (!peer2Ws) throw new Error('no webSocket on response');
      peer2Ws.accept();

      try {
        // Verify peer2's socket works
        expect(peer2Ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        peer2Ws.close();
      }
    } finally {
      for (const ws of peer1Sockets) {
        try {
          ws.close();
        } catch {
          // Already closed
        }
      }
    }
  });
});

describe('signaling robustness: per-room socket cap', () => {
  afterEach(() => {
    RoomDO.signalingMaxSocketsPerRoomForTests = null;
  });

  it('refuses upgrade when room reaches per-room cap', async () => {
    const owner = await bootstrapLocalSession('rob-perroom-owner');
    const peers: LocalAuthSession[] = [];
    const roomId = 'rob-perroom-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);

    // Create multiple different accounts to open sockets
    const maxPerRoom = 5; // Use a small test value
    for (let i = 0; i < maxPerRoom + 1; i++) {
      peers.push(await bootstrapLocalSession(`rob-perroom-peer${i}`));
      await grantEditor(owner, peers[i], roomId);
    }

    const sockets: WebSocket[] = [];
    try {
      // Override the per-room cap for testing
      RoomDO.signalingMaxSocketsPerRoomForTests = maxPerRoom;

      // Open sockets up to the limit
      for (let i = 0; i < maxPerRoom; i++) {
        const res = await signalingUpgrade(peers[i], roomId);
        expect(res.status).toBe(101);
        const ws = res.webSocket;
        if (!ws) throw new Error('no webSocket on response');
        ws.accept();
        sockets.push(ws);
      }

      // The next peer's upgrade should be refused
      const rejected = await signalingUpgrade(peers[maxPerRoom], roomId);
      expect(rejected.status).toBe(403);
      expect(rejected.webSocket).toBeNull();
    } finally {
      RoomDO.signalingMaxSocketsPerRoomForTests = null;
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {
          // Already closed
        }
      }
    }
  });
});

describe('signaling robustness: upgrade preconditions', () => {
  afterEach(() => {
    RoomDO.signalingMaxSocketsPerRoomForTests = null;
  });

  it('returns 426 when Upgrade header is missing', async () => {
    const owner = await bootstrapLocalSession('rob-upheader-owner');
    const roomId = 'rob-upheader-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);

    // No Upgrade header
    const rejected = await authenticatedFetch(`/signaling?room=${roomId}`, owner, {});
    expect(rejected.status).toBe(426);
    expect(rejected.webSocket).toBeNull();
  });

  it('returns 404 for nonexistent room', async () => {
    const owner = await bootstrapLocalSession('rob-notfound-owner');
    const roomId = 'rob-notfound-nonexistent-room';

    const rejected = await signalingUpgrade(owner, roomId);
    expect(rejected.status).toBe(404);
    expect(rejected.webSocket).toBeNull();
  });

  it('returns 400 for missing room id', async () => {
    const owner = await bootstrapLocalSession('rob-missingroom-owner');

    // No room parameter
    const rejected = await authenticatedFetch('/signaling', owner, {
      headers: { Upgrade: 'websocket' },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.webSocket).toBeNull();
  });
});

describe('signaling robustness: ungranted callers', () => {
  afterEach(() => {
    RoomDO.signalingMaxSocketsPerRoomForTests = null;
  });

  it('refuses upgrade for account with no grant in room', async () => {
    const owner = await bootstrapLocalSession('rob-nogrant-owner');
    const outsider = await bootstrapLocalSession('rob-nogrant-outsider');
    const roomId = 'rob-nogrant-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    // outsider has no grant

    const rejected = await signalingUpgrade(outsider, roomId);
    expect(rejected.status).toBe(403);
    expect(rejected.webSocket).toBeNull();
  });

  it('refuses upgrade for pending peer', async () => {
    const owner = await bootstrapLocalSession('rob-pending-owner');
    const pending = await bootstrapLocalSession('rob-pending-peer');
    const roomId = 'rob-pending-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);

    // Create a pending request (no approval yet)
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, pending, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'PendingPeer' }),
    })).status).toBe(201);

    // Try to upgrade without approval
    const rejected = await signalingUpgrade(pending, roomId);
    expect(rejected.status).toBe(403);
    expect(rejected.webSocket).toBeNull();
  });

  it('allows upgrade for owner', async () => {
    const owner = await bootstrapLocalSession('rob-owner-owner');
    const roomId = 'rob-owner-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const ws = await connectGranted(owner, roomId);
    try {
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
    }
  });

  it('allows upgrade for viewer', async () => {
    const owner = await bootstrapLocalSession('rob-viewer-owner');
    const viewer = await bootstrapLocalSession('rob-viewer-viewer');
    const roomId = 'rob-viewer-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantViewer(owner, viewer, roomId);

    const ws = await connectGranted(viewer, roomId);
    try {
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
    }
  });

  it('allows upgrade for editor', async () => {
    const owner = await bootstrapLocalSession('rob-editor-owner');
    const editor = await bootstrapLocalSession('rob-editor-editor');
    const roomId = 'rob-editor-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);

    const ws = await connectGranted(editor, roomId);
    try {
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
    }
  });
});

describe('signaling robustness: viewer frames do not fan out', () => {
  afterEach(() => {
    RoomDO.signalingMaxSocketsPerRoomForTests = null;
  });

  it('viewer BINARY frame is not relayed to owner', async () => {
    const owner = await bootstrapLocalSession('rob-viewerfan-owner');
    const viewer = await bootstrapLocalSession('rob-viewerfan-viewer');
    const roomId = 'rob-viewerfan-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantViewer(owner, viewer, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const viewerSocket = await connectGranted(viewer, roomId);

    let ownerReceivedMessage = false;
    const ownerListener = () => {
      ownerReceivedMessage = true;
    };

    try {
      ownerSocket.addEventListener('message', ownerListener);

      // Send a binary frame from viewer
      const testData = new Uint8Array([1, 2, 3, 4, 5]);
      viewerSocket.send(testData);

      // Wait a bit to see if owner receives anything
      await new Promise((r) => setTimeout(r, 200));

      // Owner should not have received the viewer's binary frame
      expect(ownerReceivedMessage).toBe(false);
    } finally {
      ownerSocket.removeEventListener('message', ownerListener);
      ownerSocket.close();
      viewerSocket.close();
    }
  });
});

describe('signaling robustness: malformed JSON control frames', () => {
  afterEach(() => {
    RoomDO.signalingMaxSocketsPerRoomForTests = null;
  });

  it('ignores non-JSON text frame and socket remains open', async () => {
    const owner = await bootstrapLocalSession('rob-malformed-owner');
    const witness = await bootstrapLocalSession('rob-malformed-witness');
    const roomId = 'rob-malformed-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, witness, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const witnessSocket = await connectGranted(witness, roomId);

    try {
      // Send invalid JSON from owner
      ownerSocket.send('not valid json at all');

      // Send a valid binary sync frame from owner
      const syncFrame = buildSyncStepOneFrame();
      ownerSocket.send(syncFrame);

      // Witness should receive the binary frame, proving socket is still usable
      const received = await nextBinaryMessage(witnessSocket);
      expect(received).toEqual(syncFrame.buffer);
    } finally {
      ownerSocket.close();
      witnessSocket.close();
    }
  });

  it('ignores JSON array and socket remains open', async () => {
    const owner = await bootstrapLocalSession('rob-malarray-owner');
    const witness = await bootstrapLocalSession('rob-malarray-witness');
    const roomId = 'rob-malarray-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, witness, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const witnessSocket = await connectGranted(witness, roomId);

    try {
      // Send a JSON array (not an object)
      ownerSocket.send(JSON.stringify([1, 2, 3]));

      // Send a valid binary sync frame from owner
      const syncFrame = buildSyncStepOneFrame();
      ownerSocket.send(syncFrame);

      // Witness should receive the binary frame, proving socket is still usable
      const received = await nextBinaryMessage(witnessSocket);
      expect(received).toEqual(syncFrame.buffer);
    } finally {
      ownerSocket.close();
      witnessSocket.close();
    }
  });

  it('ignores JSON object without type field and socket remains open', async () => {
    const owner = await bootstrapLocalSession('rob-notype-owner');
    const witness = await bootstrapLocalSession('rob-notype-witness');
    const roomId = 'rob-notype-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, witness, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const witnessSocket = await connectGranted(witness, roomId);

    try {
      // Send a JSON object without 'type' field
      ownerSocket.send(JSON.stringify({ data: 'no type field' }));

      // Send a valid binary sync frame from owner
      const syncFrame = buildSyncStepOneFrame();
      ownerSocket.send(syncFrame);

      // Witness should receive the binary frame, proving socket is still usable
      const received = await nextBinaryMessage(witnessSocket);
      expect(received).toEqual(syncFrame.buffer);
    } finally {
      ownerSocket.close();
      witnessSocket.close();
    }
  });

  it('ignores unknown type value and socket remains open', async () => {
    const owner = await bootstrapLocalSession('rob-unknowntype-owner');
    const witness = await bootstrapLocalSession('rob-unknowntype-witness');
    const roomId = 'rob-unknowntype-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, witness, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const witnessSocket = await connectGranted(witness, roomId);

    try {
      // Send JSON with unknown type
      ownerSocket.send(JSON.stringify({ type: 'unknownTypeValue' }));

      // Send a valid binary sync frame from owner
      const syncFrame = buildSyncStepOneFrame();
      ownerSocket.send(syncFrame);

      // Witness should receive the binary frame, proving socket is still usable
      const received = await nextBinaryMessage(witnessSocket);
      expect(received).toEqual(syncFrame.buffer);
    } finally {
      ownerSocket.close();
      witnessSocket.close();
    }
  });
});

describe('signaling robustness: subscribe and unsubscribe frames', () => {
  afterEach(() => {
    RoomDO.signalingMaxSocketsPerRoomForTests = null;
  });

  it('accepts subscribe frame without error', async () => {
    const owner = await bootstrapLocalSession('rob-subscribe-owner');
    const witness = await bootstrapLocalSession('rob-subscribe-witness');
    const roomId = 'rob-subscribe-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, witness, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const witnessSocket = await connectGranted(witness, roomId);

    try {
      // Send subscribe frame
      ownerSocket.send(JSON.stringify({ type: 'subscribe' }));

      // Send a valid binary sync frame to verify socket is still usable
      const syncFrame = buildSyncStepOneFrame();
      ownerSocket.send(syncFrame);

      // Witness should receive the binary frame, proving socket is still usable
      const received = await nextBinaryMessage(witnessSocket);
      expect(received).toEqual(syncFrame.buffer);
    } finally {
      ownerSocket.close();
      witnessSocket.close();
    }
  });

  it('accepts unsubscribe frame without error', async () => {
    const owner = await bootstrapLocalSession('rob-unsubscribe-owner');
    const witness = await bootstrapLocalSession('rob-unsubscribe-witness');
    const roomId = 'rob-unsubscribe-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, witness, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const witnessSocket = await connectGranted(witness, roomId);

    try {
      // Send unsubscribe frame
      ownerSocket.send(JSON.stringify({ type: 'unsubscribe' }));

      // Send a valid binary sync frame to verify socket is still usable
      const syncFrame = buildSyncStepOneFrame();
      ownerSocket.send(syncFrame);

      // Witness should receive the binary frame, proving socket is still usable
      const received = await nextBinaryMessage(witnessSocket);
      expect(received).toEqual(syncFrame.buffer);
    } finally {
      ownerSocket.close();
      witnessSocket.close();
    }
  });

  it('handles multiple subscribe/unsubscribe frames', async () => {
    const owner = await bootstrapLocalSession('rob-multisubscribe-owner');
    const witness = await bootstrapLocalSession('rob-multisubscribe-witness');
    const roomId = 'rob-multisubscribe-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, witness, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const witnessSocket = await connectGranted(witness, roomId);

    try {
      // Send multiple subscribe/unsubscribe frames
      ownerSocket.send(JSON.stringify({ type: 'subscribe' }));
      ownerSocket.send(JSON.stringify({ type: 'unsubscribe' }));
      ownerSocket.send(JSON.stringify({ type: 'subscribe' }));
      ownerSocket.send(JSON.stringify({ type: 'unsubscribe' }));

      // Send a valid binary sync frame to verify socket is still usable
      const syncFrame = buildSyncStepOneFrame();
      ownerSocket.send(syncFrame);

      // Witness should receive the binary frame, proving socket is still usable
      const received = await nextBinaryMessage(witnessSocket);
      expect(received).toEqual(syncFrame.buffer);
    } finally {
      ownerSocket.close();
      witnessSocket.close();
    }
  });
});
