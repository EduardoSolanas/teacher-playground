'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { isGuestHostname } from '@/lib/guest/guestHost';

export default function BackToRoomsLink({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  // "Back to rooms" is a teacher affordance: it goes to /whiteboard, which is
  // teacher-host-only and 404s on the guest hostname. Guests have no room list
  // and must not be offered one.
  //
  // Starts hidden and reveals after mount rather than the reverse. The check
  // needs `window`, so it cannot run during the static export; showing the link
  // first would flash a dead control at a student, which matters more than the
  // imperceptible delay it costs a teacher.
  const [showLink, setShowLink] = useState(false);
  useEffect(() => {
    setShowLink(!isGuestHostname(window.location.hostname));
  }, []);

  if (!showLink) return null;

  return (
    <Link
      href="/whiteboard"
      data-testid="whiteboard-back-to-rooms"
      onClick={(event) => {
        if (!onNavigate) return;
        event.preventDefault();
        onNavigate();
      }}
      className="fixed left-[max(0.5rem,env(safe-area-inset-left))] top-[max(0.5rem,env(safe-area-inset-top))] z-[1100] inline-flex h-11 items-center gap-1.5 rounded-xl border border-slate-700/80 bg-slate-900/95 pl-2.5 pr-3.5 text-[13px] font-medium text-slate-200 no-underline shadow-lg shadow-slate-950/30 backdrop-blur-md transition-colors hover:bg-slate-800 hover:text-white active:bg-slate-700"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4 shrink-0"
      >
        <path d="m15 18-6-6 6-6" />
      </svg>
      Back to rooms
    </Link>
  );
}
