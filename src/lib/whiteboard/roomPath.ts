import { isValidRoomId } from '@/lib/worker/requestGuard';

/** Static-export placeholder; the Worker rewrites real room URLs to this path. */
const PLACEHOLDER_ROOM_ID = '_room';

export function roomIdFromWhiteboardPath(pathname: string): string | null {
  const match = pathname.match(/^\/whiteboard\/([^/]+)\/?$/);
  if (!match) return null;
  let roomId: string;
  try {
    roomId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (roomId === PLACEHOLDER_ROOM_ID || roomId === 'undefined') return null;
  if (!isValidRoomId(roomId)) return null;
  return roomId;
}

export function whiteboardRoomHref(roomId: string): string {
  return `/whiteboard/${roomId}`;
}

/** Full document navigation keeps the real room id in the address bar. */
export function navigateToWhiteboardRoom(roomId: string): void {
  window.location.assign(whiteboardRoomHref(roomId));
}
