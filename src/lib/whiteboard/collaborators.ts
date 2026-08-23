import type { Collaborator, SocketId } from '@excalidraw/excalidraw/types';
import type { RemoteCursor, WhiteboardUser } from '@/types/whiteboard';

/**
 * Convert the server-admitted roster and the Yjs cursor stream into the shape
 * Excalidraw renders natively. The roster is authoritative: cursor-only Yjs
 * entries must never become visible collaborators.
 */
export function collaboratorsFromPresence(
  users: readonly WhiteboardUser[],
  cursors: readonly RemoteCursor[],
  localPeerId: string,
): Map<SocketId, Collaborator> {
  const cursorByPeer = new Map(cursors.map((cursor) => [cursor.peerId, cursor]));
  const collaborators = new Map<SocketId, Collaborator>();

  for (const user of users) {
    if (!user.peerId || user.peerId === localPeerId) continue;

    const cursor = cursorByPeer.get(user.peerId);
    const username = user.isHost ? `${user.userName} (Host)` : user.userName;
    const collaborator: Collaborator = {
      id: user.peerId,
      socketId: user.peerId as SocketId,
      username,
      color: {
        background: cursor?.color ?? user.color,
        stroke: cursor?.color ?? user.color,
      },
      ...(cursor
        ? {
            pointer: {
              x: cursor.x,
              y: cursor.y,
              tool: 'pointer' as const,
            },
            button: cursor.button === 'down' ? ('down' as const) : ('up' as const),
          }
        : {}),
    };
    collaborators.set(user.peerId as SocketId, collaborator);
  }

  return collaborators;
}
