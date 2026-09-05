import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { RoomDO } from './RoomDO';
import { encodeCallMessage, decodeCallMessage, type CallState } from '../lib/whiteboard/callMessage';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';
import { ROOM_SETTINGS_KEYS } from '../lib/whiteboard/requestSchemas';

/*
 * A separate file rather than the end of roomDO.workers.test.ts, for the same
 * reason roomViewport.workers.test.ts is separate: that file holds over 160
 * tests and sits near the V8 stack limit under @cloudflare/vitest-pool-workers
 * proxy wrapping. Appending these four tipped it over and produced
 * "RangeError: Maximum call stack size exceeded" in an unrelated presence test.
 */

function splitRoomWrite(body: Record<string, unknown>) {
  const settings: Record<string, unknown> = {};
  const scene: Record<string, unknown> = { elements: [] };
  for (const [key, value] of Object.entries(body)) {
    if ((ROOM_SETTINGS_KEYS as readonly string[]).includes(key)) settings[key] = value;
    else scene[key] = value;
  }
  return { scene, settings };
}

async function writeRoom(
  roomId: string,
  who: LocalAuthSession,
  body: Record<string, unknown> = {},
) {
  const { scene } = splitRoomWrite(body);
  return authenticatedFetch(`/api/whiteboard/room/${roomId}`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scene),
  });
}

describe('room call lifecycle', () => {
  function roomStub(roomId: string) {
    return env.ROOMS.get(env.ROOMS.idFromName(roomId)) as DurableObjectStub<RoomDO>;
  }

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

  /** Resolves with the first call frame this socket receives, or null after ms. */
  function nextCallState(ws: WebSocket, ms = 600): Promise<CallState | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      ws.addEventListener('message', (event: MessageEvent) => {
        const raw = event.data;
        if (!(raw instanceof ArrayBuffer)) return;
        const state = decodeCallMessage(new Uint8Array(raw));
        if (!state) return;
        clearTimeout(timer);
        resolve(state);
      });
    });
  }

  function startCall(ws: WebSocket, hostAccountId: string): void {
    ws.send(encodeCallMessage({ active: true, hostAccountId, startedAt: Date.now() }));
  }

  it('keeps the call running after the host disconnects', async () => {
    const owner = await bootstrapLocalSession('call-host-drop-owner');
    const peer = await bootstrapLocalSession('call-host-drop-peer');
    const roomId = 'call-host-drop-room';
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, peer, roomId);

    const hostWs = await connectGranted(owner, roomId);
    const peerWs = await connectGranted(peer, roomId);
    const peerSawStart = nextCallState(peerWs);
    startCall(hostWs, owner.accountId);
    expect(await peerSawStart).toMatchObject({ active: true });

    /*
     * The host refreshing the page looks exactly like this from the server:
     * the socket closes. It must not hang up on the peers, who are talking to
     * each other.
     */
    const peerSawEnd = nextCallState(peerWs);
    hostWs.close();
    expect(await peerSawEnd).toBeNull();

    // And someone arriving after the host left is still told there is a call.
    const late = await bootstrapLocalSession('call-host-drop-late');
    await grantEditor(owner, late, roomId);
    const lateWs = await connectGranted(late, roomId);
    expect(await nextCallState(lateWs)).toMatchObject({ active: true });

    peerWs.close();
    lateWs.close();
  });

  it('writes the call to durable storage, not just memory', async () => {
    const owner = await bootstrapLocalSession('call-durable-owner');
    const peer = await bootstrapLocalSession('call-durable-peer');
    const roomId = 'call-durable-room';
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, peer, roomId);

    const hostWs = await connectGranted(owner, roomId);
    const peerWs = await connectGranted(peer, roomId);
    const sawStart = nextCallState(peerWs);
    startCall(hostWs, owner.accountId);
    expect(await sawStart).toMatchObject({ active: true });

    /*
     * Asserted against storage rather than by evicting the object: this room
     * accepts hibernatable sockets, and evictDurableObject waits for a shutdown
     * that an open socket prevents, so the eviction path cannot be driven from
     * a test with a peer still connected. What matters is that the state is not
     * only in memory, and that is checkable directly.
     */
    const stored = await runInDurableObject(roomStub(roomId), (_instance, state) => (
      state.storage.get('call:active')
    ));
    expect(stored).toMatchObject({ active: true, hostAccountId: owner.accountId });

    hostWs.close();
    peerWs.close();
  });


  it('ends the call when the host ends it', async () => {
    const owner = await bootstrapLocalSession('call-end-owner');
    const peer = await bootstrapLocalSession('call-end-peer');
    const roomId = 'call-end-room';
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, peer, roomId);

    const hostWs = await connectGranted(owner, roomId);
    const peerWs = await connectGranted(peer, roomId);
    const sawStart = nextCallState(peerWs);
    startCall(hostWs, owner.accountId);
    expect(await sawStart).toMatchObject({ active: true });

    const sawEnd = nextCallState(peerWs);
    hostWs.send(encodeCallMessage({ active: false }));
    expect(await sawEnd).toEqual({ active: false });

    hostWs.close();
    peerWs.close();
  });

  it('does not let an admitted editor start a call', async () => {
    const owner = await bootstrapLocalSession('call-editor-owner');
    const editor = await bootstrapLocalSession('call-editor-editor');
    const other = await bootstrapLocalSession('call-editor-other');
    const roomId = 'call-editor-room';
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantEditor(owner, editor, roomId);
    await grantEditor(owner, other, roomId);

    const editorWs = await connectGranted(editor, roomId);
    const otherWs = await connectGranted(other, roomId);

    const otherSaw = nextCallState(otherWs);
    startCall(editorWs, editor.accountId);
    expect(await otherSaw).toBeNull();

    // And it left nothing behind for a late joiner to pick up either.
    const lateWs = await connectGranted(other, roomId);
    expect(await nextCallState(lateWs)).toBeNull();

    editorWs.close();
    otherWs.close();
    lateWs.close();
  });
});
