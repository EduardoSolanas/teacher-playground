import type { CanvasElement, Viewport } from '@/types/whiteboard';
import { clearStoredPeerId } from '@/lib/whiteboard/peerId';

// WebRTC IP/ICE: this module only governs localStorage retention. Direct
// peer connections can still expose ICE/host candidates to other room
// members; TURN/relay-only ICE is out of scope here (SEC-011).

const STORAGE_PREFIX = 'whiteboard';
const STATE_SUFFIX = ':state';
const TIMESTAMP_SUFFIX = ':timestamp';
const OFFLINE_CACHE_SUFFIX = ':offline_cache';
const ROOM_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export const USERNAME_STORAGE_KEY = 'whiteboard_username';
export const USER_COLOR_STORAGE_KEY = 'whiteboard_user_color';

function getStateKey(roomId: string): string {
  return `${STORAGE_PREFIX}:${roomId}${STATE_SUFFIX}`;
}

function getTimestampKey(roomId: string): string {
  return `${STORAGE_PREFIX}:${roomId}${TIMESTAMP_SUFFIX}`;
}

function getOfflineCacheKey(roomId: string): string {
  return `${STORAGE_PREFIX}:${roomId}${OFFLINE_CACHE_SUFFIX}`;
}

function roomIdFromPrefixedKey(key: string, suffix: string): string | null {
  const prefix = `${STORAGE_PREFIX}:`;
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return null;
  return key.slice(prefix.length, key.length - suffix.length);
}

export function isOfflineBoardCacheEnabled(roomId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(getOfflineCacheKey(roomId)) === '1';
  } catch {
    return false;
  }
}

export function setOfflineBoardCacheEnabled(roomId: string, enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) {
      localStorage.setItem(getOfflineCacheKey(roomId), '1');
      return;
    }
    localStorage.removeItem(getOfflineCacheKey(roomId));
    clearBoardState(roomId);
  } catch {
    // localStorage unavailable
  }
}

export async function saveBoardState(
  roomId: string,
  elements: CanvasElement[],
  viewport: Viewport
): Promise<void> {
  if (typeof window === 'undefined') return;
  if (!isOfflineBoardCacheEnabled(roomId)) return;

  const state = {
    elements,
    viewport,
    savedAt: Date.now(),
  };

  localStorage.setItem(getStateKey(roomId), JSON.stringify(state));
  localStorage.setItem(getTimestampKey(roomId), String(Date.now()));
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

export function cancelDebouncedSave(): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
}

export function debouncedSaveBoardState(
  roomId: string,
  elements: CanvasElement[],
  viewport: Viewport,
  debounceMs: number = 2000
): void {
  cancelDebouncedSave();
  saveTimeout = setTimeout(() => {
    saveBoardState(roomId, elements, viewport);
    saveTimeout = null;
  }, debounceMs);
}

export function loadBoardState(
  roomId: string
): { elements: CanvasElement[]; viewport: Viewport } | null {
  if (typeof window === 'undefined') return null;

  if (!isOfflineBoardCacheEnabled(roomId)) {
    clearBoardState(roomId);
    return null;
  }

  const raw = localStorage.getItem(getStateKey(roomId));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return {
      elements: parsed.elements || [],
      viewport: parsed.viewport || { x: 0, y: 0, zoom: 1 },
    };
  } catch {
    return null;
  }
}

export function clearBoardState(roomId: string): void {
  if (typeof window === 'undefined') return;
  cancelDebouncedSave();
  localStorage.removeItem(getStateKey(roomId));
  localStorage.removeItem(getTimestampKey(roomId));
}

export function clearSessionIdentity(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(USERNAME_STORAGE_KEY);
  localStorage.removeItem(USER_COLOR_STORAGE_KEY);
}

/** Room-scoped board, peer, and opt-in keys. Does not touch origin-wide identity. */
export function clearRoomStorage(roomId: string): void {
  if (typeof window === 'undefined') return;
  cancelDebouncedSave();
  clearBoardState(roomId);
  try {
    localStorage.removeItem(getOfflineCacheKey(roomId));
  } catch {
    // localStorage unavailable
  }
  clearStoredPeerId(roomId);
}

/** Leave / kick / revoke: drop board, peer, opt-in, and session identity. */
export function clearRoomSessionMaterial(roomId: string): void {
  clearRoomStorage(roomId);
  clearSessionIdentity();
}

/** Voluntary in-room leave: same retention policy as kick/revoke. */
export function clearOnLeave(roomId: string): void {
  clearRoomSessionMaterial(roomId);
}

export function cleanupStaleRooms(): void {
  if (typeof window === 'undefined') return;

  const now = Date.now();
  const keys = Object.keys(localStorage);
  const roomsToExpire = new Set<string>();
  const leftoverBoards = new Set<string>();

  for (const key of keys) {
    const timestampRoomId = roomIdFromPrefixedKey(key, TIMESTAMP_SUFFIX);
    if (timestampRoomId) {
      const timestamp = parseInt(localStorage.getItem(key) || '0', 10);
      if (now - timestamp > ROOM_EXPIRY_MS) {
        roomsToExpire.add(timestampRoomId);
      } else if (!isOfflineBoardCacheEnabled(timestampRoomId)) {
        leftoverBoards.add(timestampRoomId);
      }
      continue;
    }

    const stateRoomId = roomIdFromPrefixedKey(key, STATE_SUFFIX);
    if (stateRoomId && !isOfflineBoardCacheEnabled(stateRoomId)) {
      leftoverBoards.add(stateRoomId);
    }
  }

  for (const roomId of roomsToExpire) {
    clearRoomStorage(roomId);
  }
  for (const roomId of leftoverBoards) {
    if (!roomsToExpire.has(roomId)) {
      clearBoardState(roomId);
    }
  }
}
