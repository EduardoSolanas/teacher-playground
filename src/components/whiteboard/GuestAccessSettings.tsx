'use client';

import { useEffect, useState } from 'react';

import { isGuestJoinLockedOut } from '@/lib/whiteboard/guestPin';

export default function GuestAccessSettings({
  roomId,
  guestJoinUrl,
  guestAccess,
  guestPin,
  guestPinExpiresAt,
  lockoutUntil,
  onEnable,
  onDisable,
  onRotate,
  showJoinUrl = true,
}: {
  roomId: string;
  guestJoinUrl: string;
  guestAccess: boolean;
  guestPin: string | null;
  guestPinExpiresAt: number | null;
  lockoutUntil: number | null;
  onEnable: () => void;
  onDisable: () => void;
  onRotate: () => void;
  showJoinUrl?: boolean;
}) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);
  const lockedOut = now !== null && isGuestJoinLockedOut(lockoutUntil, now);
  const expiryLabel = guestPinExpiresAt
    ? new Date(guestPinExpiresAt).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    : null;

  return (
    <div className="flex flex-col gap-3 p-1" data-testid={`guest-access-settings-${roomId}`}>
      {showJoinUrl && (
        <div>
          <p className="text-[13px] font-semibold text-[var(--ink2)]">Student join link</p>
          <p
            data-testid="guest-join-url"
            className="mt-1 break-all rounded-[2px] border border-[var(--line)] bg-white px-3 py-2 text-[13px] text-[var(--ink)]"
          >
            {guestJoinUrl}
          </p>
          <p className="mt-1 text-[12px] text-[var(--mut)]">
            Share this guest-host link, not the teacher URL.
          </p>
        </div>
      )}

      {lockedOut && (
        <div
          data-testid="guest-lockout"
          className="rounded-[2px] bg-[var(--paper2)] px-3 py-2.5 text-[13px] font-medium text-[var(--ink)] ring-1 ring-[var(--rule)]"
          role="status"
        >
          Guest join is locked after too many PIN attempts. Rotate the PIN so the class can try again.
          <button
            type="button"
            data-testid="guest-rotate-pin"
            onClick={onRotate}
            className="mt-2 block h-11 w-full rounded-[2px] bg-[var(--blue)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[var(--blue-d)]"
          >
            Rotate PIN
          </button>
        </div>
      )}

      {guestAccess ? (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-semibold text-[var(--ink2)]">Class PIN</p>
          <p
            data-testid="guest-pin"
            className="rounded-[2px] border border-[var(--line)] bg-white px-3 py-2 font-mono text-2xl tracking-[0.35em] text-[var(--ink)]"
          >
            {guestPin}
          </p>
          {expiryLabel && (
            <p className="text-[12px] text-[var(--mut)]">Expires {expiryLabel}</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            {!lockedOut && (
              <button
                type="button"
                data-testid="guest-rotate-pin"
                onClick={onRotate}
                className="h-11 flex-1 rounded-[2px] border border-[var(--line)] bg-white px-4 text-sm font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--paper2)]"
              >
                Rotate PIN
              </button>
            )}
            <button
              type="button"
              data-testid="guest-disable"
              onClick={onDisable}
              className="h-11 flex-1 rounded-[2px] border border-[var(--line)] bg-white px-4 text-sm font-medium text-[var(--ink2)] transition-colors hover:bg-[var(--paper2)]"
            >
              Turn off guest join
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="guest-enable"
          onClick={onEnable}
          className="h-11 rounded-[2px] bg-[var(--blue)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[var(--blue-d)]"
        >
          Allow students to join with a PIN
        </button>
      )}
    </div>
  );
}
