import { describe, expect, it } from 'vitest';
import { decodeFollowMessage, encodeFollowMessage } from '../lib/whiteboard/followMessage';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';

const SOCKET_EVENT_DEADLINE_MS = 15_000;

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

function nextFollow(socket: WebSocket): Promise<ReturnType<typeof decodeFollowMessage>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for guide frame')),
      SOCKET_EVENT_DEADLINE_MS,
    );
    socket.addEventListener('message', (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const payload = decodeFollowMessage(new Uint8Array(event.data));
      if (!payload) return;
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function expectNoFollow(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 250);
    socket.addEventListener('message', (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      if (decodeFollowMessage(new Uint8Array(event.data))) {
        clearTimeout(timer);
        reject(new Error('unexpected guide frame'));
      }
    });
  });
}

async function approveEditor(
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

describe('teacher guide broadcast over WebSocket', () => {
  it('accepts guide frames only from the owner and gives active state to a newcomer', async () => {
    const roomId = `guide-room-${crypto.randomUUID()}`;
    const owner = await bootstrapLocalSession(`guide-owner-${crypto.randomUUID()}`);
    const editor = await bootstrapLocalSession(`guide-editor-${crypto.randomUUID()}`);
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await approveEditor(owner, editor, roomId);

    const ownerSocket = await openGranted(owner, roomId);
    const editorSocket = await openGranted(editor, roomId);
    const viewport = { x: 120, y: -80, zoom: 1.5 };
    const received = nextFollow(editorSocket);
    ownerSocket.send(encodeFollowMessage({ active: true, viewport }));
    await expect(received).resolves.toEqual({ active: true, viewport });

    const forbidden = expectNoFollow(ownerSocket);
    editorSocket.send(encodeFollowMessage({ active: false }));
    await expect(forbidden).resolves.toBeUndefined();

    const newcomer = await openGranted(editor, roomId);
    await expect(nextFollow(newcomer)).resolves.toEqual({ active: true, viewport });

    const stopped = nextFollow(editorSocket);
    ownerSocket.close();
    await expect(stopped).resolves.toEqual({ active: false });

    editorSocket.close();
    newcomer.close();
  });
});
