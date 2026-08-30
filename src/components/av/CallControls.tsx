'use client';

import type { UseAvSessionResult } from '@/hooks/useAvSession';

/**
 * The mic and camera of a call, and how far the call has got.
 *
 * Separate from the panel of faces because the two want to live in different
 * places. The faces need room and belong in a panel; the controls are two
 * buttons somebody reaches for in a hurry mid-lesson, and belong somewhere
 * fixed that does not move as people join and leave. That is the top bar --
 * but this knows nothing about the bar, so the one place that is not always
 * there (the guest hostname renders no bar) can hold it instead.
 */
export default function CallControls({ av }: { readonly av: UseAvSessionResult }) {
  // The session refuses a toggle until it has joined -- connecting publishes
  // both devices itself, so a press taken then is a press lost. A button that
  // is live in those states is a button that does nothing when pressed.
  const inert = av.status !== 'joined';

  return (
    <div data-testid="av-call-controls" className="flex items-center gap-1">
      <span
        data-testid="av-call-status"
        className="hidden text-[0.6875rem] font-medium uppercase tracking-wide text-slate-400 sm:inline"
      >
        Call
        {av.status === 'connecting' ? ' · connecting…' : ''}
        {av.status === 'joined' ? ' · live' : ''}
      </span>
      <button
        type="button"
        data-testid="av-toggle-mic"
        className="rounded-md border border-slate-600 px-2 py-1 text-[0.6875rem] text-slate-200 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={av.toggleMicrophone}
        disabled={inert}
      >
        {av.local.micMuted ? 'Unmute' : 'Mute'}
      </button>
      <button
        type="button"
        data-testid="av-toggle-cam"
        className="rounded-md border border-slate-600 px-2 py-1 text-[0.6875rem] text-slate-200 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={av.toggleCamera}
        disabled={inert}
      >
        {av.local.camOn ? 'Camera off' : 'Camera on'}
      </button>
    </div>
  );
}
