import type { Awareness } from 'y-protocols/awareness';
import type { RemoteCursor, WhiteboardUser } from '@/types/whiteboard';

/**
 * Cursors travel as awareness, not as document content.
 *
 * A cursor is worth exactly as long as its owner is looking at the board, but
 * writing one into the shared document made it permanent: overwriting a Y.Map
 * key drops the old value's content and keeps its tombstone, so a board grew
 * about 11KB per minute per participant no matter what anyone drew. An hour
 * with two people put ~1.4MB of stale pointer positions into the stored
 * snapshot, which is what took a room past the 2MB storage ceiling.
 *
 * Awareness is the mechanism for exactly this: it rides the same socket and
 * fans out to peers, but it is never part of the document and so is never
 * stored, never replayed, and never syncs to a peer that joins later. It also
 * expires on its own, so a peer that vanishes takes its cursor with it.
 */
export interface CursorState {
  readonly peerId: string;
  readonly userName: string;
  readonly color: string;
  readonly x: number;
  readonly y: number;
  /** Whether the peer is mid-stroke, so the overlay can show it drawing. */
  readonly button: 'up' | 'down';
}

/** The awareness field cursors live under. */
const CURSOR_FIELD = 'cursor';

export function publishCursor(awareness: Awareness | null | undefined, state: CursorState): void {
  awareness?.setLocalStateField(CURSOR_FIELD, state);
}

/** Withdraws this peer's cursor, so peers drop it without waiting for a timeout. */
export function clearCursor(awareness: Awareness | null | undefined): void {
  awareness?.setLocalStateField(CURSOR_FIELD, null);
}

/** This peer's own last published cursor, or null if it has not published one. */
export function readLocalCursor(awareness: Awareness | null | undefined): CursorState | null {
  const state = awareness?.getLocalState() as Record<string, unknown> | null | undefined;
  return asCursorState(state?.[CURSOR_FIELD]);
}

function asCursorState(value: unknown): CursorState | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Partial<CursorState>;
  if (typeof entry.peerId !== 'string' || entry.peerId.length === 0) return null;
  return {
    peerId: entry.peerId,
    userName: typeof entry.userName === 'string' ? entry.userName : 'Anonymous',
    color: typeof entry.color === 'string' ? entry.color : '#3498db',
    x: typeof entry.x === 'number' ? entry.x : 0,
    y: typeof entry.y === 'number' ? entry.y : 0,
    button: entry.button === 'down' ? 'down' : 'up',
  };
}

/** Every cursor currently announced, this peer's included. */
export function readCursorStates(awareness: Awareness | null | undefined): CursorState[] {
  if (!awareness) return [];
  const cursors: CursorState[] = [];
  awareness.getStates().forEach((state) => {
    const cursor = asCursorState((state as Record<string, unknown> | null)?.[CURSOR_FIELD]);
    if (cursor) cursors.push(cursor);
  });
  return cursors;
}

/** The other peers' cursors: what the overlay draws. */
export function readRemoteCursors(awareness: Awareness | null | undefined): RemoteCursor[] {
  if (!awareness) return [];
  const cursors: RemoteCursor[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return;
    const cursor = asCursorState((state as Record<string, unknown> | null)?.[CURSOR_FIELD]);
    if (cursor) cursors.push(cursor);
  });
  return cursors;
}

/** The roster the shared link knows about, from the same announcements. */
export function readCursorUsers(awareness: Awareness | null | undefined): WhiteboardUser[] {
  return readCursorStates(awareness).map((cursor) => ({
    peerId: cursor.peerId,
    userName: cursor.userName,
    color: cursor.color,
    isHost: false,
  }));
}
