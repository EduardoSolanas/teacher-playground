import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { CanvasElement, Viewport } from '@/types/whiteboard';
import { getStablePeerId, peerIdStorageKey } from '@/lib/whiteboard/peerId';
import {
  USER_COLOR_STORAGE_KEY,
  USERNAME_STORAGE_KEY,
  isOfflineBoardCacheEnabled,
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
