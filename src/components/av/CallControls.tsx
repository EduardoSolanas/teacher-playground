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
    <div data-testid="av-call-controls" className="flex flex-wrap items-center gap-1.5 sm:flex-nowrap">
      <span
        data-testid="av-call-status"
        className="hidden items-center gap-1.5 rounded-md border border-slate-700/70 bg-slate-800/80 px-2 py-1 text-[0.6875rem] font-medium text-slate-300 sm:inline-flex"
      >
        {av.status === 'joined' && (
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
        )}
        {av.status === 'connecting' && (
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
        )}
        Call
        {av.status === 'connecting' ? ' · connecting…' : ''}
        {av.status === 'joined' ? ' · live' : ''}
      </span>

      <button
        type="button"
        data-testid="av-toggle-mic"
        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[0.6875rem] font-medium whitespace-nowrap transition-all shadow-sm disabled:cursor-not-allowed disabled:opacity-40 ${
          av.local.micMuted
            ? 'border border-rose-500/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
            : 'border border-slate-700/80 bg-slate-800/90 text-slate-200 hover:border-slate-600 hover:bg-slate-700/90 hover:text-white'
        }`}
        onClick={av.toggleMicrophone}
        disabled={inert}
      >
        {av.local.micMuted ? (
          <svg className="h-3.5 w-3.5 text-rose-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
          </svg>
        ) : (
          <svg className="h-3.5 w-3.5 text-slate-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        )}
        {av.local.micMuted ? 'Unmute' : 'Mute'}
      </button>

      <button
        type="button"
        data-testid="av-toggle-cam"
        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[0.6875rem] font-medium whitespace-nowrap transition-all shadow-sm disabled:cursor-not-allowed disabled:opacity-40 ${
          !av.local.camOn
            ? 'border border-slate-700/80 bg-slate-800/60 text-slate-400 hover:bg-slate-700/80 hover:text-slate-200'
            : 'border border-slate-700/80 bg-slate-800/90 text-slate-200 hover:border-slate-600 hover:bg-slate-700/90 hover:text-white'
        }`}
        onClick={av.toggleCamera}
        disabled={inert}
      >
        <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          {!av.local.camOn && <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />}
        </svg>
        {av.local.camOn ? 'Camera off' : 'Camera on'}
      </button>

      <button
        type="button"
        data-testid="av-toggle-screen"
        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[0.6875rem] font-medium whitespace-nowrap transition-all shadow-sm disabled:cursor-not-allowed disabled:opacity-40 ${
          av.local.isScreenSharing
            ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
            : 'border border-slate-700/80 bg-slate-800/90 text-slate-200 hover:border-slate-600 hover:bg-slate-700/90 hover:text-white'
        }`}
        onClick={() => void av.toggleScreenShare()}
        disabled={inert}
      >
        <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        {av.local.isScreenSharing ? 'Stop sharing' : 'Share screen'}
      </button>
    </div>
  );
}
