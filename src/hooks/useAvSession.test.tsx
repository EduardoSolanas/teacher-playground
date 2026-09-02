import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useAvSession } from './useAvSession';
import { LiveKitProvider } from '@/lib/av/livekitProvider';

/*
 * A room does not take the camera until somebody asks it to.
 *
 * The gate is one boolean in RoomClient, and the cost of getting it wrong is
 * not a broken render: it is a recording indicator lighting up for a teacher
 * who only opened a whiteboard. That deserves a test of its own rather than a
 * reading of the call site.
 */

const fetchMock = vi.fn();

function tokenRequests(): string[] {
  return fetchMock.mock.calls
    .map(([input]) => (typeof input === 'string' ? input : String(input)))
    .filter((url) => url.includes('/api/av/token'));
}

function muteRequests(): ReadonlyArray<readonly [string, RequestInit | undefined]> {
  return fetchMock.mock.calls
    .map(([input, init]) => [typeof input === 'string' ? input : String(input), init] as const)
    .filter(([url]) => url.includes('/api/av/mute'));
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ error: 'LiveKit is not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const options = {
  roomId: 'room-1',
  identity: 'peer-1',
  displayName: 'Teacher',
};

describe('useAvSession', () => {
  it('asks for no token while the call has not been asked for', async () => {
    // Disabled is the state a room sits in for the whole of a lesson that
    // never calls anybody. Nothing may be requested, and no device touched.
    const { result } = renderHook(() => useAvSession({ ...options, enabled: false }));

    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(tokenRequests()).toEqual([]);
  });

  it('asks for a token once the call is wanted', async () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAvSession({ ...options, enabled }),
      { initialProps: { enabled: false } },
    );
    expect(tokenRequests()).toEqual([]);

    rerender({ enabled: true });
    await waitFor(() => expect(tokenRequests()).toHaveLength(1));
    expect(tokenRequests()[0]).toContain('roomId=room-1');
  });

  it('stops asking again when the call is ended', async () => {
    // Ending a call must not leave a session that quietly re-fetches: the
    // point of the button is that nothing runs until it is pressed again.
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAvSession({ ...options, enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(tokenRequests()).toHaveLength(1));

    rerender({ enabled: false });
    const after = tokenRequests().length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tokenRequests()).toHaveLength(after);
  });

  it('waits for an identity even when the call is wanted', async () => {
    // The identity is the peer id, which arrives with the room. Asking before
    // it does would mint a token against nobody.
    renderHook(() => useAvSession({ ...options, identity: '', enabled: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tokenRequests()).toEqual([]);
  });

  it('sends host mute to the server endpoint for the current room', async () => {
    const { result } = renderHook(() => useAvSession({ ...options, enabled: false }));

    await waitFor(() => expect(result.current.status).toBe('idle'));
    await result.current.requestMute('peer-2');

    expect(muteRequests()).toHaveLength(1);
    const [url, init] = muteRequests()[0];
    expect(url).toContain('/api/av/mute?roomId=room-1');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(new Headers(init?.headers).get('X-Requested-With')).toBe('XMLHttpRequest');
    expect(init?.body).toBe(JSON.stringify({ target: 'peer-2' }));
  });

  it('sends video mute when the caller targets the camera', async () => {
    const { result } = renderHook(() => useAvSession({ ...options, enabled: false }));

    await waitFor(() => expect(result.current.status).toBe('idle'));
    await result.current.requestMute('peer-2', 'video');

    expect(muteRequests()).toHaveLength(1);
    const [, init] = muteRequests()[0];
    expect(init?.body).toBe(JSON.stringify({ target: 'peer-2', kind: 'video' }));
  });

  it('reflects provider-driven state changes without creating a polling interval', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const connect = vi.spyOn(LiveKitProvider.prototype, 'connect').mockResolvedValue();
    const disconnect = vi.spyOn(LiveKitProvider.prototype, 'disconnect').mockImplementation(() => {});
    const providerEmitters: Array<{
      onParticipant?: (participant: { identity: string; micMuted: boolean; micPresent: boolean; camOn: boolean; isSpeaking: boolean }) => void;
      onLocalMic?: (muted: boolean) => void;
      onLocalCamera?: (on: boolean) => void;
    }> = [];
    const onEvents = vi.spyOn(LiveKitProvider.prototype, 'onEvents').mockImplementation(function (events) {
      providerEmitters.push(events);
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'token-1', url: 'wss://livekit.test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useAvSession({ ...options, enabled: true }));

    await waitFor(() => expect(result.current.status).toBe('joined'));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls.some(([, delay]) => delay === 250)).toBe(false);

    act(() => {
      providerEmitters[0]?.onLocalCamera?.(true);
      providerEmitters[0]?.onParticipant?.({ identity: 'peer-2', micMuted: true, micPresent: true, camOn: false, isSpeaking: false });
    });
    await waitFor(() => expect(result.current.participants.map((p) => p.identity)).toContain('peer-2'));

    act(() => {
      providerEmitters[0]?.onLocalMic?.(true);
    });
    await waitFor(() => expect(result.current.local.micMuted).toBe(true));

    disconnect.mockRestore();
    connect.mockRestore();
    onEvents.mockRestore();
  });

  it('exposes the underlying room object when joined and null when idle', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'token-1', url: 'wss://livekit.test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const connect = vi.spyOn(LiveKitProvider.prototype, 'connect').mockResolvedValue();
    const disconnect = vi.spyOn(LiveKitProvider.prototype, 'disconnect').mockImplementation(() => {});

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAvSession({ ...options, enabled }),
      { initialProps: { enabled: false } },
    );

    expect(result.current.room).toBeNull();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toBe('joined'));
    expect(result.current.room).not.toBeNull();

    rerender({ enabled: false });
    await waitFor(() => expect(result.current.room).toBeNull());

    disconnect.mockRestore();
    connect.mockRestore();
  });

  it('calls toggleScreenShare on the underlying session', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'tok', url: 'wss://lk.test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const connect = vi.spyOn(LiveKitProvider.prototype, 'connect').mockResolvedValue();
    const toggleScreen = vi.spyOn(LiveKitProvider.prototype, 'toggleScreenShare').mockResolvedValue();

    const { result } = renderHook(() => useAvSession({ ...options, enabled: true }));
    await waitFor(() => expect(result.current.status).toBe('joined'));

    await result.current.toggleScreenShare();
    expect(toggleScreen).toHaveBeenCalledTimes(1);

    toggleScreen.mockRestore();
    connect.mockRestore();
  });

  it('maintains memoized object and callback identity across parent re-renders when state is unchanged', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'tok', url: 'wss://lk.test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const connect = vi.spyOn(LiveKitProvider.prototype, 'connect').mockResolvedValue();
    const disconnect = vi.spyOn(LiveKitProvider.prototype, 'disconnect').mockImplementation(() => {});

    const { result, rerender } = renderHook(
      (props: typeof options & { enabled: boolean; count?: number }) => useAvSession(props),
      { initialProps: { ...options, enabled: true, count: 0 } },
    );
    await waitFor(() => expect(result.current.status).toBe('joined'));

    const initialResult = result.current;
    const initialToggleMic = result.current.toggleMicrophone;
    const initialToggleCam = result.current.toggleCamera;
    const initialLeave = result.current.leave;

    // Rerender with changed unrelated prop
    rerender({ ...options, enabled: true, count: 1 });

    expect(result.current).toBe(initialResult);
    expect(result.current.toggleMicrophone).toBe(initialToggleMic);
    expect(result.current.toggleCamera).toBe(initialToggleCam);
    expect(result.current.leave).toBe(initialLeave);

    disconnect.mockRestore();
    connect.mockRestore();
  });

  it('updates participant name without reconnecting or leaving when displayName changes', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'tok', url: 'wss://lk.test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const connect = vi.spyOn(LiveKitProvider.prototype, 'connect').mockResolvedValue();
    const disconnect = vi.spyOn(LiveKitProvider.prototype, 'disconnect').mockImplementation(() => {});

    const { result, rerender } = renderHook(
      ({ displayName }: { displayName: string }) => useAvSession({ ...options, displayName, enabled: true }),
      { initialProps: { displayName: 'Teacher' } },
    );
    await waitFor(() => expect(result.current.status).toBe('joined'));
    expect(tokenRequests()).toHaveLength(1);

    const room = result.current.room;
    expect(room).not.toBeNull();
    const setNameSpy = vi.fn().mockResolvedValue(undefined);
    if (room?.localParticipant) {
      room.localParticipant.setName = setNameSpy;
    }

    // Change display name
    rerender({ displayName: 'Teacher Updated' });

    // Should NOT have made a new token request or disconnected
    expect(tokenRequests()).toHaveLength(1);
    expect(disconnect).not.toHaveBeenCalled();
    await waitFor(() => expect(setNameSpy).toHaveBeenCalledWith('Teacher Updated'));

    disconnect.mockRestore();
    connect.mockRestore();
  });
});

