import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasElement, Viewport } from '@/types/whiteboard';
import { getStablePeerId, peerIdStorageKey } from '@/lib/whiteboard/peerId';
import {
  USER_COLOR_STORAGE_KEY,
  USERNAME_STORAGE_KEY,
  cleanupStaleRooms,
  clearRoomSessionMaterial,
  debouncedSaveBoardState,
  isOfflineBoardCacheEnabled,
  loadBoardState,
  saveBoardState,
  setOfflineBoardCacheEnabled,
} from './persistence';

const ROOM = 'classroom-alpha';
const OTHER_ROOM = 'classroom-beta';
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

function seedLegacyBoard(roomId: string, payload = { elements: [ELEMENT], viewport: VIEWPORT }) {
  localStorage.setItem(`whiteboard:${roomId}:state`, JSON.stringify(payload));
  localStorage.setItem(`whiteboard:${roomId}:timestamp`, String(Date.now()));
}

describe('whiteboard persistence (SEC-011)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('does not write board content to localStorage by default', async () => {
    expect(isOfflineBoardCacheEnabled(ROOM)).toBe(false);
    await saveBoardState(ROOM, [ELEMENT], VIEWPORT);

    expect(localStorage.getItem(`whiteboard:${ROOM}:state`)).toBeNull();
    expect(localStorage.getItem(`whiteboard:${ROOM}:timestamp`)).toBeNull();
    expect(loadBoardState(ROOM)).toBeNull();
  });

  it('writes and loads board content only after explicit opt-in', async () => {
    setOfflineBoardCacheEnabled(ROOM, true);
    expect(isOfflineBoardCacheEnabled(ROOM)).toBe(true);

    await saveBoardState(ROOM, [ELEMENT], VIEWPORT);
    expect(loadBoardState(ROOM)).toEqual({
      elements: [ELEMENT],
      viewport: VIEWPORT,
    });
    expect(localStorage.getItem(`whiteboard:${OTHER_ROOM}:state`)).toBeNull();
  });

  it('turning opt-in off wipes that room\'s cached board', async () => {
    setOfflineBoardCacheEnabled(ROOM, true);
    await saveBoardState(ROOM, [ELEMENT], VIEWPORT);
    setOfflineBoardCacheEnabled(ROOM, false);

    expect(isOfflineBoardCacheEnabled(ROOM)).toBe(false);
    expect(localStorage.getItem(`whiteboard:${ROOM}:state`)).toBeNull();
    expect(loadBoardState(ROOM)).toBeNull();
  });

  it('purges leftover plaintext board keys so a later user cannot recover them', () => {
    seedLegacyBoard(ROOM);
    expect(loadBoardState(ROOM)).toBeNull();
    expect(localStorage.getItem(`whiteboard:${ROOM}:state`)).toBeNull();
    expect(localStorage.getItem(`whiteboard:${ROOM}:timestamp`)).toBeNull();
  });

  it('clears board, peer, opt-in, and session identity on leave/kick/revoke', async () => {
    setOfflineBoardCacheEnabled(ROOM, true);
    await saveBoardState(ROOM, [ELEMENT], VIEWPORT);
    const peerId = getStablePeerId(ROOM);
    localStorage.setItem(USERNAME_STORAGE_KEY, 'Ada');
    localStorage.setItem(USER_COLOR_STORAGE_KEY, '#3498db');

    clearRoomSessionMaterial(ROOM);

    expect(localStorage.getItem(`whiteboard:${ROOM}:state`)).toBeNull();
    expect(localStorage.getItem(`whiteboard:${ROOM}:timestamp`)).toBeNull();
    expect(localStorage.getItem(`whiteboard:${ROOM}:offline_cache`)).toBeNull();
    expect(localStorage.getItem(peerIdStorageKey(ROOM))).toBeNull();
    expect(localStorage.getItem(USERNAME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(USER_COLOR_STORAGE_KEY)).toBeNull();
    expect(loadBoardState(ROOM)).toBeNull();
    expect(peerId).toMatch(/^user-/);
  });

  it('does not restore board data after leave even if opt-in is turned back on', async () => {
    setOfflineBoardCacheEnabled(ROOM, true);
    await saveBoardState(ROOM, [ELEMENT], VIEWPORT);
    clearRoomSessionMaterial(ROOM);

    setOfflineBoardCacheEnabled(ROOM, true);
    expect(loadBoardState(ROOM)).toBeNull();
  });

  it('drops expired room material including the stored peer id', () => {
    const expiredAt = Date.now() - 25 * 60 * 60 * 1000;
    localStorage.setItem(`whiteboard:${ROOM}:state`, JSON.stringify({
      elements: [ELEMENT],
      viewport: VIEWPORT,
    }));
    localStorage.setItem(`whiteboard:${ROOM}:timestamp`, String(expiredAt));
    localStorage.setItem(`whiteboard:${ROOM}:offline_cache`, '1');
    localStorage.setItem(peerIdStorageKey(ROOM), 'user-stale');
    localStorage.setItem(USERNAME_STORAGE_KEY, 'Ada');

    cleanupStaleRooms();

    expect(localStorage.getItem(`whiteboard:${ROOM}:state`)).toBeNull();
    expect(localStorage.getItem(`whiteboard:${ROOM}:timestamp`)).toBeNull();
    expect(localStorage.getItem(`whiteboard:${ROOM}:offline_cache`)).toBeNull();
    expect(localStorage.getItem(peerIdStorageKey(ROOM))).toBeNull();
    expect(loadBoardState(ROOM)).toBeNull();
    expect(localStorage.getItem(USERNAME_STORAGE_KEY)).toBe('Ada');
  });

  it('cleanup removes leftover boards that were never opted in', () => {
    seedLegacyBoard(ROOM);
    cleanupStaleRooms();
    expect(localStorage.getItem(`whiteboard:${ROOM}:state`)).toBeNull();
  });

  it('cancels a pending debounced save so leave cannot rewrite the cache', async () => {
    vi.useFakeTimers();
    setOfflineBoardCacheEnabled(ROOM, true);
    debouncedSaveBoardState(ROOM, [ELEMENT], VIEWPORT, 2000);
    clearRoomSessionMaterial(ROOM);

    await vi.advanceTimersByTimeAsync(2500);

    expect(localStorage.getItem(`whiteboard:${ROOM}:state`)).toBeNull();
    expect(loadBoardState(ROOM)).toBeNull();
  });
});
