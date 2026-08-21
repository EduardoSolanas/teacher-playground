'use client';

import { useEffect, useState } from 'react';
import { isGuestHostname } from '@/lib/guest/guestHost';
import { UserProfileMenu } from './UserProfileMenu';

/**
 * The account control for inside a room.
 *
 * Without it a room showed no sign of which account you were in and offered no
 * way out of it — you had to go back to the room list to sign out, which reads
 * as being only half signed in.
 *
 * Guests are excluded for the same reason BackToRoomsLink excludes them: every
 * item in the menu (change name, sign out, delete account) acts on a teacher
 * account a guest does not have. Detection needs `window`, so it starts hidden
 * and reveals after mount rather than flashing a dead control at a student.
 */
export default function RoomAccountMenu({
  displayName,
  onDisplayNameChange,
  rosterExpanded,
}: {
  displayName: string | null;
  onDisplayNameChange: (name: string) => void;
  /** Whether the roster rail is on screen, so the menu can clear it. */
  rosterExpanded: boolean;
}) {
  const [showMenu, setShowMenu] = useState(false);
  useEffect(() => {
    setShowMenu(!isGuestHostname(window.location.hostname));
  }, []);

  if (!showMenu) return null;

  // Mirrors the canvas, which is itself inset by the roster's 13.75rem column.
  // Anchored to the viewport edge instead, the menu would sit under the roster.
  // Screens with no roster at all (name prompt, waiting room, loading) pass
  // false and get the full width.
  const rightEdge = rosterExpanded ? 'sm:right-[14.25rem]' : 'sm:right-3';

  return (
    <div
      data-testid="whiteboard-room-account"
      className={`fixed right-[max(0.5rem,env(safe-area-inset-right))] top-[max(0.5rem,env(safe-area-inset-top))] z-[1100] ${rightEdge}`}
    >
      <UserProfileMenu
        displayName={displayName}
        onDisplayNameChange={onDisplayNameChange}
        triggerClassName="inline-flex h-11 max-w-[12rem] shrink-0 items-center gap-2 rounded-xl border border-slate-700/80 bg-slate-900/95 px-2.5 text-[0.8125rem] font-medium text-slate-200 shadow-lg shadow-slate-950/30 backdrop-blur-md transition-colors hover:bg-slate-800 hover:text-white active:bg-slate-700"
      />
    </div>
  );
}
