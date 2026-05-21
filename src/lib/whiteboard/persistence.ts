import type { CanvasElement, Viewport } from '@/types/whiteboard';

const STORAGE_PREFIX = 'whiteboard';
const STATE_SUFFIX = ':state';
const TIMESTAMP_SUFFIX = ':timestamp';
const ROOM_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

function getStateKey(roomId: string): string {
  return `${STORAGE_PREFIX}:${roomId}${STATE_SUFFIX}`;
}

function getTimestampKey(roomId: string): string {
  return `${STORAGE_PREFIX}:${roomId}${TIMESTAMP_SUFFIX}`;
}

export async function saveBoardState(
  roomId: string,
  elements: CanvasElement[],
  viewport: Viewport
): Promise<void> {
  if (typeof window === 'undefined') return;

  const state = {
    elements,
    viewport,
    savedAt: Date.now(),
  };

  localStorage.setItem(getStateKey(roomId), JSON.stringify(state));
  localStorage.setItem(getTimestampKey(roomId), String(Date.now()));
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

export function debouncedSaveBoardState(
  roomId: string,
  elements: CanvasElement[],
  viewport: Viewport,
  debounceMs: number = 2000
): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(() => {
    saveBoardState(roomId, elements, viewport);
    saveTimeout = null;
  }, debounceMs);
}

export function loadBoardState(
  roomId: string
): { elements: CanvasElement[]; viewport: Viewport } | null {
  if (typeof window === 'undefined') return null;

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
  localStorage.removeItem(getStateKey(roomId));
  localStorage.removeItem(getTimestampKey(roomId));
}

export function cleanupStaleRooms(): void {
  if (typeof window === 'undefined') return;

  const now = Date.now();
  const keys = Object.keys(localStorage);

  for (const key of keys) {
    if (key.startsWith(`${STORAGE_PREFIX}:`) && key.includes(TIMESTAMP_SUFFIX)) {
      const roomId = key
        .replace(`${STORAGE_PREFIX}:`, '')
        .replace(TIMESTAMP_SUFFIX, '');
      const timestamp = parseInt(localStorage.getItem(key) || '0', 10);

      if (now - timestamp > ROOM_EXPIRY_MS) {
        clearBoardState(roomId);
      }
    }
  }
}
