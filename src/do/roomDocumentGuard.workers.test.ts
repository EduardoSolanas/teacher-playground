import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import type { RoomDO } from './RoomDO';
import { getElementsFromArray } from '../lib/whiteboard/yjsDoc';
import { issueGuestPin } from '../lib/whiteboard/guestPin';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';

/*
 * spec/PAGED_DOCUMENTS_SPEC.md §7 / §7.1, milestone 6: only the room owner
 * creates, changes or removes a document page element, enforced on the
 * socket sync path and the HTTP scene route. Mirrors the harness in
 * roomDOSync.workers.test.ts and roomDocumentPages.workers.test.ts.
 */

const SOCKET_EVENT_DEADLINE_MS = 15_000;
const GUEST_ORIGIN = 'https://join.example.com';

function roomStub(roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)) as DurableObjectStub<RoomDO>;
}

function hexImportId(seed: string): string {
  return seed.padStart(16, '0').slice(-16);
}

function pageStamp(seed: string, index: number, pageCount = 3) {
  return { pdfPage: { importId: hexImportId(seed), index, pageCount, stacked: false } };
}

async function writeRoom(roomId: string, owner: LocalAuthSession, elements: unknown[] = []) {
  return authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ elements }),
  });
}

async function openGranted(who: LocalAuthSession, roomId: string): Promise<WebSocket> {
  const response = await authenticatedFetch(`/signaling?room=${roomId}`, who, {
    headers: { Upgrade: 'websocket' },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error('no webSocket on response');
  socket.accept();
  return socket;
}

async function approveRole(
  owner: LocalAuthSession,
  who: LocalAuthSession,
  roomId: string,
  role: 'peer' | 'viewer',
) {
  expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userName: role === 'viewer' ? 'Viewer' : 'Editor' }),
  })).status).toBe(201);
  expect((await authenticatedFetch(
    `/api/whiteboard/room/${roomId}/requests/${who.accountId}`,
    owner,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', role }),
    },
  )).status).toBe(200);
}

async function pinForRoom(roomId: string): Promise<string> {
  return runInDurableObject(
    roomStub(roomId),
    (instance: RoomDO) => issueGuestPin(instance.db, roomId, Date.now()),
  );
}

async function guestFetch(path: string, cookie: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Origin', GUEST_ORIGIN);
  headers.set('Cookie', cookie);
  return SELF.fetch(`${GUEST_ORIGIN}${path}`, { ...init, headers });
}

async function mintGuestCookie(roomId: string): Promise<string> {
  const pin = await pinForRoom(roomId);
  const response = await SELF.fetch(`${GUEST_ORIGIN}/auth/guest`, {
    method: 'POST',
    headers: { Origin: GUEST_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, pin, displayName: 'Kid' }),
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return setCookie!.split(';', 1)[0];
}

async function queueGuest(cookie: string, roomId: string): Promise<string> {
  const response = await guestFetch(`/api/whiteboard/room/${roomId}/requests`, cookie, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userName: 'Kid' }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { requestId: string };
  return body.requestId;
}

async function approveGuestPeer(owner: LocalAuthSession, roomId: string, accountId: string) {
  const approval = await authenticatedFetch(
    `/api/whiteboard/room/${roomId}/requests/${accountId}`,
    owner,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', role: 'peer' }),
    },
  );
  expect(approval.status).toBe(200);
}

async function guestSignaling(cookie: string, roomId: string): Promise<WebSocket> {
  const response = await guestFetch(`/signaling?room=${roomId}`, cookie, {
    headers: { Upgrade: 'websocket' },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error('no webSocket on granted guest response');
  ws.accept();
  return ws;
}

function nextBinaryMessage(ws: WebSocket, ms = SOCKET_EVENT_DEADLINE_MS): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a binary message')), ms);
    ws.addEventListener('message', (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      clearTimeout(timer);
      resolve(event.data);
    }, { once: true });
  });
}

/** The frame a fresh client sends on connect: sync step 1, empty state vector. */
function syncStepOneFrame(): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep1(encoder, new Y.Doc());
  return encoding.toUint8Array(encoder);
}

/** Applies one server frame to a document, the way a client would. */
function applyFrame(doc: Y.Doc, frame: ArrayBuffer): void {
  const decoder = decoding.createDecoder(new Uint8Array(frame));
  expect(decoding.readVarUint(decoder)).toBe(0);
  syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), doc, undefined);
}

/**
 * Syncs a fresh client document with the room's current state, the way any
 * real client (including a second peer just watching) does before editing or
 * before it can integrate later incremental updates about existing elements.
 *
 * A granted (non-viewer) socket's own sync-step-1 request gets *two* replies
 * from `handleSyncFrame`: the server's step-2 answer, and the server's own
 * step-1 request back (since the server always requests a sync too, for a
 * writer). The second is drained and discarded here -- otherwise it sits
 * unconsumed and a later listener for an unrelated broadcast picks it up
 * instead of the broadcast it was waiting for.
 */
async function syncClientDoc(ws: WebSocket): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const firstReply = nextBinaryMessage(ws);
  ws.send(syncStepOneFrame());
  applyFrame(doc, await firstReply);
  /*
   * The second listener is registered only now, after the first message has
   * already been received and its (`once: true`) listener removed. Two
   * listeners registered up front would both fire on the *same* first
   * message -- `dispatchEvent` invokes every attached listener for one
   * event, it does not hand successive events to successive listeners --
   * leaving the real second message (the server's own step-1 request back)
   * unconsumed for whatever listener attaches next.
   */
  await nextBinaryMessage(ws); // the server's own step-1 request; nothing to answer with in this harness.
  return doc;
}

/** Encodes a client document's changes since `before` as a sync frame. */
function updateFrameSince(doc: Y.Doc, before: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc, before));
  return encoding.toUint8Array(encoder);
}

function elementsById(elements: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  return new Map(elements.map((el) => [el.id as string, el]));
}

const INITIAL_ELEMENTS: Record<string, unknown>[] = [
  { id: 'page-move', type: 'rectangle', x: 0, y: 0, customData: pageStamp('1', 0) },
  { id: 'page-lock', type: 'rectangle', customData: pageStamp('1', 1) },
  { id: 'page-delete', type: 'rectangle', isDeleted: false, customData: pageStamp('1', 2) },
  { id: 'page-restamp', type: 'rectangle', customData: pageStamp('1', 0) },
  { id: 'page-remove', type: 'rectangle', x: 3, y: 4, customData: pageStamp('2', 0, 1) },
  { id: 'plain-add-stamp', type: 'rectangle', x: 1 },
  { id: 'stroke-1', type: 'freedraw', x: 5 },
];

/**
 * Every change the frame under test makes to `clientDoc`'s elements array:
 * every §7-refused operation the spec lists (move, unlock, mark deleted,
 * re-stamp, remove, create a page element, add a stamp to a plain element)
 * plus two ordinary edits that must still land.
 */
function applyKitchenSinkChanges(clientDoc: Y.Doc): void {
  const arr = clientDoc.getArray<Y.Map<unknown>>('elements');
  const byId = new Map<string, Y.Map<unknown>>();
  arr.toArray().forEach((map) => {
    const id = map.get('id');
    if (typeof id === 'string') byId.set(id, map);
  });

  byId.get('page-move')!.set('x', 999);
  byId.get('page-lock')!.set('locked', true); // key did not exist before
  byId.get('page-delete')!.set('isDeleted', true);
  byId.get('page-restamp')!.set('customData', pageStamp('9', 0, 1));
  const removeIndex = arr.toArray().findIndex((map) => map.get('id') === 'page-remove');
  arr.delete(removeIndex, 1);
  byId.get('plain-add-stamp')!.set('customData', pageStamp('3', 0, 1)); // adds the stamp

  const pageNew = new Y.Map<unknown>();
  pageNew.set('id', 'page-new');
  pageNew.set('type', 'rectangle');
  pageNew.set('customData', pageStamp('4', 0, 1));
  arr.push([pageNew]);

  byId.get('stroke-1')!.set('x', 42);
  const strokeNew = new Y.Map<unknown>();
  strokeNew.set('id', 'stroke-new');
  strokeNew.set('type', 'freedraw');
  arr.push([strokeNew]);
}

function assertRefused(elements: Record<string, unknown>[]): void {
  const byId = elementsById(elements);
  expect(byId.get('page-move')?.x).toBe(0);
  expect('locked' in (byId.get('page-lock') ?? {})).toBe(false);
  expect(byId.get('page-delete')?.isDeleted).toBe(false);
  expect(byId.get('page-restamp')?.customData).toEqual(pageStamp('1', 0));
  expect('customData' in (byId.get('plain-add-stamp') ?? {})).toBe(false);
  expect(byId.has('page-new')).toBe(false);
  expect(byId.get('page-remove')).toMatchObject({ x: 3, y: 4, customData: pageStamp('2', 0, 1) });
}

function assertOrdinaryChangesApplied(elements: Record<string, unknown>[]): void {
  const byId = elementsById(elements);
  expect(byId.get('stroke-1')?.x).toBe(42);
  expect(byId.has('stroke-new')).toBe(true);
}

describe('room document page guard: WebSocket sync path', () => {
  it('refuses every page-element change an editor frame makes while the same frame\'s ordinary edits still land, and a second peer never sees the refused changes', async () => {
    const owner = await bootstrapLocalSession(`guard-owner-${crypto.randomUUID()}`);
    const editor = await bootstrapLocalSession(`guard-editor-${crypto.randomUUID()}`);
    const roomId = `guard-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner, INITIAL_ELEMENTS)).status).toBe(200);
    await approveRole(owner, editor, roomId, 'peer');

    const editorSocket = await openGranted(editor, roomId);
    const peerSocket = await openGranted(owner, roomId);

    const editorDoc = await syncClientDoc(editorSocket);
    const peerDoc = await syncClientDoc(peerSocket);

    const before = Y.encodeStateVector(editorDoc);
    applyKitchenSinkChanges(editorDoc);
    const frame = updateFrameSince(editorDoc, before);

    const relayed = nextBinaryMessage(peerSocket);
    editorSocket.send(frame);
    applyFrame(peerDoc, await relayed);

    // The second peer's converged state never carries the refused changes,
    // and does carry the frame's ordinary edits.
    const peerElements = getElementsFromArray(peerDoc.getArray('elements'));
    assertRefused(peerElements);
    assertOrdinaryChangesApplied(peerElements);

    // The room's own stored document agrees.
    await expect.poll(async () => {
      const stored = await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
        const boxed = instance as unknown as { getRoomDoc: (roomId: string) => Promise<Y.Doc> };
        const doc = await boxed.getRoomDoc(roomId);
        return getElementsFromArray(doc.getArray('elements'));
      });
      return elementsById(stored).get('stroke-1')?.x;
    }).toBe(42);
    const stored = await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
      const boxed = instance as unknown as { getRoomDoc: (roomId: string) => Promise<Y.Doc> };
      const doc = await boxed.getRoomDoc(roomId);
      return getElementsFromArray(doc.getArray('elements'));
    });
    assertRefused(stored);
    assertOrdinaryChangesApplied(stored);

    editorSocket.close();
    peerSocket.close();
  });

  it('refuses a guest-with-draw-permission frame that moves a page element the same way', async () => {
    const owner = await bootstrapLocalSession(`guard-guest-owner-${crypto.randomUUID()}`);
    const roomId = `guard-guest-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner, INITIAL_ELEMENTS)).status).toBe(200);

    const cookie = await mintGuestCookie(roomId);
    const accountId = await queueGuest(cookie, roomId);
    await approveGuestPeer(owner, roomId, accountId);

    const guestSocket = await guestSignaling(cookie, roomId);

    const guestDoc = await syncClientDoc(guestSocket);
    const before = Y.encodeStateVector(guestDoc);
    const arr = guestDoc.getArray<Y.Map<unknown>>('elements');
    const pageMove = arr.toArray().find((map) => map.get('id') === 'page-move')!;
    pageMove.set('x', 555);
    const strokeOne = arr.toArray().find((map) => map.get('id') === 'stroke-1')!;
    strokeOne.set('x', 7);
    const frame = updateFrameSince(guestDoc, before);

    guestSocket.send(frame);

    await expect.poll(async () => {
      const stored = await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
        const boxed = instance as unknown as { getRoomDoc: (roomId: string) => Promise<Y.Doc> };
        const doc = await boxed.getRoomDoc(roomId);
        return getElementsFromArray(doc.getArray('elements'));
      });
      return elementsById(stored).get('stroke-1')?.x;
    }).toBe(7);
    const stored = await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
      const boxed = instance as unknown as { getRoomDoc: (roomId: string) => Promise<Y.Doc> };
      const doc = await boxed.getRoomDoc(roomId);
      return getElementsFromArray(doc.getArray('elements'));
    });
    expect(elementsById(stored).get('page-move')?.x).toBe(0);

    guestSocket.close();
  });

  it("applies the owner's identical frame -- moving, unlocking, deleting, re-stamping, removing and creating page elements all succeed", async () => {
    const owner = await bootstrapLocalSession(`guard-owner-apply-${crypto.randomUUID()}`);
    const roomId = `guard-owner-apply-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner, INITIAL_ELEMENTS)).status).toBe(200);

    const ownerSocket = await openGranted(owner, roomId);
    const ownerDoc = await syncClientDoc(ownerSocket);
    const before = Y.encodeStateVector(ownerDoc);
    applyKitchenSinkChanges(ownerDoc);
    const frame = updateFrameSince(ownerDoc, before);

    ownerSocket.send(frame);

    await expect.poll(async () => {
      const stored = await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
        const boxed = instance as unknown as { getRoomDoc: (roomId: string) => Promise<Y.Doc> };
        const doc = await boxed.getRoomDoc(roomId);
        return getElementsFromArray(doc.getArray('elements'));
      });
      return elementsById(stored).get('page-move')?.x;
    }).toBe(999);

    const stored = await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
      const boxed = instance as unknown as { getRoomDoc: (roomId: string) => Promise<Y.Doc> };
      const doc = await boxed.getRoomDoc(roomId);
      return getElementsFromArray(doc.getArray('elements'));
    });
    const byId = elementsById(stored);
    expect(byId.get('page-move')?.x).toBe(999);
    expect(byId.get('page-lock')?.locked).toBe(true);
    expect(byId.get('page-delete')?.isDeleted).toBe(true);
    expect(byId.get('page-restamp')?.customData).toEqual(pageStamp('9', 0, 1));
    expect(byId.get('plain-add-stamp')?.customData).toEqual(pageStamp('3', 0, 1));
    expect(byId.has('page-new')).toBe(true);
    expect(byId.has('page-remove')).toBe(false);

    ownerSocket.close();
  });
});

describe('room document page guard: HTTP scene route', () => {
  it("refuses an editor's scene save that moves, creates and removes page elements while the rest of the save is written", async () => {
    const owner = await bootstrapLocalSession(`guard-http-owner-${crypto.randomUUID()}`);
    const editor = await bootstrapLocalSession(`guard-http-editor-${crypto.randomUUID()}`);
    const roomId = `guard-http-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner, INITIAL_ELEMENTS)).status).toBe(200);
    await approveRole(owner, editor, roomId, 'peer');

    const submitted = INITIAL_ELEMENTS
      .filter((el) => el.id !== 'page-remove')
      .map((el) => {
        if (el.id === 'page-move') return { ...el, x: 999 };
        if (el.id === 'page-lock') return { ...el, locked: true };
        if (el.id === 'page-delete') return { ...el, isDeleted: true };
        if (el.id === 'page-restamp') return { ...el, customData: pageStamp('9', 0, 1) };
        if (el.id === 'plain-add-stamp') return { ...el, customData: pageStamp('3', 0, 1) };
        if (el.id === 'stroke-1') return { ...el, x: 42 };
        return el;
      })
      .concat([
        { id: 'page-new', type: 'rectangle', customData: pageStamp('4', 0, 1) },
        { id: 'stroke-new', type: 'freedraw' },
      ]);

    const response = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, editor, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: submitted }),
    });
    expect(response.status).toBe(200);

    const row = await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      const record = instance.db.prepare(
        `SELECT elements FROM rooms WHERE room_id = ?`,
      ).get(roomId) as { elements: string };
      return JSON.parse(record.elements) as Record<string, unknown>[];
    });

    assertRefused(row);
    assertOrdinaryChangesApplied(row);
  });

  it("applies the owner's identical scene save", async () => {
    const owner = await bootstrapLocalSession(`guard-http-owner-apply-${crypto.randomUUID()}`);
    const roomId = `guard-http-owner-apply-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner, INITIAL_ELEMENTS)).status).toBe(200);

    const submitted = INITIAL_ELEMENTS
      .filter((el) => el.id !== 'page-remove')
      .map((el) => {
        if (el.id === 'page-move') return { ...el, x: 999 };
        return el;
      })
      .concat([{ id: 'page-new', type: 'rectangle', customData: pageStamp('4', 0, 1) }]);

    const response = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: submitted }),
    });
    expect(response.status).toBe(200);

    const row = await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      const record = instance.db.prepare(
        `SELECT elements FROM rooms WHERE room_id = ?`,
      ).get(roomId) as { elements: string };
      return JSON.parse(record.elements) as Record<string, unknown>[];
    });
    const byId = elementsById(row);
    expect(byId.get('page-move')?.x).toBe(999);
    expect(byId.has('page-remove')).toBe(false);
    expect(byId.has('page-new')).toBe(true);
  });
});
