import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import type { CanvasElement, Viewport } from '@/types/whiteboard';
import { getStablePeerId, peerIdStorageKey } from '@/lib/whiteboard/peerId';
import {
  USER_COLOR_STORAGE_KEY,
  USERNAME_STORAGE_KEY,
  cancelDebouncedSave,
  isOfflineBoardCacheEnabled,
  setOfflineBoardCacheEnabled,
} from '@/lib/whiteboard/persistence';
import { usePersistence } from './usePersistence';

const ROOM = 'classroom-alpha';
const VIEWPORT: Viewport = { x: 1, y: 2, zoom: 1 };
const ELEMENT = {
  id: 'rect-1',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  fill: '#fff',
  stroke: '#000',
  strokeWidth: 1,
} as CanvasElement;

function Probe() {
  usePersistence(ROOM, [ELEMENT], VIEWPORT);
  return null;
}

describe('usePersistence tab close (SEC-011)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cancelDebouncedSave();
    localStorage.clear();
  });

  it('beforeunload and pagehide do not wipe join identity so Back to rooms can reopen the board', () => {
    expect(isOfflineBoardCacheEnabled(ROOM)).toBe(false);
    const peerId = getStablePeerId(ROOM);
    localStorage.setItem(USERNAME_STORAGE_KEY, 'Ada');
    localStorage.setItem(USER_COLOR_STORAGE_KEY, '#3498db');

    render(<Probe />);

    window.dispatchEvent(new Event('beforeunload'));
    expect(localStorage.getItem(USERNAME_STORAGE_KEY)).toBe('Ada');
    expect(localStorage.getItem(USER_COLOR_STORAGE_KEY)).toBe('#3498db');
    expect(localStorage.getItem(peerIdStorageKey(ROOM))).toBe(peerId);

    window.dispatchEvent(new Event('pagehide'));
    expect(localStorage.getItem(USERNAME_STORAGE_KEY)).toBe('Ada');
    expect(localStorage.getItem(USER_COLOR_STORAGE_KEY)).toBe('#3498db');
    expect(localStorage.getItem(peerIdStorageKey(ROOM))).toBe(peerId);
  });
});

describe('usePersistence room state', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cancelDebouncedSave();
    localStorage.clear();
  });

  it('is inert without a room', () => {
    const { result } = renderHook(() => usePersistence(null, [ELEMENT], VIEWPORT));

    expect(result.current.loadedState).toBeNull();

    act(() => {
      result.current.saveState([ELEMENT], VIEWPORT);
      result.current.clearState();
      result.current.clearSession();
    });

    expect(result.current.loadState()).toBeNull();
  });

  it('loads a cached board once and keeps it when the room id changes', () => {
    setOfflineBoardCacheEnabled(ROOM, true);
    localStorage.setItem(
      `whiteboard:${ROOM}:state`,
      JSON.stringify({ elements: [ELEMENT], viewport: VIEWPORT }),
    );

    const { result, rerender } = renderHook(
      ({ roomId }: { roomId: string | null }) => usePersistence(roomId, [], VIEWPORT),
      { initialProps: { roomId: ROOM as string | null } },
    );

    expect(result.current.loadedState).toEqual({ elements: [ELEMENT], viewport: VIEWPORT });

    rerender({ roomId: 'classroom-beta' });

    expect(result.current.loadedState).toEqual({ elements: [ELEMENT], viewport: VIEWPORT });
  });

  it('saves, loads and clears real room state through the callbacks', () => {
    setOfflineBoardCacheEnabled(ROOM, true);
    const { result } = renderHook(() => usePersistence(ROOM, [ELEMENT], VIEWPORT));

    act(() => {
      result.current.saveState([ELEMENT], VIEWPORT);
    });
    expect(result.current.loadState()).toEqual({ elements: [ELEMENT], viewport: VIEWPORT });

    act(() => {
      result.current.clearState();
    });
    expect(result.current.loadState()).toBeNull();

    localStorage.setItem(USERNAME_STORAGE_KEY, 'Ada');
    localStorage.setItem(USER_COLOR_STORAGE_KEY, '#3498db');
    act(() => {
      result.current.clearSession();
    });
    expect(localStorage.getItem(USERNAME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(USER_COLOR_STORAGE_KEY)).toBeNull();
  });
});
