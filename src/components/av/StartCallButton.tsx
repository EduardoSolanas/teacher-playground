'use client';

/**
 * What stands in for the call before anybody has asked for one.
 *
 * A room used to take the camera and the microphone the moment it was
 * admitted, whether or not the lesson wanted a call: the browser's recording
 * indicator came on for someone who had only opened a whiteboard, and a
 * teacher preparing a board an hour early was live in an empty room.
 *
 * So the call waits to be asked. This sits exactly where the panel will
 * appear, so pressing it feels like opening that panel rather than summoning
 * one from somewhere else on the screen.
 */
export default function StartCallButton({ onStart }: { readonly onStart: () => void }) {
  return (
    <button
      type="button"
      data-testid="av-start-call"
      onClick={onStart}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300 shadow-sm transition-all hover:border-emerald-500/60 hover:bg-emerald-500/25 active:scale-95"
    >
      <svg
        className="h-3.5 w-3.5 text-emerald-400 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
        />
      </svg>
      <span>Start call</span>
    </button>
  );
}
