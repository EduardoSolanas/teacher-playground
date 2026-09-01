'use client';

import { useEffect, useRef, useState } from 'react';

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
export default function SupportButton() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const email = supportEmail();
  if (!email) return null;

  return (
    <div
      ref={rootRef}
      className="fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] right-[max(0.75rem,env(safe-area-inset-right))] z-[1400]"
    >
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
              type="button"
              data-testid="whiteboard-support-close"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="-mt-1 cursor-pointer border-none bg-transparent px-1 text-[1.25rem] leading-none text-slate-400 hover:text-slate-100"
            >
              &times;
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

      <button
        type="button"
        data-testid="whiteboard-support-btn"
        onClick={() => setOpen((current) => !current)}
        aria-label="Contact support"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Contact support"
        className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-[0.9375rem] font-semibold text-slate-300 shadow-lg shadow-slate-950/30 transition-colors hover:bg-slate-800 hover:text-slate-100"
      >
        ?
      </button>
    </div>
  );
}
