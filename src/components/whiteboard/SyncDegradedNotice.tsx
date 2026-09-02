'use client';

/**
 * Notice displayed when whiteboard synchronization is degraded
 * (e.g. rate-limit close, temporary heartbeat 5xx, or shed frames).
 * Communicates that drawing updates may experience delay without implying
 * the room connection has been permanently lost.
 */
export default function SyncDegradedNotice() {
  return (
    <div
      role="status"
      data-testid="whiteboard-sync-degraded"
      className="fixed left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] z-[1450] flex -translate-x-1/2 items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-[0.8125rem] font-medium text-amber-900 shadow-md"
    >
      <span>Sync degraded. Drawing updates may be delayed.</span>
    </div>
  );
}
