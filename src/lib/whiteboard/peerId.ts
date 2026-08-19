import { randomHexId } from '@/lib/crypto/randomId';

export function peerIdStorageKey(roomId: string): string {
  return `whiteboard:${roomId}:peer_id`;
}

/**
 * Stable per-room cursor label in localStorage. This is never a grant key:
 * the server binds the label to the authenticated account on join and
 * authorizes from `room_members.account_id`. Server-issued session ids were
 * not added here (client Yjs/cursor identity is still this label); forging
 * it cannot moderate or un-ban.
 */
export function getStablePeerId(roomId: string) {
  const fallback = `user-${randomHexId()}`;
  if (typeof window === 'undefined') return fallback;

  try {
    const key = peerIdStorageKey(roomId);
    const saved = localStorage.getItem(key);
    if (saved) return saved;

    localStorage.setItem(key, fallback);
    return fallback;
  } catch {
    return fallback;
  }
}

/** Cursor labels are minted only after join so leave/clearOnLeave is not undone. */
export function peerIdWhenJoined(hasJoined: boolean, roomId: string): string | null {
  if (!hasJoined) return null;
  return getStablePeerId(roomId);
}

export function rememberIssuedPeerId(roomId: string, issuedPeerId: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(peerIdStorageKey(roomId), issuedPeerId);
  } catch {
    // localStorage unavailable
  }
}

/** Presence POST returns the server-minted label; cursors must use that id. */
export function nextPeerIdFromPresence(current: string, issued: unknown): string | null {
  if (typeof issued !== 'string' || issued.length === 0) return null;
  if (issued === current) return null;
  return issued;
}

export function clearStoredPeerId(roomId: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(peerIdStorageKey(roomId));
  } catch {
    // localStorage unavailable
  }
}
