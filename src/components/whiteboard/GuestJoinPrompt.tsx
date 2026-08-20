'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import { MAX_NAME_LENGTH, stripAsciiControls } from '@/lib/whiteboard/requestSchemas';

export const GUEST_PIN_ERROR = "That PIN didn't work. Check with your teacher and try again.";
export const GUEST_RETRY_MS = 180_000;

function normalizeGuestName(value: string): string {
  return stripAsciiControls(value).slice(0, MAX_NAME_LENGTH);
}

export default function GuestJoinPrompt({
  roomId,
  onJoined,
  retryMs = GUEST_RETRY_MS,
}: {
  roomId: string;
  onJoined: (displayName: string) => void;
  retryMs?: number;
}) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current !== undefined) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  const startRetryWait = () => {
    setError(true);
    setRetrying(true);
    if (retryTimerRef.current !== undefined) {
      clearTimeout(retryTimerRef.current);
    }
    retryTimerRef.current = setTimeout(() => {
      setRetrying(false);
      retryTimerRef.current = undefined;
    }, retryMs);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (retrying || submitting) return;

    const displayName = normalizeGuestName(name);
    if (!displayName) return;
    if (!/^\d{6}$/.test(pin)) return;

    setSubmitting(true);
    try {
      const response = await ajaxFetch('/auth/guest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId, pin, displayName }),
      });
      if (!response.ok) {
        startRetryWait();
        return;
      }
      setError(false);
      onJoined(displayName);
    } catch {
      startRetryWait();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/60 z-[1000]">
      <form
        data-testid="guest-join-prompt"
        onSubmit={handleSubmit}
        className="bg-white rounded-xl p-8 min-w-[320px] shadow-xl"
      >
        <h2 className="m-0 mb-2 text-xl">Join class</h2>
        <p className="m-0 mb-4 text-slate-500 text-sm">
          Enter your name and the PIN your teacher gave you.
        </p>
        <label className="block mb-4">
          <span className="block text-xs text-slate-500 uppercase tracking-wider mb-1">Your name</span>
          <input
            data-testid="guest-join-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            autoComplete="off"
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm box-border"
          />
        </label>
        <label className="block mb-4">
          <span className="block text-xs text-slate-500 uppercase tracking-wider mb-1">Class PIN</span>
          <input
            data-testid="guest-join-pin"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm box-border tracking-[0.3em]"
          />
        </label>
        {error && (
          <p
            data-testid="guest-join-error"
            role="alert"
            className="m-0 mb-4 text-sm text-red-600"
          >
            {GUEST_PIN_ERROR}
          </p>
        )}
        {retrying && (
          <p data-testid="guest-join-retry-hint" className="m-0 mb-4 text-sm text-slate-500">
            Please wait a few minutes before trying again.
          </p>
        )}
        <button
          data-testid="guest-join-submit"
          type="submit"
          disabled={retrying || submitting || !normalizeGuestName(name) || pin.length !== 6}
          className="w-full px-0 py-2.5 rounded-lg border-none text-white text-sm font-semibold cursor-pointer transition-colors duration-150 disabled:cursor-not-allowed"
          style={{
            background: retrying || submitting || !normalizeGuestName(name) || pin.length !== 6
              ? '#ccc'
              : '#3498db',
          }}
        >
          Continue
        </button>
      </form>
    </div>
  );
}
