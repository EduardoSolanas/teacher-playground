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
    <div className="modal-overlay">
      <form
        data-testid="guest-join-prompt"
        onSubmit={handleSubmit}
        className="modal-card"
      >
        <h2 className="modal-title">Join class</h2>
        <p className="modal-text">
          Enter your name and the PIN your teacher gave you.
        </p>
        <label className="field-block">
          <span className="app-label">Your name</span>
          <input
            data-testid="guest-join-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            autoComplete="off"
            className="field-input"
          />
        </label>
        <label className="field-block">
          <span className="app-label">Class PIN</span>
          <input
            data-testid="guest-join-pin"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
            className="field-input field-pin"
          />
        </label>
        {error && (
          <p
            data-testid="guest-join-error"
            role="alert"
            className="app-error"
          >
            {GUEST_PIN_ERROR}
          </p>
        )}
        {retrying && (
          <p data-testid="guest-join-retry-hint" className="app-small">
            Please wait a few minutes before trying again.
          </p>
        )}
        <button
          data-testid="guest-join-submit"
          type="submit"
          disabled={retrying || submitting || !normalizeGuestName(name) || pin.length !== 6}
          className="btn btn-block"
        >
          Continue
        </button>
      </form>
    </div>
  );
}
