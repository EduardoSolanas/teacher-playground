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
      className="fixed left-2 top-[calc(max(0.5rem,env(safe-area-inset-top))+7rem)] z-[1400] rounded-full border border-slate-700/80 bg-slate-900/95 px-3 py-1.5 text-[0.6875rem] font-medium text-slate-200 shadow-lg shadow-slate-900/30 transition-colors hover:bg-slate-800 sm:bottom-16 sm:left-14 sm:top-auto"
    >
      Join call
    </button>
  );
}
