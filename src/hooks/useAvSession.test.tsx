import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { useAvSession } from './useAvSession';

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
});
