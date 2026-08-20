'use client';

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
  const lockedOut = typeof lockoutUntil === 'number' && lockoutUntil > Date.now();
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
          <p className="text-[13px] font-semibold text-slate-600">Student join link</p>
          <p
            data-testid="guest-join-url"
            className="mt-1 break-all rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-800"
          >
            {guestJoinUrl}
          </p>
          <p className="mt-1 text-[12px] text-slate-500">
            Share this guest-host link, not the teacher URL.
          </p>
        </div>
      )}

      {lockedOut && (
        <div
          data-testid="guest-lockout"
          className="rounded-xl bg-amber-50 px-3 py-2.5 text-[13px] font-medium text-amber-900 ring-1 ring-amber-200"
          role="status"
        >
          Guest join is locked after too many PIN attempts. Rotate the PIN so the class can try again.
          <button
            type="button"
            data-testid="guest-rotate-pin"
            onClick={onRotate}
            className="mt-2 block h-11 w-full rounded-xl bg-amber-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-amber-800"
          >
            Rotate PIN
          </button>
        </div>
      )}

      {guestAccess ? (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-semibold text-slate-600">Class PIN</p>
          <p
            data-testid="guest-pin"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-2xl tracking-[0.35em] text-slate-900"
          >
            {guestPin}
          </p>
          {expiryLabel && (
            <p className="text-[12px] text-slate-500">Expires {expiryLabel}</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            {!lockedOut && (
              <button
                type="button"
                data-testid="guest-rotate-pin"
                onClick={onRotate}
                className="h-11 flex-1 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100"
              >
                Rotate PIN
              </button>
            )}
            <button
              type="button"
              data-testid="guest-disable"
              onClick={onDisable}
              className="h-11 flex-1 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
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
          className="h-11 rounded-xl bg-indigo-500 px-4 text-sm font-semibold text-white transition-colors hover:bg-indigo-600"
        >
          Allow students to join with a PIN
        </button>
      )}
    </div>
  );
}
