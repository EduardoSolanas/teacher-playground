import type { Viewport } from '@/types/whiteboard';

/**
 * How long a pan or a zoom settles before the room's view is stored.
 *
 * A pan is a stream of events, and each one would otherwise be a write. The
 * board itself no longer travels over HTTP at all, so this is the only scene
 * write a client still makes and it is a few dozen bytes.
 */
export const VIEWPORT_SAVE_DEBOUNCE_MS = 1_000;

/**
 * Whether this peer should store the room's view.
 *
 * The room keeps one view — the host's. A student panning to their own corner
 * must not decide where the next person to open the room lands, so only the
 * host writes, and only when the view actually moved.
 */
export function shouldStoreViewport(input: {
  isHost: boolean;
  next: Viewport;
  lastStored: Viewport | null;
}): boolean {
  if (!input.isHost) return false;
  const { lastStored, next } = input;
  if (!lastStored) return true;
  return lastStored.x !== next.x || lastStored.y !== next.y || lastStored.zoom !== next.zoom;
}
