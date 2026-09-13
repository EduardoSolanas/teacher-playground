// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  cleanupStaleRooms,
  clearBoardState,
  clearSessionIdentity,
  isOfflineBoardCacheEnabled,
  loadBoardState,
  saveBoardState,
} from './persistence';

/*
 * The guards this file exercises decide what happens where there is no DOM at
 * all. jsdom always defines `window`, so a jsdom test can never reach them;
 * this file runs in Node, where `typeof window === 'undefined'` is the truth
 * the guards were written for.
 */
describe('persistence without a DOM', () => {
  it('reports the offline cache off when there is no localStorage', () => {
    expect(isOfflineBoardCacheEnabled('room-1')).toBe(false);
  });

  it('clears session identity without throwing when there is no localStorage', () => {
    expect(() => clearSessionIdentity()).not.toThrow();
  });

  it('clears a board state without throwing when there is no localStorage', () => {
    expect(() => clearBoardState('room-1')).not.toThrow();
  });

  it('loads null and saves nothing when there is no localStorage', async () => {
    expect(loadBoardState('room-1')).toBeNull();
    await expect(saveBoardState('room-1', [], { x: 0, y: 0, zoom: 1 })).resolves.toBeUndefined();
  });

  it('sweeps stale rooms without throwing when there is no localStorage', () => {
    expect(() => cleanupStaleRooms()).not.toThrow();
  });
});
