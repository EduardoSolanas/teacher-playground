import type { RemoteCursor, WhiteboardUser } from '@/types/whiteboard';

interface RemoteCursorOverlayProps {
  cursors: RemoteCursor[];
  users: WhiteboardUser[];
}

export default function RemoteCursorOverlay({ cursors, users }: RemoteCursorOverlayProps) {
  const hostByPeerId = new Map(users.filter((user) => user.isHost).map((user) => [user.peerId, true]));

  return (
    <>
      {cursors.map((cursor) => {
        const isHostUser = hostByPeerId.has(cursor.peerId);

        return (
          <div
            key={cursor.peerId}
            data-testid={`whiteboard-peer-cursor-${cursor.peerId}`}
            className="pointer-events-none fixed z-[300] flex items-start gap-1"
            style={{
              left: Math.max(0, cursor.x),
              top: Math.max(0, cursor.y),
              color: cursor.color,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M4 3l16 7-7.2 2.3L10 20 4 3z" />
            </svg>
            <span
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold text-white shadow-sm"
              style={{ background: cursor.color }}
            >
              {cursor.userName}
              {isHostUser && (
                <span
                  data-testid={`whiteboard-peer-cursor-host-${cursor.peerId}`}
                  className="rounded bg-emerald-600 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-white"
                >
                  Host
                </span>
              )}
            </span>
          </div>
        );
      })}
    </>
  );
}
