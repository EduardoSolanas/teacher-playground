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
});
