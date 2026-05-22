import type { RemoteCursor } from '@/types/whiteboard';

export default function RemoteCursorOverlay({ cursors }: { cursors: RemoteCursor[] }) {
  return (
    <>
      {cursors.map((cursor) => (
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
            className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-white shadow-sm"
            style={{ background: cursor.color }}
          >
            {cursor.userName}
          </span>
        </div>
      ))}
    </>
  );
}
