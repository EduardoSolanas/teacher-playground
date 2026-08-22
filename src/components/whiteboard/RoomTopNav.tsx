'use client';

import { useEffect, useState } from 'react';
import { isGuestHostname } from '@/lib/guest/guestHost';
import BackToRoomsLink from './BackToRoomsLink';
import { UserProfileMenu } from './UserProfileMenu';

export default function RoomTopNav({
  displayName,
  onDisplayNameChange,
  onNavigate,
  rosterExpanded,
}: {
  displayName: string | null;
  onDisplayNameChange: (name: string) => void;
  onNavigate?: () => void;
  rosterExpanded: boolean;
}) {
  const [showNav, setShowNav] = useState(false);

  useEffect(() => {
    setShowNav(!isGuestHostname(window.location.hostname));
  }, []);

  if (!showNav) return null;

  return (
    <nav
      aria-label="Room navigation"
      data-testid="whiteboard-room-top-nav"
      className={`fixed inset-x-0 top-0 z-[1100] flex h-[calc(3rem+env(safe-area-inset-top))] items-center justify-between border-b border-slate-700/80 bg-slate-900/95 pt-[env(safe-area-inset-top)] text-slate-200 shadow-lg shadow-slate-950/20 backdrop-blur-md sm:left-16 ${rosterExpanded ? 'sm:right-[13.75rem]' : 'sm:right-0'}`}
    >
      <BackToRoomsLink embedded onNavigate={onNavigate} />
      <div className="flex h-full items-center pr-[max(0.5rem,env(safe-area-inset-right))]">
        <UserProfileMenu
          displayName={displayName}
          onDisplayNameChange={onDisplayNameChange}
          showDisplayName={false}
          triggerClassName="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-600 bg-slate-800 text-sm font-semibold text-slate-100 transition-colors hover:border-slate-400 hover:bg-slate-700 active:bg-slate-600"
        />
      </div>
    </nav>
  );
}
