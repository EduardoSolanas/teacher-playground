'use client';

/**
 * Says the room has stopped trying, rather than letting it look frozen.
 *
 * The HTTP fallbacks cover a socket that drops for a few seconds. Past five
 * minutes they give up, because a session that has not reconnected by then is
 * not going to on its own -- and one that keeps polling regardless spends a
 * request every few seconds, for as long as the tab is open, to learn nothing
 * and tell nobody.
 *
 * Reloading is what would have fixed it anyway, so this offers that and says
 * plainly that the board is still safe. The work is in the room, not the tab.
 */
export default function ConnectionLostNotice() {
  return (
    <div
      role="alert"
      data-testid="whiteboard-connection-lost"
      className="fixed left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] z-[1500] flex -translate-x-1/2 items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[0.8125rem] font-medium text-amber-900 shadow-lg"
    >
      <span>Connection lost. Your work is saved in the room.</span>
      <button
        type="button"
        data-testid="whiteboard-connection-lost-reload"
        onClick={() => window.location.reload()}
        className="rounded-lg border border-amber-500 px-2 py-1 text-[0.75rem] transition-colors hover:bg-amber-100"
      >
        Reload
      </button>
    </div>
  );
}
