import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import type { RoomDO } from './RoomDO';
import { getElementsFromArray } from '../lib/whiteboard/yjsDoc';
import { issueGuestPin } from '../lib/whiteboard/guestPin';
import {
  PAGE_MESSAGE_TYPE,
  decodePageMessage,
  encodePageMessage,
  type PageMessage,
} from '../lib/whiteboard/pageMessage';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';

/*
 * spec/PAGED_DOCUMENTS_SPEC.md §5.2, milestone 3: the owner-only page-turn
 * frame, mirroring `followGuide.workers.test.ts` and `roomCall.workers.test.ts`.
 * A file of its own for the same stack-limit reason those give.
 */

const SOCKET_EVENT_DEADLINE_MS = 15_000;
const GUEST_ORIGIN = 'https://join.example.com';
const PAGE_STATE_KEY = 'documents:pages';

function roomStub(roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)) as DurableObjectStub<RoomDO>;
}

function hexImportId(seed: string): string {
  return seed.padStart(16, '0').slice(-16);
}

async function writeRoom(roomId: string, owner: LocalAuthSession) {
  return authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ elements: [] }),
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

function nextPageFrame(socket: WebSocket, ms = SOCKET_EVENT_DEADLINE_MS): Promise<PageMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for a page frame')),
      ms,
    );
    socket.addEventListener('message', (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const message = decodePageMessage(new Uint8Array(event.data));
      if (!message) return;
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function expectNoPageFrame(socket: WebSocket, ms = 250): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    socket.addEventListener('message', (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      if (decodePageMessage(new Uint8Array(event.data))) {
        clearTimeout(timer);
        reject(new Error('unexpected page frame'));
      }
    });
  });
}

/** A frame that decodes as PAGE_MESSAGE_TYPE but carries an invalid payload. */
function malformedPageFrame(payload: unknown): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, PAGE_MESSAGE_TYPE);
  encoding.writeVarString(encoder, JSON.stringify(payload));
  return encoding.toUint8Array(encoder);
}

async function storedPages(roomId: string): Promise<PageMessage[] | undefined> {
  return runInDurableObject(roomStub(roomId), (_instance, state) => (
    state.storage.get(PAGE_STATE_KEY)
  ));
}

async function seedStoredPages(roomId: string, entries: PageMessage[]): Promise<void> {
  await runInDurableObject(roomStub(roomId), async (_instance, state) => {
    await state.storage.put(PAGE_STATE_KEY, entries);
  });
}

async function docElementCount(roomId: string): Promise<number> {
  return runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
    const boxed = instance as unknown as { getRoomDoc: (roomId: string) => Promise<Y.Doc> };
    const doc = await boxed.getRoomDoc(roomId);
    return getElementsFromArray(doc.getArray('elements')).length;
  });
}

describe('room document page state', () => {
  it("stores the owner's page frame and broadcasts it to other sockets, not back to the sender", async () => {
    const owner = await bootstrapLocalSession(`page-owner-${crypto.randomUUID()}`);
    const editor = await bootstrapLocalSession(`page-editor-${crypto.randomUUID()}`);
    const roomId = `page-broadcast-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await approveRole(owner, editor, roomId, 'peer');

    const ownerSocket = await openGranted(owner, roomId);
    const editorSocket = await openGranted(editor, roomId);

    const message: PageMessage = { importId: hexImportId('1'), index: 2 };
    const received = nextPageFrame(editorSocket);
    const ownerHeard = expectNoPageFrame(ownerSocket);
    ownerSocket.send(encodePageMessage(message));

    await expect(received).resolves.toEqual(message);
    await expect(ownerHeard).resolves.toBeUndefined();

    expect(await storedPages(roomId)).toEqual([message]);

    ownerSocket.close();
    editorSocket.close();
  });

  it('sends every stored page entry to a newly connected socket, after the call state', async () => {
    const owner = await bootstrapLocalSession(`page-connect-owner-${crypto.randomUUID()}`);
    const roomId = `page-connect-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const first: PageMessage = { importId: hexImportId('a'), index: 1 };
    const second: PageMessage = { importId: hexImportId('b'), index: 4 };
    await seedStoredPages(roomId, [first, second]);

    const socket = await openGranted(owner, roomId);
    await expect(nextPageFrame(socket)).resolves.toEqual(first);
    await expect(nextPageFrame(socket)).resolves.toEqual(second);

    socket.close();
  });

  it("drops an editor's page frame silently: neither broadcast nor stored", async () => {
    const owner = await bootstrapLocalSession(`page-neg-editor-owner-${crypto.randomUUID()}`);
    const editor = await bootstrapLocalSession(`page-neg-editor-editor-${crypto.randomUUID()}`);
    const roomId = `page-neg-editor-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await approveRole(owner, editor, roomId, 'peer');

    const ownerSocket = await openGranted(owner, roomId);
    const editorSocket = await openGranted(editor, roomId);

    const ownerHeard = expectNoPageFrame(ownerSocket);
    editorSocket.send(encodePageMessage({ importId: hexImportId('c'), index: 0 }));
    await expect(ownerHeard).resolves.toBeUndefined();
    expect(await storedPages(roomId)).toBeUndefined();

    ownerSocket.close();
    editorSocket.close();
  });

  it("drops a viewer's page frame silently: neither broadcast nor stored", async () => {
    const owner = await bootstrapLocalSession(`page-neg-viewer-owner-${crypto.randomUUID()}`);
    const viewer = await bootstrapLocalSession(`page-neg-viewer-viewer-${crypto.randomUUID()}`);
    const roomId = `page-neg-viewer-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await approveRole(owner, viewer, roomId, 'viewer');

    const ownerSocket = await openGranted(owner, roomId);
    const viewerSocket = await openGranted(viewer, roomId);

    const ownerHeard = expectNoPageFrame(ownerSocket);
    viewerSocket.send(encodePageMessage({ importId: hexImportId('d'), index: 0 }));
    await expect(ownerHeard).resolves.toBeUndefined();
    expect(await storedPages(roomId)).toBeUndefined();

    ownerSocket.close();
    viewerSocket.close();
  });

  it("drops a guest's page frame silently: neither broadcast nor stored", async () => {
    const owner = await bootstrapLocalSession(`page-neg-guest-owner-${crypto.randomUUID()}`);
    const roomId = `page-neg-guest-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const cookie = await mintGuestCookie(roomId);
    const accountId = await queueGuest(cookie, roomId);
    await approveGuestPeer(owner, roomId, accountId);

    const ownerSocket = await openGranted(owner, roomId);
    const guestSocket = await guestSignaling(cookie, roomId);

    const ownerHeard = expectNoPageFrame(ownerSocket);
    guestSocket.send(encodePageMessage({ importId: hexImportId('e'), index: 0 }));
    await expect(ownerHeard).resolves.toBeUndefined();
    expect(await storedPages(roomId)).toBeUndefined();

    ownerSocket.close();
    guestSocket.close();
  });

  it('drops a malformed frame and never applies it to the Yjs document', async () => {
    const owner = await bootstrapLocalSession(`page-malformed-owner-${crypto.randomUUID()}`);
    const editor = await bootstrapLocalSession(`page-malformed-editor-${crypto.randomUUID()}`);
    const roomId = `page-malformed-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await approveRole(owner, editor, roomId, 'peer');

    const before = await docElementCount(roomId);

    const ownerSocket = await openGranted(owner, roomId);
    const editorSocket = await openGranted(editor, roomId);

    const editorHeard = expectNoPageFrame(editorSocket);
    // Wrong importId shape (not 16 hex chars).
    ownerSocket.send(malformedPageFrame({ importId: 'not-hex', index: 0 }));
    await expect(editorHeard).resolves.toBeUndefined();

    expect(await storedPages(roomId)).toBeUndefined();
    expect(await docElementCount(roomId)).toBe(before);

    ownerSocket.close();
    editorSocket.close();
  });

  it('drops the oldest entry, insertion order, when the 201st entry is set', async () => {
    const owner = await bootstrapLocalSession(`page-cap-owner-${crypto.randomUUID()}`);
    const roomId = `page-cap-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const seeded: PageMessage[] = Array.from({ length: 200 }, (_, i) => ({
      importId: hexImportId(i.toString(16)),
      index: 0,
    }));
    await seedStoredPages(roomId, seeded);

    const ownerSocket = await openGranted(owner, roomId);
    // Drain the 200 stored replay frames sent on connect.
    for (let i = 0; i < 200; i += 1) {
      await nextPageFrame(ownerSocket);
    }

    const newEntry: PageMessage = { importId: hexImportId('ffff'), index: 3 };
    ownerSocket.send(encodePageMessage(newEntry));

    // Give the message handler a turn.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = await storedPages(roomId);
    expect(after).toHaveLength(200);
    expect(after?.[0]).toEqual(seeded[1]);
    expect(after?.some((entry) => entry.importId === seeded[0].importId)).toBe(false);
    expect(after?.[after.length - 1]).toEqual(newEntry);

    ownerSocket.close();
  });

  it('removes the stored page-state key when the room is deleted', async () => {
    const owner = await bootstrapLocalSession(`page-delete-owner-${crypto.randomUUID()}`);
    const roomId = `page-delete-room-${crypto.randomUUID()}`;
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await seedStoredPages(roomId, [{ importId: hexImportId('1'), index: 0 }]);
    expect(await storedPages(roomId)).toBeDefined();

    const del = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);

    expect(await storedPages(roomId)).toBeUndefined();
  });
});
