'use client';

import { useEffect, useState } from 'react';

import { isGuestJoinLockedOut } from '@/lib/whiteboard/guestPin';
import CopyButton from './CopyButton';

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
    <div className="guest-settings" data-testid={`guest-access-settings-${roomId}`}>
      {showJoinUrl && (
        <div>
          <p className="app-label">Student join link</p>
          <div className="copy-field nudge-top">
            <p
              data-testid="guest-join-url"
              className="guest-url-box"
            >
              {guestJoinUrl}
            </p>
            <CopyButton value={guestJoinUrl} label="student join link" />
          </div>
          <p className="app-small">
            Share this guest-host link, not the teacher URL.
          </p>
        </div>
      )}

      {lockedOut && (
        <div
          data-testid="guest-lockout"
          className="callout"
          role="status"
        >
          Guest join is locked after too many PIN attempts. Rotate the PIN so the class can try again.
          <button
            type="button"
            data-testid="guest-rotate-pin"
            onClick={onRotate}
            className="btn btn-block"
          >
            Rotate PIN
          </button>
        </div>
      )}

      {guestAccess ? (
        <div className="guest-fields">
          <p className="app-label">Class PIN</p>
          <div className="copy-field">
            <p
              data-testid="guest-pin"
              className="guest-pin"
            >
              {guestPin}
            </p>
            <CopyButton value={guestPin ?? ''} label="class PIN" />
          </div>
          {expiryLabel && (
            <p className="app-small">Expires {expiryLabel}</p>
          )}
          <div className="btn-gap">
            {!lockedOut && (
              <button
                type="button"
                data-testid="guest-rotate-pin"
                onClick={onRotate}
                className="btn-outline btn-grow"
              >
                Rotate PIN
              </button>
            )}
            <button
              type="button"
              data-testid="guest-disable"
              onClick={onDisable}
              className="btn-outline btn-grow"
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
          className="btn btn-block flush-top"
        >
          Allow students to join with a PIN
        </button>
      )}
    </div>
  );
}
