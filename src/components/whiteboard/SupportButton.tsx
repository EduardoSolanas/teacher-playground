'use client';

import { useEffect, useRef, useState } from 'react';
import { CALL_RAIL_WIDTH } from '@/lib/av/callRail';

/**
 * Where a teacher's question goes, from configuration rather than from here.
 *
 * The repository's own scan refuses any real address in a tracked file, and it
 * is right to: an address in source is one that cannot be changed without a
 * deploy, and it is scraped from a public repository the moment it lands. This
 * follows the same NEXT_PUBLIC_ path the guest hostname already takes.
 *
 * Unset means no button. A "?" that opens a panel with nowhere to write is
 * worse than no "?" at all.
 */
export function supportEmail(): string {
  return process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? '';
}

/**
 * The one "?" in the room, and it reaches a person.
 *
 * There were three before: Excalidraw's help dialog, its Help menu item, and
 * this application's own shortcuts sheet. All three answered a question nobody
 * in a lesson is asking. Somebody pressing "?" while a class is waiting wants
 * help, not a table of accelerators -- so this is the only one left, and it
 * offers an address.
 */
export default function SupportButton({
  rosterExpanded = false,
  callRailOpen = false,
}: {
  readonly rosterExpanded?: boolean;
  /** The docked call rail owns the right edge; the pill must clear it. */
  readonly callRailOpen?: boolean;
} = {}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      // Clicking away moves focus where the click landed; only an explicit
      // close hands focus back to the trigger.
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  /*
   * `role="dialog"` promises focus enters it, and Tab has to be able to reach
   * the address: the panel used to be rendered before its trigger, so a
   * keyboard user tabbing from the trigger skipped the panel entirely. Focus
   * moves to the close control on open and back to the trigger on close.
   */
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  const email = supportEmail();
  if (!email) return null;

  return (
    <div
      ref={rootRef}
      data-testid="whiteboard-support-container"
      style={callRailOpen
        ? { right: `calc(${CALL_RAIL_WIDTH} + max(0.75rem, env(safe-area-inset-right)))` }
        : undefined}
      className={`fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[1050] transition-all duration-150 ${
        callRailOpen
          ? 'max-sm:hidden'
          : rosterExpanded
            ? 'max-sm:hidden sm:right-[calc(13.75rem+max(0.75rem,env(safe-area-inset-right)))]'
            : 'right-[max(0.75rem,env(safe-area-inset-right))]'
      }`}
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid="whiteboard-support-btn"
        onClick={() => setOpen((current) => !current)}
        aria-label="Contact support"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Contact support"
        className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-slate-300 shadow-lg shadow-slate-950/30 transition-colors hover:bg-slate-800 hover:text-slate-100"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M9.4 9.2a2.7 2.7 0 0 1 5.2 1c0 1.7-2.6 2-2.6 3.6" />
          <path d="M12 17h.01" />
        </svg>
      </button>

      {open && (
        <div
          data-testid="whiteboard-support-panel"
          role="dialog"
          aria-label="Contact support"
          className="absolute bottom-full right-0 mb-2 w-64 rounded-xl border border-slate-700 bg-slate-900 p-4 text-slate-200 shadow-xl shadow-slate-950/40"
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <h2 className="m-0 text-[0.9375rem] font-semibold">Need help?</h2>
            <button
              ref={closeRef}
              type="button"
              data-testid="whiteboard-support-close"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              aria-label="Close"
              className="-mt-1 inline-flex cursor-pointer items-center border-none bg-transparent px-1 text-slate-400 hover:text-slate-100"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <p className="m-0 mb-3 text-[0.8125rem] text-slate-400">
            Tell us what happened and we will come back to you.
          </p>
          <a
            data-testid="whiteboard-support-email"
            href={`mailto:${email}`}
            className="block break-all rounded-lg border border-slate-700 px-3 py-2 text-[0.8125rem] font-medium text-blue-300 transition-colors hover:border-blue-400 hover:text-blue-200"
          >
            {email}
          </a>
        </div>
      )}
    </div>
  );
}
