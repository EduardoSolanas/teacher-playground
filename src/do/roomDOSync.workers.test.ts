import { beforeEach, describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { addElementToArray, getElementsFromArray, replaceSharedElements } from '../lib/whiteboard/yjsDoc';
import { getIdentityObject, type IdentityDO } from './IdentityDO';

import { RoomDO } from './RoomDO';
import { ROOM_SETTINGS_KEYS } from '../lib/whiteboard/requestSchemas';
import { MAX_BODY_BYTES } from '../lib/worker/requestGuard';
import { issueGuestPin } from '../lib/whiteboard/guestPin';
import { decodePresenceMessage } from '../lib/whiteboard/presenceMessage';
import { encodeUpdateFrame } from '../lib/whiteboard/serverSync';
import {
  joinSnapshotChunks,
  legacySnapshotKey,
  snapshotChunkKey,
  snapshotMetaKey,
} from '../lib/whiteboard/snapshotChunks';
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

describe('server-side y-websocket sync', () => {
  type BoardElement = { id: string; type: string; x: number; y: number };

  async function connect(roomId: string): Promise<WebSocket> {
    expect((await createRoom(roomId)).status).toBe(200);
    return openSocket(roomId);
  }

  async function openSocket(roomId: string): Promise<WebSocket> {
    return openSocketAs(session, roomId);
  }

  async function openSocketAs(who: LocalAuthSession, roomId: string): Promise<WebSocket> {
    const res = await authenticatedFetch(`/signaling?room=${roomId}`, who, {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error('no webSocket on response');
    ws.accept();
    return ws;
  }

  function nextBinaryMessage(ws: WebSocket): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), SOCKET_EVENT_DEADLINE_MS);
      ws.addEventListener('message', (event: MessageEvent) => {
        clearTimeout(timer);
        if (!(event.data instanceof ArrayBuffer)) {
          reject(new Error('expected ArrayBuffer'));
          return;
        }
        resolve(event.data);
      }, { once: true });
    });
  }

  /**
   * The frame a client sends after drawing. Built through `replaceSharedElements`
   * because that is the shape the real clients put on the wire, point codec and
   * all — a hand-rolled array of plain objects would test a document no client
   * ever produces.
   */
  function boardUpdateFrame(elements: BoardElement[]): Uint8Array {
    const doc = new Y.Doc();
    replaceSharedElements(doc, doc.getArray('elements'), elements);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
    return encoding.toUint8Array(encoder);
  }

  /** The frame a fresh client sends on connect: sync step 1, empty state vector. */
  function syncStepOneFrame(): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeSyncStep1(encoder, new Y.Doc());
    return encoding.toUint8Array(encoder);
  }

  /** Applies a server reply the way the joining client would. */
  function boardFromReply(reply: ArrayBuffer): unknown[] {
    const decoder = decoding.createDecoder(new Uint8Array(reply));
    expect(decoding.readVarUint(decoder)).toBe(0);
    const doc = new Y.Doc();
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), doc, undefined);
    return getElementsFromArray(doc.getArray('elements'));
  }

  function roomStub(roomId: string) {
    return env.ROOMS.get(env.ROOMS.idFromName(roomId));
  }

  /** The board as the DO wrote it into its own storage. */
  async function storedBoard(roomId: string): Promise<unknown[] | null> {
    // The board is stored across as many values as it needs; reading it back
    // has to rejoin them, exactly as the object does.
    const stored = await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
      const storage = (instance as unknown as { ctx: DurableObjectState }).ctx.storage;
      const count = await storage.get(snapshotMetaKey(roomId)) as number | undefined;
      if (typeof count !== 'number' || count < 1) {
        return await storage.get(legacySnapshotKey(roomId));
      }
      const keys = Array.from({ length: count }, (_, index) => snapshotChunkKey(roomId, index));
      const chunks = await storage.get(keys) as Map<string, Uint8Array>;
      return joinSnapshotChunks(keys.map((key) => chunks.get(key))) ?? undefined;
    });
    if (!stored) return null;
    const bytes = stored instanceof Uint8Array ? stored : new Uint8Array(stored as ArrayBuffer);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes);
    return getElementsFromArray(doc.getArray('elements'));
  }

  /** Gives the object time to handle a frame it does not acknowledge. */
  function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 200));
  }

  async function writeBoardAndClose(roomId: string, elements: BoardElement[]): Promise<void> {
    const peer = await connect(roomId);
    peer.send(boardUpdateFrame(elements));
    await settle();
    peer.close();
    await settle();
  }

  const board: BoardElement[] = [{ id: 'e1', type: 'rectangle', x: 10, y: 20 }];

  it('answers a joiner that arrives when no other peer is connected', async () => {
    const roomId = 'server-sync-room';
    await writeBoardAndClose(roomId, board);

    const joiner = await connect(roomId);
    joiner.send(syncStepOneFrame());
    // Before the object held a document this frame went unanswered: the only
    // copy of the board had left with the socket that drew it.
    expect(boardFromReply(await nextBinaryMessage(joiner))).toEqual(board);

    joiner.close();
  });

  it('hydrates a viewer and does not relay or persist its update', async () => {
    const roomId = 'viewer-server-sync-room';
    const viewerSession = await bootstrapLocalSession('viewer-server-sync-viewer');
    await writeBoardAndClose(roomId, board);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, viewerSession, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Viewer' }),
    })).status).toBe(201);
    expect((await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/requests/${viewerSession.accountId}`,
      session,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role: 'viewer' }),
      },
    )).status).toBe(200);

    const owner = await openSocket(roomId);
    const ownerMessages: ArrayBuffer[] = [];
    owner.addEventListener('message', (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) ownerMessages.push(event.data);
    });

    const viewer = await openSocketAs(viewerSession, roomId);
    viewer.send(syncStepOneFrame());
    expect(boardFromReply(await nextBinaryMessage(viewer))).toEqual(board);
    viewer.send(boardUpdateFrame([{ id: 'viewer-write', type: 'line', x: 1, y: 2 }]));
    await settle();
    expect(ownerMessages).toHaveLength(0);
    viewer.close();
    owner.close();
    await settle();
    expect(await storedBoard(roomId)).toEqual(board);
  });

  it('writes the board to storage when the last socket closes', async () => {
    const roomId = 'persist-sync-room';
    await writeBoardAndClose(roomId, board);

    expect(await storedBoard(roomId)).toEqual(board);
  });

  /*
   * The ceiling that made a board silently stop saving.
   *
   * One storage value holds 2 MB, and the whole snapshot used to go into one.
   * Past that the write throws, the room stays dirty and retries forever, and
   * from the outside an unsaveable board is indistinguishable from a safe one.
   * The chunk size is lowered here rather than a 2 MB board built, because what
   * is under test is spanning values, not the number itself.
   */
  it('rebuilds a board that spans several storage values', async () => {
    RoomDO.snapshotChunkBytesForTests = 64;
    try {
      const roomId = 'chunked-sync-room';
      await writeBoardAndClose(roomId, board);

      const chunkCount = await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => (
        await (instance as unknown as { ctx: DurableObjectState }).ctx.storage
          .get(snapshotMetaKey(roomId)) as number | undefined
      ));
      expect(chunkCount).toBeGreaterThan(1);
      expect(await storedBoard(roomId)).toEqual(board);

      await evictDurableObject(roomStub(roomId));

      const joiner = await connect(roomId);
      joiner.send(syncStepOneFrame());
      expect(boardFromReply(await nextBinaryMessage(joiner))).toEqual(board);
      joiner.close();
    } finally {
      RoomDO.snapshotChunkBytesForTests = null;
    }
  });

  it('leaves no stale chunk behind when a board shrinks', async () => {
    RoomDO.snapshotChunkBytesForTests = 64;
    try {
      const roomId = 'shrinking-sync-room';
      await writeBoardAndClose(roomId, board);
      const before = await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => (
        await (instance as unknown as { ctx: DurableObjectState }).ctx.storage
          .get(snapshotMetaKey(roomId)) as number | undefined
      ));

      // A chunk left over from a longer snapshot would be read back as part of
      // the board the next time it grew to that length again.
      RoomDO.snapshotChunkBytesForTests = 1_000_000;
      await writeBoardAndClose(roomId, board);

      const remaining = await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
        const storage = (instance as unknown as { ctx: DurableObjectState }).ctx.storage;
        const listed = await storage.list({ prefix: `ydoc-chunk:${roomId}:` });
        return listed.size;
      });
      expect(before).toBeGreaterThan(1);
      expect(remaining).toBe(1);
      // Still readable: a leftover chunk would corrupt this, not shorten it.
      // The second write appends rather than replaces, so the board is longer
      // than `board` here -- what matters is that it rejoins and decodes.
      const stored = await storedBoard(roomId);
      expect(stored).not.toBeNull();
      expect(stored!.length).toBeGreaterThanOrEqual(board.length);
    } finally {
      RoomDO.snapshotChunkBytesForTests = null;
    }
  });

  it('rebuilds the board from storage after the object is evicted', async () => {
    const roomId = 'rehydrate-sync-room';
    await writeBoardAndClose(roomId, board);

    // A real eviction, not a stand-in: the instance is torn down the way
    // hibernation tears it down, so the next frame arrives with nothing in
    // memory and must come back off storage.
    await evictDurableObject(roomStub(roomId));

    const joiner = await connect(roomId);
    joiner.send(syncStepOneFrame());
    expect(boardFromReply(await nextBinaryMessage(joiner))).toEqual(board);

    joiner.close();
  });

  it('writes the board on the alarm, while the socket is still open', async () => {
    const roomId = 'alarm-flush-room';

    const peer = await connect(roomId);
    peer.send(boardUpdateFrame(board));
    await settle();

    await runDurableObjectAlarm(roomStub(roomId));
    expect(await storedBoard(roomId)).toEqual(board);

    peer.close();
  });

  it('schedules the final edit for durable storage within the flush interval', async () => {
    const roomId = 'final-edit-deadline-room';
    const finalElement: BoardElement = { id: 'e2', type: 'ellipse', x: 30, y: 40 };
    const peer = await connect(roomId);

    peer.send(boardUpdateFrame(board));
    await settle();
    expect(await storedBoard(roomId)).toEqual(board);

    await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
      (instance as unknown as { checkIntervalMs: number }).checkIntervalMs = 30_000;
      await (instance as unknown as { ctx: DurableObjectState }).ctx.storage.deleteAlarm();
    });
    peer.send(boardUpdateFrame([finalElement]));
    await expect.poll(
      () => storedBoard(roomId),
      { timeout: 3_500, interval: 100 },
    ).toEqual(expect.arrayContaining([finalElement]));
    peer.close();
  });

  it('retries the SQL scene projection after the durable snapshot succeeds', async () => {
    const roomId = 'projection-retry-room';
    const peer = await connect(roomId);
    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      instance.db.exec(`
        CREATE TRIGGER fail_room_projection
        BEFORE UPDATE OF elements ON rooms
        WHEN NEW.room_id = '${roomId}'
        BEGIN
          SELECT RAISE(FAIL, 'projection failed');
        END
      `);
    });

    peer.send(boardUpdateFrame(board));
    await settle();
    expect(await storedBoard(roomId)).toEqual(board);
    expect(await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      const row = instance.db.prepare(
        `SELECT elements FROM rooms WHERE room_id = ?`,
      ).get(roomId) as { elements: string };
      return JSON.parse(row.elements);
    })).toEqual([]);

    peer.close();
    await settle();
    await evictDurableObject(roomStub(roomId));
    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      instance.db.exec(`DROP TRIGGER fail_room_projection`);
    });
    await runDurableObjectAlarm(roomStub(roomId));
    expect(await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      const row = instance.db.prepare(
        `SELECT elements FROM rooms WHERE room_id = ?`,
      ).get(roomId) as { elements: string };
      return JSON.parse(row.elements);
    })).toEqual(board);

  });

  it('seeds the document from a board stored before this change', async () => {
    const roomId = 'seed-from-sql-room';
    // Written the old way — the client uploaded it — so the room has elements
    // in its row and no Yjs snapshot at all.
    expect((await createRoom(roomId)).status).toBe(200);
    const write = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: board }),
    });
    expect(write.status).toBe(200);

    const joiner = await openSocket(roomId);
    joiner.send(syncStepOneFrame());
    expect(boardFromReply(await nextBinaryMessage(joiner))).toEqual(board);

    joiner.close();
  });

  /** A frame that puts one peer's cursor in the shared document. */
  function cursorFrame(peerId: string): Uint8Array {
    const doc = new Y.Doc();
    doc.getMap('cursors').set(peerId, { peerId, x: 1, y: 2 });
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
    return encoding.toUint8Array(encoder);
  }

  /** Applies one server frame to a document, the way a client would. */
  function applyFrame(doc: Y.Doc, frame: ArrayBuffer): void {
    const decoder = decoding.createDecoder(new Uint8Array(frame));
    expect(decoding.readVarUint(decoder)).toBe(0);
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), doc, undefined);
  }

  it('sweeps a departed peer cursor and tells the peers still connected', async () => {
    const roomId = 'ghost-cursor-room';
    const leaving = await connect(roomId);
    const staying = await openSocket(roomId);

    // No presence row was ever written for this peer id, so once its socket is
    // gone nothing in the room claims it.
    const watcher = new Y.Doc();
    const relayed = nextBinaryMessage(staying);
    leaving.send(cursorFrame('ghost-peer'));
    applyFrame(watcher, await relayed);
    expect(watcher.getMap('cursors').has('ghost-peer')).toBe(true);

    const swept = nextBinaryMessage(staying);
    leaving.close();
    applyFrame(watcher, await swept);
    expect(watcher.getMap('cursors').has('ghost-peer')).toBe(false);

    staying.close();
  });

  it('re-seeds from the row when a board is written straight to it', async () => {
    const roomId = 'direct-write-room';
    await writeBoardAndClose(roomId, board);
    expect(await storedBoard(roomId)).toEqual(board);

    // A write that bypasses the document entirely. The snapshot has to give
    // way to it, or the room would keep serving the board it remembers.
    const replacement = [{ id: 'e9', type: 'ellipse', x: 1, y: 2 }];
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: replacement }),
    })).status).toBe(200);

    const joiner = await openSocket(roomId);
    joiner.send(syncStepOneFrame());
    expect(boardFromReply(await nextBinaryMessage(joiner))).toEqual(replacement);

    joiner.close();
  });

  it('sweeps a departed cursor on the alarm, for a peer whose row outlived its socket', async () => {
    const roomId = 'alarm-sweep-room';
    const peer = await connect(roomId);

    const watcher = new Y.Doc();
    const relayed = nextBinaryMessage(peer);
    // A second socket writes the cursor so the first one is told about it.
    const writer = await openSocket(roomId);
    writer.send(cursorFrame('stale-peer'));
    applyFrame(watcher, await relayed);
    expect(watcher.getMap('cursors').has('stale-peer')).toBe(true);

    // Presence keeps a peer for ten seconds after its last beat, so a socket
    // that drops mid-lesson is still "present" when webSocketClose runs. The
    // alarm is what catches it afterwards.
    const swept = nextBinaryMessage(peer);
    await runDurableObjectAlarm(roomStub(roomId));
    applyFrame(watcher, await swept);
    expect(watcher.getMap('cursors').has('stale-peer')).toBe(false);

    writer.close();
    peer.close();
  });

  it('keeps the board when a room is created again with no elements', async () => {
    const roomId = 'recreate-room';
    await writeBoardAndClose(roomId, board);

    // The create call posts an empty elements array. Reading that as "the board
    // is empty now" would erase a lesson.
    expect((await createRoom(roomId)).status).toBe(200);

    const joiner = await openSocket(roomId);
    joiner.send(syncStepOneFrame());
    expect(boardFromReply(await nextBinaryMessage(joiner))).toEqual(board);

    joiner.close();
  });

  it('relays and persists all 100 sync updates pushed in a single rate window', async () => {
    const roomId = 'burst-sync-room';
    const editor = await bootstrapLocalSession('burst-sync-editor');
    expect((await createRoom(roomId)).status).toBe(200);
    await grantEditor(session, editor, roomId);

    const sender = await openSocketAs(session, roomId);
    const receiver = await openSocketAs(editor, roomId);

    const receivedUpdates: ArrayBuffer[] = [];
    receiver.addEventListener('message', (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        receivedUpdates.push(event.data);
      }
    });

    const clientDoc = new Y.Doc();
    const elementsArr = clientDoc.getArray<Record<string, unknown>>('elements');

    clientDoc.on('update', (update: Uint8Array) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeUpdate(encoder, update);
      sender.send(encoding.toUint8Array(encoder));
    });

    // Push 100 distinct sync frames through one socket inside a single rate window
    for (let i = 0; i < 100; i++) {
      addElementToArray(elementsArr as any, {
        id: `burst-elem-${i}`,
        type: 'rectangle',
        x: i * 10,
        y: i * 10,
      } as any);
    }

    // Assert (b): second peer socket received all 100 updates
    await expect.poll(
      () => receivedUpdates.length,
      { timeout: 5000, interval: 50 },
    ).toBe(100);

    const receiverDoc = new Y.Doc();
    for (const frame of receivedUpdates) {
      applyFrame(receiverDoc, frame);
    }
    const receiverElements = getElementsFromArray(receiverDoc.getArray('elements'));
    expect(receiverElements).toHaveLength(100);

    // Assert (a): server's Y.Doc contains every update
    await expect.poll(
      async () => {
        const stored = await storedBoard(roomId);
        return stored?.length;
      },
      { timeout: 5000, interval: 100 },
    ).toBe(100);

    sender.close();
    receiver.close();
  });

  it('does not close socket on awareness flood and preserves interleaved sync updates', async () => {
    const roomId = 'awareness-flood-sync-room';
    const editor = await bootstrapLocalSession('awareness-flood-editor');
    expect((await createRoom(roomId)).status).toBe(200);
    await grantEditor(session, editor, roomId);

    const sender = await openSocketAs(session, roomId);
    const receiver = await openSocketAs(editor, roomId);

    const receivedUpdates: ArrayBuffer[] = [];
    receiver.addEventListener('message', (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        receivedUpdates.push(event.data);
      }
    });

    function makeAwarenessFrame(i: number): Uint8Array {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarString(encoder, JSON.stringify({ x: i, y: i }));
      return encoding.toUint8Array(encoder);
    }

    function makeSyncFrame(elem: BoardElement): Uint8Array {
      const doc = new Y.Doc();
      const arr = doc.getArray<Record<string, unknown>>('elements');
      addElementToArray(arr as any, elem as any);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
      return encoding.toUint8Array(encoder);
    }


    const expectedSyncIds = ['sync-1', 'sync-2', 'sync-3', 'sync-4', 'sync-5'];

    // Send 150 awareness frames interleaved with 5 sync frames (total 155 messages > 120 budget)
    for (let i = 0; i < 150; i++) {
      sender.send(makeAwarenessFrame(i));
      if (i % 30 === 0) {
        const syncIndex = i / 30;
        sender.send(makeSyncFrame({
          id: expectedSyncIds[syncIndex],
          type: 'rectangle',
          x: syncIndex * 10,
          y: syncIndex * 20,
        }));
      }
    }

    // Socket must remain open despite flood
    expect(sender.readyState).toBe(WebSocket.OPEN);

    // Receiver must receive all 5 sync updates
    const receiverDoc = new Y.Doc();
    await expect.poll(
      () => {
        for (const frame of receivedUpdates) {
          try {
            const decoder = decoding.createDecoder(new Uint8Array(frame));
            if (decoding.readVarUint(decoder) === 0) {
              syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), receiverDoc, undefined);
            }
          } catch {}
        }
        const elements = getElementsFromArray(receiverDoc.getArray('elements'));
        return elements.map((e: any) => e.id);
      },
      { timeout: 5000, interval: 50 },
    ).toEqual(expect.arrayContaining(expectedSyncIds));

    // Server Y.Doc must have stored all 5 sync elements
    await expect.poll(
      async () => {
        const stored = await storedBoard(roomId);
        return stored?.map((e: any) => e.id);
      },
      { timeout: 5000, interval: 100 },
    ).toEqual(expect.arrayContaining(expectedSyncIds));

    sender.close();
    receiver.close();
  });
});

