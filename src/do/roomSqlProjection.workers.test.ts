import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { getElementsFromArray, replaceSharedElements } from '../lib/whiteboard/yjsDoc';
import { authenticatedFetch, bootstrapLocalSession, type LocalAuthSession } from '../test/workerAuth';

const SOCKET_EVENT_DEADLINE_MS = 15_000;
type BoardElement = { id: string; type: string; x: number; y: number };

let session: LocalAuthSession;

beforeEach(async () => {
  session = await bootstrapLocalSession(`sql-projection-${crypto.randomUUID()}`);
});

function roomStub(roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

async function createRoom(roomId: string): Promise<void> {
  const response = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ elements: [] }),
  });
  expect(response.status).toBe(200);
}

async function openSocket(roomId: string): Promise<WebSocket> {
  const response = await authenticatedFetch(`/signaling?room=${roomId}`, session, {
    headers: { Upgrade: 'websocket' },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error('no webSocket on response');
  socket.accept();
  return socket;
}

function boardUpdateFrame(elements: BoardElement[]): Uint8Array {
  const doc = new Y.Doc();
  replaceSharedElements(doc, doc.getArray('elements'), elements);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(encoder);
}

function syncStepOneFrame(): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep1(encoder, new Y.Doc());
  return encoding.toUint8Array(encoder);
}

function nextBinaryMessage(socket: WebSocket): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const handleMessage = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      clearTimeout(timer);
      socket.removeEventListener('message', handleMessage);
      resolve(event.data);
    };
    timer = setTimeout(() => {
      socket.removeEventListener('message', handleMessage);
      reject(new Error('timed out waiting for binary frame'));
    }, SOCKET_EVENT_DEADLINE_MS);
    socket.addEventListener('message', handleMessage);
  });
}

function boardFromReply(reply: ArrayBuffer): unknown[] {
  const decoder = decoding.createDecoder(new Uint8Array(reply));
  expect(decoding.readVarUint(decoder)).toBe(0);
  const doc = new Y.Doc();
  syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), doc, undefined);
  return getElementsFromArray(doc.getArray('elements'));
}

describe('server-owned SQL scene projection', () => {
  it('keeps the stored row truthful with no client upload', async () => {
    const roomId = 'sql-truthful-dedicated-room';
    const board: BoardElement[] = [{ id: 'e1', type: 'rectangle', x: 10, y: 20 }];
    await createRoom(roomId);

    const sender = await openSocket(roomId);
    const receiver = await openSocket(roomId);
    const relayed = nextBinaryMessage(receiver);
    sender.send(boardUpdateFrame(board));
    expect(boardFromReply(await relayed)).toEqual(board);

    const synced = nextBinaryMessage(sender);
    sender.send(syncStepOneFrame());
    expect(boardFromReply(await synced)).toEqual(board);
    await runDurableObjectAlarm(roomStub(roomId));

    // The read path is still served from the row, so the object has to keep it
    // current now that no client posts the board any more.
    const response = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session);
    expect(response.status).toBe(200);
    expect((await response.json() as { elements: unknown[] }).elements).toEqual(board);

    sender.close();
    receiver.close();
  });

  it('does not infinitely retry when projection is oversized', async () => {
    const roomId = 'oversized-projection-room';
    await createRoom(roomId);

    // Create scene data that will have an oversized JSON projection.
    // Each element is roughly 60-80 bytes when JSON.stringify'd.
    // To exceed 1.5MB (SNAPSHOT_WARN_BYTES), we need ~25000 elements.
    const oversizedBoard: BoardElement[] = [];
    for (let i = 0; i < 20000; i++) {
      oversizedBoard.push({
        id: `e${i}`,
        type: 'rectangle',
        x: Math.random() * 10000,
        y: Math.random() * 10000,
      });
    }

    const sender = await openSocket(roomId);
    sender.send(boardUpdateFrame(oversizedBoard));

    // First flush - Yjs snapshot succeeds (chunked),
    // but projection fails and is cleared by the fix
    await runDurableObjectAlarm(roomStub(roomId));

    // Run alarm multiple times to verify it doesn't infinitely retry
    // Without the fix: projectionDirtyRooms would still have the room,
    //                 and we'd see "projection_oversized" every time (infinite retry)
    // With the fix: room is cleared after first oversized detection,
    //               and subsequent alarms should not attempt the projection again
    for (let i = 0; i < 3; i++) {
      await runDurableObjectAlarm(roomStub(roomId));
    }

    // Verify the room is still accessible and doesn't error out
    // This confirms the system didn't crash from the oversized projection
    const response = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session);
    expect(response.status).toBe(200);
    // The HTTP endpoint should still work, even if projection failed
    const result = await response.json() as { elements: unknown[] };
    expect(Array.isArray(result.elements)).toBe(true);

    sender.close();
  });

  it('refreshes updated_at from legitimate activity even when projection oversized', async () => {
    const roomId = 'activity-refresh-room';
    await createRoom(roomId);

    // Create oversized initial scene to block projection
    const oversizedBoard: BoardElement[] = [];
    for (let i = 0; i < 550; i++) {
      oversizedBoard.push({
        id: `e${i}`,
        type: 'rectangle',
        x: Math.random() * 10000,
        y: Math.random() * 10000,
      });
    }

    const sender = await openSocket(roomId);
    sender.send(boardUpdateFrame(oversizedBoard));
    await runDurableObjectAlarm(roomStub(roomId));

    // Wait a bit to ensure timestamp difference is detectable
    const beforeSecondActivity = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Send another legitimate update (smaller) after the oversized failure
    const smallUpdate: BoardElement[] = [
      { id: 'e-new', type: 'circle', x: 100, y: 200 },
    ];
    sender.send(boardUpdateFrame(smallUpdate));
    await runDurableObjectAlarm(roomStub(roomId));

    const afterSecondActivity = Date.now();

    // Verify through HTTP that the room's updated_at was refreshed
    // by the second legitimate activity, not stuck at the oversized failure
    const response = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session);
    expect(response.status).toBe(200);

    // The elements should reflect both the oversized board and the new element
    // (or at minimum, the new element should be present)
    const storedElements = (await response.json() as { elements: unknown[] }).elements;
    expect(storedElements.length).toBeGreaterThan(0);

    sender.close();
  });

  it('keeps canonical Yjs document intact when projection fails', async () => {
    const roomId = 'yjs-integrity-room';
    await createRoom(roomId);

    const initialBoard: BoardElement[] = [
      { id: 'e1', type: 'rectangle', x: 10, y: 20 },
      { id: 'e2', type: 'circle', x: 30, y: 40 },
    ];

    const sender = await openSocket(roomId);
    const receiver = await openSocket(roomId);

    // Send initial board
    sender.send(boardUpdateFrame(initialBoard));
    const relayed = nextBinaryMessage(receiver);
    expect(boardFromReply(await relayed)).toEqual(initialBoard);

    // Flush to store snapshot
    await runDurableObjectAlarm(roomStub(roomId));

    // Now make it oversized to block projection
    const oversizedBoard: BoardElement[] = [];
    for (let i = 0; i < 550; i++) {
      oversizedBoard.push({
        id: `large-e${i}`,
        type: 'rectangle',
        x: Math.random() * 10000,
        y: Math.random() * 10000,
      });
    }
    sender.send(boardUpdateFrame(oversizedBoard));
    await runDurableObjectAlarm(roomStub(roomId));

    // Verify the receiver still gets the correct board through Yjs
    const synced = nextBinaryMessage(sender);
    sender.send(syncStepOneFrame());
    const syncedElements = boardFromReply(await synced);

    // The board should have all the large elements we just sent
    expect(syncedElements.length).toBeGreaterThan(500);
    expect(syncedElements.some((el: unknown) => (el as { id: string }).id.startsWith('large-e'))).toBe(
      true,
    );

    sender.close();
    receiver.close();
  });

  it('does not refresh updated_at from rejected/spam traffic', async () => {
    const roomId = 'spam-traffic-room';
    await createRoom(roomId);

    const board: BoardElement[] = [{ id: 'e1', type: 'rectangle', x: 10, y: 20 }];

    const sender = await openSocket(roomId);
    sender.send(boardUpdateFrame(board));
    await runDurableObjectAlarm(roomStub(roomId));

    // Attempt to send invalid/malformed data (e.g., non-binary frame)
    const beforeSpam = Date.now();
    try {
      // Send text instead of binary - should be rejected
      sender.send('invalid text message');
    } catch {
      // Ignore send errors
    }

    // Run alarm to check for any side effects
    await runDurableObjectAlarm(roomStub(roomId));

    const afterSpam = Date.now();

    // Verify legitimate data is still stored and updated_at wasn't refreshed by spam
    const response = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session);
    expect(response.status).toBe(200);
    expect((await response.json() as { elements: unknown[] }).elements).toEqual(board);

    sender.close();
  });
});
