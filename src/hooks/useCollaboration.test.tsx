import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { useCollaboration } from './useCollaboration';
import * as collaborationModule from '@/lib/whiteboard/collaboration';
import * as providerStatusModule from '@/lib/whiteboard/providerStatus';
import { encodePresenceMessage, PRESENCE_MESSAGE_TYPE } from '@/lib/whiteboard/presenceMessage';
import { encodeFollowMessage, FOLLOW_MESSAGE_TYPE } from '@/lib/whiteboard/followMessage';
import { encodeCallMessage, CALL_MESSAGE_TYPE } from '@/lib/whiteboard/callMessage';
import { publishCursor } from '@/lib/whiteboard/cursorAwareness';
import type { CallCallback, WhiteboardProvider } from '@/lib/whiteboard/yWebsocketProvider';
import type { CallState } from '@/lib/whiteboard/callMessage';
import { DEFAULT_MAX_USERS } from '@/lib/plan/limits';
import { POLL_BASE_MS, POLL_GIVE_UP_MS, ROOM_POLL_MAX_MS } from '@/lib/whiteboard/pollBackoff';
import { VIEWPORT_SAVE_DEBOUNCE_MS } from '@/lib/whiteboard/viewportPersist';

describe('useCollaboration syncDegraded', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let changeHandler: ((type: string, data: unknown) => void) | null = null;
  let statusHandler: (() => void) | null = null;

  beforeEach(() => {
    changeHandler = null;
    statusHandler = null;

    vi.spyOn(collaborationModule, 'createCollaboration').mockImplementation((roomId, peerId, onPresence, onFollow) => {
      return {
        provider: {
          wsconnected: true,
          synced: true,
          on: (event: string, cb: () => void) => {
            if (event === 'status') statusHandler = cb;
          },
          off: () => {},
        } as any,
        doc: {
          getArray: () => ({ toArray: () => [] }),
          getMap: () => ({ get: () => undefined, set: () => {} }),
          on: () => {},
          off: () => {},
        } as any,
        elementsArray: [] as any,
        destroy: () => {},
        onChange: (cb: (type: string, data: unknown) => void) => {
          changeHandler = cb;
        },
        setLocalUserName: () => {},
        setLocalUserColor: () => {},
        setLocalCursor: () => {},
        sendFollowMessage: () => true,
      } as any;
    });

    fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/access')) {
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'granted', role: 'editor' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/presence')) {
        return Promise.resolve(
          new Response(JSON.stringify({ users: [], waitingPeers: [], isWaiting: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/room/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ elements: [], viewport: { x: 0, y: 0, zoom: 1 } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('exposes syncDegraded initialized to false', async () => {
    const { result } = renderHook(() => useCollaboration('room-test-1'));
    expect(result.current.syncDegraded).toBe(false);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('sets syncDegraded to true when presence heartbeat returns 500 error', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/access')) {
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'granted', role: 'editor' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/presence')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Internal Server Error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ elements: [], viewport: { x: 0, y: 0, zoom: 1 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    const { result } = renderHook(() => useCollaboration('room-test-2'));
    act(() => {
      result.current.setUserName('Alice');
    });

    await waitFor(() => {
      expect(result.current.syncDegraded).toBe(true);
    });
  });

  it('sets syncDegraded to true when connection-close event has code 1008 or 1009', async () => {
    const { result } = renderHook(() => useCollaboration('room-test-3'));
    act(() => {
      result.current.setUserName('Alice');
    });

    await waitFor(() => {
      expect(changeHandler).not.toBeNull();
    });

    act(() => {
      changeHandler?.('connection-close', { code: 1008 });
    });

    expect(result.current.syncDegraded).toBe(true);
    // A close the client reconnects from is not a lost connection, and the
    // degraded notice only renders while the connection is not declared lost.
    expect(result.current.connectionLost).toBe(false);
  });

  it('resets syncDegraded to false when presence succeeds (200 ok) and socket is connected', async () => {
    // Start with 500 error
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/access')) {
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'granted', role: 'editor' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/presence')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Internal Server Error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ elements: [], viewport: { x: 0, y: 0, zoom: 1 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    const { result } = renderHook(() => useCollaboration('room-test-4'));
    act(() => {
      result.current.setUserName('Alice');
    });

    await waitFor(() => {
      expect(result.current.syncDegraded).toBe(true);
    });

    // Now presence recovers to 200 OK and socket is connected
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/presence')) {
        return Promise.resolve(
          new Response(JSON.stringify({ users: [], waitingPeers: [], isWaiting: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ elements: [], viewport: { x: 0, y: 0, zoom: 1 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    vi.spyOn(providerStatusModule, 'isYjsProviderConnected').mockReturnValue(true);

    await act(async () => {
      await result.current.reloadPresence();
    });

    // Or trigger status event / onVisible
    act(() => {
      statusHandler?.();
    });

    await waitFor(() => {
      expect(result.current.syncDegraded).toBe(false);
    });
  });
});

type RouteHandler = (url: string, init: RequestInit) => Response | Promise<Response>;
type FetchCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emitProvider(provider: WhiteboardProvider | null) {
  return provider as unknown as {
    emit: (event: string, args: unknown[]) => void;
    disconnect?: () => void;
    wsconnected?: boolean;
    synced?: boolean;
    ws?: unknown;
  };
}

function deliverFrame(provider: WhiteboardProvider | null, type: number, frame: Uint8Array) {
  const decoder = decoding.createDecoder(frame);
  expect(decoding.readVarUint(decoder)).toBe(type);
  provider?.messageHandlers?.[type]?.(encoding.createEncoder(), decoder);
}

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  });
}

describe('useCollaboration with a real collaboration document', () => {
  let calls: FetchCall[];
  let route: RouteHandler;

  beforeEach(() => {
    calls = [];
    route = (url, init) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'creator' });
      if (url.includes('/presence')) {
        if (init.method === 'DELETE') return jsonResponse({});
        return jsonResponse({ users: [], waitingPeers: [], isWaiting: false });
      }
      if (url.includes('/waiting')) return jsonResponse({});
      if (url.includes('/room/')) {
        return jsonResponse({
          elements: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          updated_at: 1,
          maxUsers: 5,
          name: 'Room',
          hostPeerId: 'peer-host',
        });
      }
      return jsonResponse({}, 404);
    };
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const requestInit = init ?? {};
      calls.push({ url, init: requestInit });
      return Promise.resolve().then(() => route(url, requestInit));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setVisibility('visible');
  });

  async function renderJoined(
    roomId: string,
    callLiveRef?: { readonly current: boolean },
    onCall?: CallCallback,
  ) {
    const rendered = renderHook(() => useCollaboration(roomId, callLiveRef, onCall));
    act(() => {
      rendered.result.current.setUserName('Ada');
    });
    await waitFor(() => expect(rendered.result.current.collaboration).not.toBeNull());
    await waitFor(() => expect(rendered.result.current.provider).not.toBeNull());
    return rendered;
  }

  it('exposes no document or provider before joining the room', async () => {
    const { result } = renderHook(() => useCollaboration('real-before-join'));
    expect(result.current.provider).toBeNull();
    expect(result.current.yDoc).toBeNull();
    expect(result.current.yElementsArray).toBeNull();
    expect(result.current.collaboration).toBeNull();

    act(() => {
      result.current.setCursor(1, 2);
    });
    expect(result.current.sendFollowMessage({ active: false })).toBe(false);
    expect(result.current.sendCallMessage({ active: false })).toBe(false);

    await waitFor(() => expect(result.current.roomName).toBe('Room'));
  });

  it('applies shared document element and viewport changes', async () => {
    const { result } = await renderJoined('real-doc');
    const first = new Y.Map();
    first.set('id', 'el-1');

    act(() => {
      result.current.yElementsArray?.push([first]);
    });
    await waitFor(() => expect(result.current.elements).toEqual([{ id: 'el-1' }]));

    const duplicate = new Y.Map();
    duplicate.set('id', 'el-1');
    act(() => {
      result.current.yElementsArray?.push([duplicate]);
    });
    expect(result.current.elements).toEqual([{ id: 'el-1' }]);

    act(() => {
      result.current.collaboration?.viewportMap.set('x', 12);
    });
    await waitFor(() => expect(result.current.viewport.x).toBe(12));
  });

  it('draws remote cursors from awareness and filters the local peer', async () => {
    const { result } = await renderJoined('real-cursors');
    const provider = result.current.provider as WhiteboardProvider;
    const awareness = provider.awareness!;

    act(() => {
      result.current.setCursor(10, 20, 'down');
    });
    const remote = new Awareness(new Y.Doc());
    publishCursor(remote, {
      peerId: 'peer-remote',
      userName: 'Bea',
      color: '#e74c3c',
      x: 1,
      y: 2,
      button: 'up',
    });
    act(() => {
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remote, [remote.clientID]), 'test');
    });

    await waitFor(() => expect(result.current.cursors.map((c) => c.peerId)).toEqual(['peer-remote']));
    expect(result.current.users.some((u) => u.peerId === 'peer-remote')).toBe(false);
    remote.destroy();
  });

  it('tracks provider status, sync state, and reconnecting close codes', async () => {
    const { result } = await renderJoined('real-status');
    const provider = emitProvider(result.current.provider);

    act(() => {
      provider.wsconnected = true;
      provider.emit('status', [{ status: 'connected' }]);
    });
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(result.current.isConnected).toBe(true);
    expect(result.current.isSynced).toBe(true);

    act(() => {
      provider.emit('synced', [true]);
    });
    await waitFor(() => expect(result.current.isSynced).toBe(true));

    act(() => {
      provider.emit('synced', [{ synced: false }]);
    });
    await waitFor(() => expect(result.current.status).toBe('connecting'));

    act(() => {
      provider.emit('connection-close', [{ code: 1009 }]);
    });
    await waitFor(() => expect(result.current.syncDegraded).toBe(true));
    expect(result.current.connectionLost).toBe(false);
  });

  it('applies pushed presence payloads and adopts the issued peer id', async () => {
    const { result } = await renderJoined('real-presence');
    const provider = result.current.provider as WhiteboardProvider;

    act(() => {
      result.current.setCursor(4, 5, 'down');
    });
    act(() => {
      deliverFrame(provider, PRESENCE_MESSAGE_TYPE, encodePresenceMessage({
        hostPeerId: 'peer-host-2',
        users: [{ peerId: 'peer-host-2', userName: 'Host', color: '#111111', isHost: true }],
        waitingPeers: [{ peerId: 'peer-wait', userName: 'Wait', color: '#222222', accountId: 'acct-1' }],
        peerId: 'user-issued-1',
      }));
    });

    await waitFor(() => expect(result.current.hostPeerId).toBe('peer-host-2'));
    expect(result.current.users).toEqual([
      { peerId: 'peer-host-2', userName: 'Host', color: '#111111', isHost: true },
    ]);
    expect(result.current.waitingPeers).toEqual([
      {
        peerId: 'peer-wait',
        accountId: 'acct-1',
        userName: 'Wait',
        color: '#222222',
        isHost: false,
        isWaiting: true,
      },
    ]);
    await waitFor(() => expect(result.current.localPeerId).toBe('user-issued-1'));
    const localState = provider.awareness?.getLocalState() as {
      cursor?: { peerId?: string; x?: number; y?: number; button?: string };
    } | null;
    expect(localState?.cursor).toMatchObject({
      peerId: 'user-issued-1',
      x: 4,
      y: 5,
      button: 'up',
    });

    act(() => {
      deliverFrame(provider, PRESENCE_MESSAGE_TYPE, encodePresenceMessage({ peerId: 'user-issued-1' }));
    });
    expect(result.current.localPeerId).toBe('user-issued-1');

    act(() => {
      deliverFrame(provider, PRESENCE_MESSAGE_TYPE, encodePresenceMessage({ isWaiting: false }));
    });
    act(() => {
      deliverFrame(provider, PRESENCE_MESSAGE_TYPE, encodePresenceMessage({ isWaiting: true }));
    });
    await waitFor(() => expect(result.current.wasSuspended).toBe(true));

    act(() => {
      deliverFrame(provider, PRESENCE_MESSAGE_TYPE, encodePresenceMessage({ isKicked: true }));
    });
    await waitFor(() => expect(result.current.wasKicked).toBe(true));
    expect(result.current.users).toEqual([]);
  });

  it('delivers follow and call frames to hook state', async () => {
    const { result } = await renderJoined('real-follow-call');
    const provider = result.current.provider as WhiteboardProvider;

    act(() => {
      deliverFrame(provider, FOLLOW_MESSAGE_TYPE, encodeFollowMessage({
        active: true,
        viewport: { x: 3, y: 4, zoom: 2 },
      }));
    });
    await waitFor(() => expect(result.current.guideMessage).toEqual({
      active: true,
      viewport: { x: 3, y: 4, zoom: 2 },
    }));

    act(() => {
      deliverFrame(provider, CALL_MESSAGE_TYPE, encodeCallMessage({
        active: true,
        hostAccountId: 'acct-1',
        startedAt: 123,
      }));
    });
    await waitFor(() => expect(result.current.remoteCallActive).toBe(true));

    act(() => {
      deliverFrame(provider, CALL_MESSAGE_TYPE, encodeCallMessage({ active: false }));
    });
    await waitFor(() => expect(result.current.remoteCallActive).toBe(false));
  });

  it('routes call frames to the onCall callback when provided', async () => {
    const seen: CallState[] = [];
    const onCall: CallCallback = (state) => {
      seen.push(state);
    };
    const { result } = await renderJoined('real-oncall', undefined, onCall);
    const provider = result.current.provider as WhiteboardProvider;

    act(() => {
      deliverFrame(provider, CALL_MESSAGE_TYPE, encodeCallMessage({ active: false }));
    });
    await waitFor(() => expect(seen).toEqual([{ active: false }]));
  });

  it('loads a new room when the room read is missing', async () => {
    route = (url) => (url.includes('/access') ? jsonResponse({}) : jsonResponse({}, 404));

    const { result } = renderHook(() => useCollaboration('real-new-room'));
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(result.current.isConnected).toBe(true);
    expect(result.current.isSynced).toBe(true);
    expect(result.current.isRoomOwner).toBe(false);
    expect(result.current.roomName).toBeNull();
    expect(result.current.maxUsers).toBe(DEFAULT_MAX_USERS);
  });

  it('tolerates a room server error and a sparse room payload', async () => {
    route = (url) => (url.includes('/access') ? jsonResponse({ status: 'approved', role: 'peer' }) : jsonResponse({}, 500));

    const { result } = renderHook(() => useCollaboration('real-room-error'));
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(result.current.roomName).toBeNull();

    route = (url) => (url.includes('/access') ? jsonResponse({ status: 'approved', role: 'peer' }) : jsonResponse({}));
    const second = renderHook(() => useCollaboration('real-room-sparse'));
    await waitFor(() => expect(second.result.current.status).toBe('connected'));
    expect(second.result.current.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(second.result.current.maxUsers).toBe(DEFAULT_MAX_USERS);
    expect(second.result.current.roomName).toBeNull();
    expect(second.result.current.elements).toEqual([]);
  });

  it('records room load failures for both error and non-error reasons', async () => {
    route = () => {
      throw new Error('network down');
    };
    const { result } = renderHook(() => useCollaboration('real-room-catch'));
    await waitFor(() => expect(result.current.error).toBe('network down'));
    expect(result.current.status).toBe('connected');

    route = () => Promise.reject('down');
    const second = renderHook(() => useCollaboration('real-room-catch-unknown'));
    await waitFor(() => expect(second.result.current.error).toBe('Failed to load room'));
  });

  it('ignores room responses and failures that arrive after unmount', async () => {
    let releaseRoom: (() => void) | null = null;
    const roomGate = new Promise<void>((resolve) => {
      releaseRoom = resolve;
    });
    route = () => roomGate.then(() => jsonResponse({ elements: [], updated_at: 1 }));
    const first = renderHook(() => useCollaboration('real-unmount'));
    first.unmount();
    releaseRoom!();
    await act(async () => {
      await roomGate;
    });

    let failRoom: ((reason?: unknown) => void) | null = null;
    route = () => new Promise<Response>((_resolve, reject) => {
      failRoom = reject;
    });
    const second = renderHook(() => useCollaboration('real-unmount-reject'));
    await act(async () => {});
    const rejectRoom = failRoom as unknown as (reason?: unknown) => void;
    second.unmount();
    rejectRoom(new Error('late'));
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('throttles cursor publishing and flushes the newest position', async () => {
    const { result } = await renderJoined('real-cursor-throttle');
    const provider = result.current.provider as WhiteboardProvider;
    const readCursor = () => (provider.awareness?.getLocalState() as {
      cursor?: { x?: number; button?: string };
    } | null)?.cursor;

    act(() => {
      result.current.setCursor(1, 1);
    });
    expect(readCursor()?.x).toBe(1);

    act(() => {
      result.current.setCursor(2, 2, 'down');
    });
    expect(readCursor()?.x).toBe(1);

    act(() => {
      result.current.setCursor(3, 3);
    });
    await waitFor(() => expect(readCursor()?.x).toBe(3));
    expect(readCursor()?.button).toBe('up');
  });

  it('drops a flushed cursor after the peer left or the collaboration ended', async () => {
    const first = await renderJoined('real-cursor-leave');
    const firstProvider = first.result.current.provider as WhiteboardProvider;
    act(() => {
      first.result.current.setCursor(1, 1);
    });
    act(() => {
      first.result.current.setCursor(9, 9);
    });
    await act(async () => {
      await first.result.current.leaveWaitingRoom();
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((firstProvider.awareness?.getLocalState() as { cursor?: unknown } | null)?.cursor ?? null).toBeNull();

    const second = await renderJoined('real-cursor-ended');
    const secondProvider = second.result.current.provider as WhiteboardProvider;
    act(() => {
      second.result.current.setCursor(1, 1);
    });
    act(() => {
      second.result.current.setCursor(8, 8);
    });
    act(() => {
      deliverFrame(secondProvider, PRESENCE_MESSAGE_TYPE, encodePresenceMessage({ isWaiting: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(secondProvider.awareness?.getLocalState()).toBeNull();
  });

  it('clears a pending cursor timer on unmount', async () => {
    const { result, unmount } = await renderJoined('real-cursor-unmount');
    act(() => {
      result.current.setCursor(1, 1);
    });
    act(() => {
      result.current.setCursor(2, 2);
    });
    unmount();
  });

  it('reloads presence, waiting peers, and suspension state', async () => {
    const { result } = await renderJoined('real-reload');
    emitProvider(result.current.provider).wsconnected = true;

    route = () => jsonResponse({});
    await act(async () => {
      await result.current.reloadPresence();
    });

    route = () => jsonResponse({
      users: [{ peerId: 'p1', userName: 'P', color: '#123456', isHost: true }],
      waitingPeers: [{ peerId: 'w1', userName: 'W', color: '#654321', accountId: 'acct-1' }],
      isWaiting: true,
    });
    await act(async () => {
      await result.current.reloadPresence();
    });
    expect(result.current.users).toEqual([
      { peerId: 'p1', userName: 'P', color: '#123456', isHost: true },
    ]);
    expect(result.current.waitingPeers).toEqual([
      {
        peerId: 'w1',
        accountId: 'acct-1',
        userName: 'W',
        color: '#654321',
        isHost: false,
        isWaiting: true,
      },
    ]);
    await waitFor(() => expect(result.current.wasSuspended).toBe(true));

    route = () => jsonResponse({}, 500);
    await act(async () => {
      await result.current.reloadPresence();
    });

    route = () => {
      throw new Error('down');
    };
    await act(async () => {
      await result.current.reloadPresence();
    });
  });

  it('posts moderation actions with and without account ids and records failures', async () => {
    const { result } = await renderJoined('real-moderation');
    let failure: (body: Record<string, unknown>) => boolean = () => false;
    route = (_url, init) => {
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (failure(body)) return jsonResponse({}, 500);
      return jsonResponse({});
    };

    await act(async () => {
      expect(await result.current.approvePeer('p1', 'acct-1')).toBe(true);
    });
    expect(result.current.moderationError).toBeNull();

    await act(async () => {
      expect(await result.current.approvePeer('p2')).toBe(true);
    });

    failure = (body) => body.action === 'approve';
    await act(async () => {
      expect(await result.current.approvePeer('p3')).toBe(false);
    });
    expect(result.current.moderationError).toBe('Could not let that person in. Please try again.');

    await act(async () => {
      expect(await result.current.rejectPeer('p4', 'acct-1')).toBe(true);
    });
    failure = (body) => body.action === 'reject';
    await act(async () => {
      expect(await result.current.rejectPeer('p5')).toBe(false);
    });
    expect(result.current.moderationError).toBe('Could not decline that person. Please try again.');

    failure = () => false;
    await act(async () => {
      expect(await result.current.kickPeer('p6', 'acct-1')).toBe(true);
    });
    failure = (body) => body.action === 'kick';
    await act(async () => {
      expect(await result.current.kickPeer('p7')).toBe(false);
    });
    expect(result.current.moderationError).toBe('Could not remove that person. Please try again.');

    failure = () => false;
    await act(async () => {
      expect(await result.current.sendToWaitingRoom('p8', 'acct-1')).toBe(true);
    });
    failure = (body) => body.action === 'suspend';
    await act(async () => {
      expect(await result.current.sendToWaitingRoom('p9')).toBe(false);
    });
    expect(result.current.moderationError).toBe('Could not move that person to the waiting room.');

    failure = () => false;
    await act(async () => {
      expect(await result.current.setHandRaised(true)).toBe(true);
    });
    failure = (body) => body.action === 'lower-hand';
    await act(async () => {
      expect(await result.current.setHandRaised(false)).toBe(false);
    });

    route = () => {
      throw new Error('down');
    };
    await act(async () => {
      expect(await result.current.approvePeer('p10')).toBe(false);
    });
    await act(async () => {
      expect(await result.current.rejectPeer('p11')).toBe(false);
    });
    await act(async () => {
      expect(await result.current.kickPeer('p12')).toBe(false);
    });
    await act(async () => {
      expect(await result.current.sendToWaitingRoom('p13')).toBe(false);
    });
    await act(async () => {
      expect(await result.current.setHandRaised(true)).toBe(false);
    });
  });

  it('marks a peer rejected while queued and kicked once admitted', async () => {
    let presenceStatus = 403;
    route = (url, init) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'creator' });
      if (url.includes('/presence') && init.method !== 'DELETE') {
        return jsonResponse(presenceStatus === 200 ? { isWaiting: false } : {}, presenceStatus);
      }
      if (url.includes('/room/')) return jsonResponse({ elements: [], updated_at: 1 });
      return jsonResponse({});
    };

    const first = renderHook(() => useCollaboration('real-rejected-queued'));
    act(() => {
      first.result.current.setUserName('Ada');
    });
    await waitFor(() => expect(first.result.current.wasRejected).toBe(true));
    expect(first.result.current.isWaiting).toBe(false);

    presenceStatus = 200;
    const second = await renderJoined('real-kicked-admitted');
    await waitFor(() => expect(second.result.current.users.length).toBe(1));
    presenceStatus = 403;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(second.result.current.wasKicked).toBe(true));
  });

  it('flags a full queue and a waiting heartbeat', async () => {
    let presenceStatus = 409;
    route = (url, init) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'creator' });
      if (url.includes('/presence') && init.method !== 'DELETE') {
        return jsonResponse({}, presenceStatus);
      }
      if (url.includes('/room/')) return jsonResponse({ elements: [], updated_at: 1 });
      return jsonResponse({});
    };

    const { result } = renderHook(() => useCollaboration('real-queue-full'));
    act(() => {
      result.current.setUserName('Ada');
    });
    await waitFor(() => expect(result.current.queueFull).toBe(true));
    expect(result.current.isWaiting).toBe(true);
    expect(result.current.waitingPeers).toEqual([]);

    presenceStatus = 404;
    await act(async () => {
      await result.current.reloadPresence();
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(result.current.queueFull).toBe(false));
    expect(result.current.isWaiting).toBe(true);
  });

  it('degrades and gives up after three presence errors, then recovers', async () => {
    let presenceStatus = 500;
    route = (url, init) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'creator' });
      if (url.includes('/presence') && init.method !== 'DELETE') {
        return jsonResponse({}, presenceStatus);
      }
      if (url.includes('/room/')) return jsonResponse({ elements: [], updated_at: 1 });
      return jsonResponse({});
    };

    const { result } = await renderJoined('real-presence-errors');
    await waitFor(() => expect(result.current.syncDegraded).toBe(true));
    expect(result.current.connectionLost).toBe(false);

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(result.current.connectionLost).toBe(true));

    presenceStatus = 200;
    emitProvider(result.current.provider).wsconnected = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(result.current.syncDegraded).toBe(false));
  });

  it('marks an access rejection and ignores an access read failure', async () => {
    route = (url) => {
      if (url.includes('/access')) return jsonResponse({ status: 'rejected' });
      if (url.includes('/room/')) return jsonResponse({}, 404);
      return jsonResponse({});
    };
    const first = renderHook(() => useCollaboration('real-access-rejected'));
    await waitFor(() => expect(first.result.current.status).toBe('connected'));
    expect(first.result.current.wasRejected).toBe(true);
    expect(first.result.current.isRoomOwner).toBe(false);

    route = (url) => (url.includes('/access') ? jsonResponse({}, 401) : jsonResponse({}, 404));
    const second = renderHook(() => useCollaboration('real-access-unavailable'));
    await waitFor(() => expect(second.result.current.status).toBe('connected'));
    expect(second.result.current.wasRejected).toBe(false);
  });

  it('adopts an issued peer id before any cursor exists and after the collaboration ends', async () => {
    route = (url, init) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'creator' });
      if (url.includes('/presence') && init.method !== 'DELETE') return jsonResponse({});
      if (url.includes('/room/')) return jsonResponse({ elements: [], updated_at: 1 });
      return jsonResponse({});
    };
    const { result } = await renderJoined('real-adopt-empty');
    const provider = result.current.provider as WhiteboardProvider;

    act(() => {
      deliverFrame(provider, PRESENCE_MESSAGE_TYPE, encodePresenceMessage({ peerId: 'user-issued-empty' }));
    });
    await waitFor(() => expect(result.current.localPeerId).toBe('user-issued-empty'));
    const state = provider.awareness?.getLocalState() as {
      cursor?: { peerId?: string; x?: number; y?: number };
    } | null;
    expect(state?.cursor).toMatchObject({ peerId: 'user-issued-empty', x: 0, y: 0 });

    act(() => {
      deliverFrame(provider, PRESENCE_MESSAGE_TYPE, encodePresenceMessage({ isWaiting: true }));
    });
    await waitFor(() => expect(result.current.isWaiting).toBe(true));
    expect(result.current.wasSuspended).toBe(false);
    expect(result.current.collaboration).toBeNull();

    act(() => {
      deliverFrame(provider, PRESENCE_MESSAGE_TYPE, encodePresenceMessage({ peerId: 'user-issued-after' }));
    });
    await waitFor(() => expect(result.current.localPeerId).toBe('user-issued-after'));
  });

  it('does not mark suspension when a waiting reload arrives before admission', async () => {
    route = (url, init) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'creator' });
      if (url.includes('/presence') && init.method !== 'DELETE') return jsonResponse({});
      if (url.includes('/room/')) return jsonResponse({ elements: [], updated_at: 1 });
      return jsonResponse({});
    };
    const { result } = await renderJoined('real-reload-waiting');

    route = () => jsonResponse({ isWaiting: true });
    await act(async () => {
      await result.current.reloadPresence();
    });
    expect(result.current.isWaiting).toBe(true);
    expect(result.current.wasSuspended).toBe(false);
  });

  it('publishes a room snapshot into the shared document once joined', async () => {
    route = (url, init) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'creator' });
      if (url.includes('/presence') && init.method !== 'DELETE') {
        return jsonResponse({ users: [], waitingPeers: [], isWaiting: false });
      }
      if (url.includes('/room/')) {
        return jsonResponse({
          elements: [{ id: 'seed-1', type: 'rectangle' }],
          viewport: { x: 0, y: 0, zoom: 1 },
          updated_at: 5,
        });
      }
      return jsonResponse({});
    };

    const { result } = renderHook(() => useCollaboration('real-pending-publish'));
    await waitFor(() => expect(result.current.status).toBe('connected'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(result.current.yElementsArray).toBeNull();

    act(() => {
      result.current.setUserName('Ada');
    });
    await waitFor(() => {
      expect(result.current.yElementsArray?.toArray().map((map) => map.get('id'))).toContain('seed-1');
    }, { timeout: 2000 });
  });

  it('stores the host viewport on a debounce and skips non-host writes', async () => {
    const host = await renderJoined('real-viewport-host');
    const roomPosts = () =>
      calls.filter((call) =>
        call.url.includes('/room/')
        && !call.url.includes('/presence')
        && call.init.method === 'POST',
      );

    vi.useFakeTimers();
    try {
      act(() => {
        host.result.current.storeViewport({ x: 5, y: 6, zoom: 2 });
        host.result.current.storeViewport({ x: 7, y: 8, zoom: 3 });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(VIEWPORT_SAVE_DEBOUNCE_MS + 10);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(roomPosts().length).toBe(1);
    expect(JSON.parse(String(roomPosts()[0].init.body))).toEqual({
      viewport: { x: 7, y: 8, zoom: 3 },
    });

    route = (url, init) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'peer' });
      if (url.includes('/presence') && init.method !== 'DELETE') {
        return jsonResponse({ users: [], waitingPeers: [], isWaiting: false });
      }
      if (url.includes('/room/')) {
        return jsonResponse({ elements: [], viewport: { x: 0, y: 0, zoom: 1 }, updated_at: 1 });
      }
      return jsonResponse({});
    };
    const beforeNonHost = roomPosts().length;
    const nonHost = await renderJoined('real-viewport-nonhost');
    vi.useFakeTimers();
    try {
      act(() => {
        nonHost.result.current.storeViewport({ x: 1, y: 1, zoom: 1 });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(VIEWPORT_SAVE_DEBOUNCE_MS + 10);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(roomPosts().length).toBe(beforeNonHost);
  });

  it('survives a failed viewport write', async () => {
    route = (url, init) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'creator' });
      if (url.includes('/presence') && init.method !== 'DELETE') {
        return jsonResponse({ users: [], waitingPeers: [], isWaiting: false });
      }
      if (url.includes('/room/') && init.method === 'POST') throw new Error('write failed');
      if (url.includes('/room/')) {
        return jsonResponse({ elements: [], viewport: { x: 0, y: 0, zoom: 1 }, updated_at: 1 });
      }
      return jsonResponse({});
    };
    const { result } = await renderJoined('real-viewport-write-fail');

    vi.useFakeTimers();
    try {
      act(() => {
        result.current.storeViewport({ x: 8, y: 8, zoom: 2 });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(VIEWPORT_SAVE_DEBOUNCE_MS + 10);
      });
      await act(async () => {
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }
    expect(calls.filter((call) =>
      call.url.includes('/room/')
      && !call.url.includes('/presence')
      && call.init.method === 'POST',
    ).length).toBe(1);
  });

  it('pauses polling while hidden and resumes on return', async () => {
    const { result } = await renderJoined('real-visibility');
    emitProvider(result.current.provider).wsconnected = true;
    const presencePosts = () =>
      calls.filter((call) => call.url.includes('/presence') && call.init.method === 'POST').length;

    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hiddenCount = presencePosts();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(presencePosts()).toBe(hiddenCount);

    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(presencePosts()).toBeGreaterThan(hiddenCount));
  });

  it('merges newer room fallback snapshots and skips them while synced', async () => {
    let roomReads = 0;
    route = (url, init) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'creator' });
      if (url.includes('/presence') && init.method !== 'DELETE') {
        return jsonResponse({ users: [], waitingPeers: [], isWaiting: false });
      }
      if (url.includes('/room/')) {
        roomReads += 1;
        if (roomReads === 1) {
          return jsonResponse({ elements: [], viewport: { x: 0, y: 0, zoom: 1 }, updated_at: 100 });
        }
        return jsonResponse({ elements: [], viewport: { x: 9, y: 9, zoom: 2 }, updated_at: 200 });
      }
      return jsonResponse({});
    };

    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCollaboration('real-room-poll'));
      act(() => {
        result.current.setUserName('Ada');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_BASE_MS + 50);
      });
      expect(result.current.viewport).toEqual({ x: 9, y: 9, zoom: 2 });

      const provider = emitProvider(result.current.provider);
      provider.disconnect?.();
      provider.ws = null;
      provider.wsconnected = true;
      provider.synced = true;
      const readsWhileSynced = roomReads;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_BASE_MS + 50);
      });
      expect(roomReads).toBe(readsWhileSynced);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tolerates room poll errors and missing poll fields', async () => {
    let roomReads = 0;
    let failPolls = false;
    route = (url, init) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'creator' });
      if (url.includes('/presence') && init.method !== 'DELETE') {
        return jsonResponse({ users: [], waitingPeers: [], isWaiting: false });
      }
      if (url.includes('/room/')) {
        roomReads += 1;
        if (failPolls) return jsonResponse({}, 500);
        if (roomReads === 1) {
          return jsonResponse({ elements: [], viewport: { x: 0, y: 0, zoom: 1 }, updated_at: 100 });
        }
        return jsonResponse({ updated_at: 200 });
      }
      return jsonResponse({});
    };

    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCollaboration('real-room-poll-fields'));
      act(() => {
        result.current.setUserName('Ada');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_BASE_MS + 50);
      });
      expect(result.current.viewport).toEqual({ x: 0, y: 0, zoom: 1 });

      failPolls = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROOM_POLL_MAX_MS);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a room poll response that arrives after unmount', async () => {
    let releasePoll: (() => void) | null = null;
    let roomReads = 0;
    route = (url, init) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'creator' });
      if (url.includes('/presence') && init.method !== 'DELETE') {
        return jsonResponse({ users: [], waitingPeers: [], isWaiting: false });
      }
      if (url.includes('/room/')) {
        roomReads += 1;
        if (roomReads === 1) {
          return jsonResponse({ elements: [], viewport: { x: 0, y: 0, zoom: 1 }, updated_at: 1 });
        }
        return new Promise<Response>((resolve) => {
          releasePoll = () => resolve(jsonResponse({ elements: [], updated_at: 2 }));
        });
      }
      return jsonResponse({});
    };

    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useCollaboration('real-poll-unmount'));
      act(() => {
        result.current.setUserName('Ada');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_BASE_MS + 50);
      });
      const release = releasePoll as unknown as () => void;
      unmount();
      await act(async () => {
        release();
        await vi.advanceTimersByTimeAsync(10);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a presence poll that resumes after unmount', async () => {
    let releasePresence: (() => void) | null = null;
    let presencePosts = 0;
    route = (url, init) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'creator' });
      if (url.includes('/presence') && init.method !== 'DELETE') {
        presencePosts += 1;
        if (presencePosts === 1) {
          return jsonResponse({ users: [], waitingPeers: [], isWaiting: false });
        }
        return new Promise<Response>((resolve) => {
          releasePresence = () =>
            resolve(jsonResponse({ users: [], waitingPeers: [], isWaiting: false }));
        });
      }
      if (url.includes('/room/')) {
        return jsonResponse({ elements: [], viewport: { x: 0, y: 0, zoom: 1 }, updated_at: 1 });
      }
      return jsonResponse({});
    };

    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useCollaboration('real-presence-unmount'));
      act(() => {
        result.current.setUserName('Ada');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_BASE_MS + 50);
      });
      const release = releasePresence as unknown as () => void;
      unmount();
      await act(async () => {
        release();
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates collaboration when the pending user name is empty', async () => {
    let releaseRoom: (() => void) | null = null;
    const roomGate = new Promise<void>((resolve) => {
      releaseRoom = resolve;
    });
    route = (url) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'creator' });
      if (url.includes('/room/')) return roomGate.then(() => jsonResponse({ elements: [], updated_at: 1 }));
      return jsonResponse({});
    };

    const { result } = renderHook(() => useCollaboration('real-empty-name'));
    act(() => {
      result.current.setUserName('');
    });
    releaseRoom!();
    await waitFor(() => expect(result.current.collaboration).not.toBeNull());
    expect(result.current.provider).not.toBeNull();
  });

  it('publishes nothing when a cursor flush lands after teardown', async () => {
    route = (url, init) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'creator' });
      if (url.includes('/presence') && init.method !== 'DELETE') return jsonResponse({});
      if (url.includes('/room/')) return jsonResponse({ elements: [], updated_at: 1 });
      return jsonResponse({});
    };

    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCollaboration('real-cursor-teardown'));
      act(() => {
        result.current.setUserName('Ada');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      act(() => {
        result.current.setCursor(1, 1);
        result.current.setCursor(2, 2);
      });
      const provider = result.current.provider as WhiteboardProvider;
      act(() => {
        deliverFrame(provider, PRESENCE_MESSAGE_TYPE, encodePresenceMessage({ isWaiting: true }));
      });
      expect(result.current.collaboration).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('declares connection loss after the disconnected window', async () => {
    route = (url, init) => {
      if (url.includes('/access')) return jsonResponse({ status: 'approved', role: 'creator' });
      if (url.includes('/presence') && init.method !== 'DELETE') {
        return jsonResponse({ users: [], waitingPeers: [], isWaiting: false });
      }
      if (url.includes('/room/')) {
        return jsonResponse({ elements: [], viewport: { x: 0, y: 0, zoom: 1 }, updated_at: 1 });
      }
      return jsonResponse({});
    };

    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCollaboration('real-give-up'));
      act(() => {
        result.current.setUserName('Ada');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_BASE_MS + 50);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_GIVE_UP_MS + ROOM_POLL_MAX_MS);
      });
      expect(result.current.connectionLost).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
