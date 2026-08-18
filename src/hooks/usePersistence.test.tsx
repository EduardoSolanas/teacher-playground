import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { CanvasElement, Viewport } from '@/types/whiteboard';
import { getStablePeerId, peerIdStorageKey } from '@/lib/whiteboard/peerId';
import {
  USER_COLOR_STORAGE_KEY,
  USERNAME_STORAGE_KEY,
  isOfflineBoardCacheEnabled,
  loadBoardState,
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
    localStorage.clear();
  });

  it('beforeunload and pagehide do not write board state when cache is default-off and clear session identity via clearOnLeave', () => {
    expect(isOfflineBoardCacheEnabled(ROOM)).toBe(false);
    const peerId = getStablePeerId(ROOM);
    localStorage.setItem(USERNAME_STORAGE_KEY, 'Ada');
    localStorage.setItem(USER_COLOR_STORAGE_KEY, '#3498db');

    render(<Probe />);

    window.dispatchEvent(new Event('beforeunload'));
    expect(localStorage.getItem(`whiteboard:${ROOM}:state`)).toBeNull();
    expect(localStorage.getItem(`whiteboard:${ROOM}:timestamp`)).toBeNull();
    expect(loadBoardState(ROOM)).toBeNull();
    expect(localStorage.getItem(peerIdStorageKey(ROOM))).toBeNull();
    expect(localStorage.getItem(USERNAME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(USER_COLOR_STORAGE_KEY)).toBeNull();
    expect(peerId).toMatch(/^user-/);

    localStorage.setItem(USERNAME_STORAGE_KEY, 'Ada');
    localStorage.setItem(USER_COLOR_STORAGE_KEY, '#3498db');
    localStorage.setItem(peerIdStorageKey(ROOM), peerId);

    window.dispatchEvent(new Event('pagehide'));
    expect(localStorage.getItem(`whiteboard:${ROOM}:state`)).toBeNull();
    expect(localStorage.getItem(peerIdStorageKey(ROOM))).toBeNull();
    expect(localStorage.getItem(USERNAME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(USER_COLOR_STORAGE_KEY)).toBeNull();
  });
});
