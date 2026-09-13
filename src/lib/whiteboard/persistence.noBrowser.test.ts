// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Viewport } from '@/types/whiteboard';
import {
  cancelDebouncedSave,
  cleanupStaleRooms,
  clearBoardState,
  clearOnLeave,
  clearOnReject,
  clearOnSuspend,
  clearRoomSessionMaterial,
  clearRoomStorage,
  clearSessionIdentity,
  debouncedSaveBoardState,
  isOfflineBoardCacheEnabled,
  loadBoardState,
  saveBoardState,
  setOfflineBoardCacheEnabled,
} from './persistence';

const VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

/*
 * Every entry point of this module runs on mount or on leave in the room
 * client, including for a peer whose browser profile has no storage at all.
 * Without a `window` there is no `localStorage` either -- the functions reach
 * it directly -- so each one must return or no-op before touching it. Running
 * the contract in node, where `window` genuinely does not exist, is what
 * makes that guard observable: remove it and these calls throw.
 */
describe('whiteboard persistence without a browser environment', () => {
  it('every storage entry point is a safe no-op where there is no window', async () => {
    expect(isOfflineBoardCacheEnabled('no-browser-room')).toBe(false);
    expect(() => setOfflineBoardCacheEnabled('no-browser-room', true)).not.toThrow();
    expect(() => setOfflineBoardCacheEnabled('no-browser-room', false)).not.toThrow();
    await expect(
      saveBoardState('no-browser-room', [], VIEWPORT),
    ).resolves.toBeUndefined();
    expect(loadBoardState('no-browser-room')).toBeNull();
    expect(() => clearBoardState('no-browser-room')).not.toThrow();
    expect(() => clearSessionIdentity()).not.toThrow();
    expect(() => clearRoomStorage('no-browser-room')).not.toThrow();
    expect(() => clearRoomSessionMaterial('no-browser-room')).not.toThrow();
    expect(() => clearOnLeave('no-browser-room')).not.toThrow();
    expect(() => clearOnReject('no-browser-room')).not.toThrow();
    expect(() => clearOnSuspend('no-browser-room')).not.toThrow();
    expect(() => cleanupStaleRooms()).not.toThrow();
    expect(() =>
      debouncedSaveBoardState('no-browser-room', [], VIEWPORT, 1),
    ).not.toThrow();
    expect(() => cancelDebouncedSave()).not.toThrow();
  });
});
