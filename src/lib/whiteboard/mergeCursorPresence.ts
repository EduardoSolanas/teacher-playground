import type { RemoteCursor, WhiteboardUser } from '@/types/whiteboard';

/** Yjs cursor labels must not invent roster rows the presence API did not admit. */
export function mergeCursorPresence(
  users: WhiteboardUser[],
  cursors: RemoteCursor[],
): WhiteboardUser[] {
  const merged = new Map(users.map((user) => [user.peerId, { ...user }]));
  for (const cursor of cursors) {
    const existing = merged.get(cursor.peerId);
    if (!existing) continue;
    merged.set(cursor.peerId, {
      ...existing,
      userName: cursor.userName,
      color: cursor.color,
    });
  }
  return Array.from(merged.values());
}
