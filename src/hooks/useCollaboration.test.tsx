import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCollaboration } from './useCollaboration';
import * as collaborationModule from '@/lib/whiteboard/collaboration';
import * as providerStatusModule from '@/lib/whiteboard/providerStatus';

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
