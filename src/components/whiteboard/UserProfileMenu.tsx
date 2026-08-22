'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import { completeSignOut } from '@/lib/identity/completeSignOut';

/**
 * The trigger's default skin is tuned for the rooms-list header, which sits on
 * a dark band. Floating it over the whiteboard's light canvas needs the dark
 * pill the other in-room controls use, so the caller can override it.
 */
const DEFAULT_TRIGGER_CLASS =
  'inline-flex h-11 max-w-[min(100%,16rem)] shrink-0 items-center gap-2 rounded-xl border border-white/30 bg-white/10 px-3 text-sm font-semibold text-white backdrop-blur-md transition-colors hover:bg-white/20 active:bg-white/25 sm:px-4';

export function UserProfileMenu({
  displayName,
  onDisplayNameChange,
  triggerClassName = DEFAULT_TRIGGER_CLASS,
  showDisplayName = true,
}: {
  displayName: string | null;
  onDisplayNameChange: (name: string) => void;
  triggerClassName?: string;
  showDisplayName?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [draftName, setDraftName] = useState(displayName ?? '');
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const label = displayName?.trim() || 'Account';

  useEffect(() => {
    setDraftName(displayName ?? '');
  }, [displayName]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setEditing(false);
        setDeleting(false);
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleSignOut = async () => {
    await completeSignOut({
      logout: () => ajaxFetch('/auth/session/logout', { method: 'POST' }),
      navigate: (path) => {
        window.location.assign(path);
      },
    });
  };

  const handleSaveName = async () => {
    const next = draftName.trim();
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      const response = await ajaxFetch('/auth/account/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: next }),
      });
      if (!response.ok) throw new Error('Could not save name');
      const body: unknown = await response.json();
      const saved = body && typeof body === 'object'
        ? (body as { displayName?: unknown }).displayName
        : next;
      const name = typeof saved === 'string' ? saved : next;
      try {
        window.localStorage.setItem('whiteboard_username', name);
      } catch {
        // localStorage unavailable
      }
      onDisplayNameChange(name);
      setEditing(false);
      setOpen(false);
    } catch {
      setError('Could not save your name. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const eraseAccount = async (): Promise<Response> => ajaxFetch('/auth/account', { method: 'DELETE' });

  const handleDelete = async () => {
    if (confirmText !== 'DELETE') return;
    setBusy(true);
    setError(null);
    try {
      let response = await eraseAccount();
      if (response.status === 403) {
        const confirm = await ajaxFetch('/auth/session/confirm', { method: 'POST' });
        if (!confirm.ok) throw new Error('reauth');
        response = await eraseAccount();
      }
      if (!response.ok) throw new Error('erase');
      router.replace('/');
    } catch {
      setError('Could not delete this account. Try again.');
      setBusy(false);
    }
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        data-testid="whiteboard-profile-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={labelId}
        aria-label={`Open profile for ${label}`}
        onClick={() => {
          setOpen((current) => !current);
          setEditing(false);
          setDeleting(false);
          setError(null);
        }}
        className={triggerClassName}
      >
        <span
          aria-hidden="true"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/20 text-[0.6875rem] font-bold tracking-wide"
        >
          {label.slice(0, 1).toUpperCase()}
        </span>
        {showDisplayName && <span className="truncate">{label}</span>}
      </button>

      {open && (
        <div
          id={labelId}
          role="menu"
          className="absolute right-0 z-30 mt-2 w-64 overflow-hidden rounded-2xl bg-white text-slate-900 shadow-[0_1.125rem_3.125rem_rgba(15,23,42,0.28)] ring-1 ring-slate-200"
        >
          {!editing && !deleting && (
            <div className="p-1.5">
              <p className="truncate px-3 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-slate-400">
                Profile
              </p>
              <button
                type="button"
                role="menuitem"
                data-testid="whiteboard-profile-edit-name"
                onClick={() => {
                  setEditing(true);
                  setError(null);
                }}
                className="flex w-full items-center rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-800 hover:bg-slate-50"
              >
                Change name
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="whiteboard-logout-btn"
                onClick={() => {
                  void handleSignOut();
                }}
                className="flex w-full items-center rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-800 hover:bg-slate-50"
              >
                Sign out
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="whiteboard-profile-delete"
                onClick={() => {
                  setDeleting(true);
                  setConfirmText('');
                  setError(null);
                }}
                className="flex w-full items-center rounded-xl px-3 py-2.5 text-left text-sm font-medium text-red-700 hover:bg-red-50"
              >
                Delete account
              </button>
            </div>
          )}

          {editing && (
            <form
              className="p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSaveName();
              }}
            >
              <label htmlFor="whiteboard-profile-name" className="block text-[0.8125rem] font-semibold text-slate-600">
                Display name
              </label>
              <input
                id="whiteboard-profile-name"
                data-testid="whiteboard-profile-name-input"
                value={draftName}
                maxLength={100}
                onChange={(event) => setDraftName(event.target.value)}
                className="mt-1.5 h-11 w-full rounded-xl border-2 border-slate-200 px-3 text-sm text-slate-900 outline-none focus:border-indigo-500"
              />
              {error && <p role="alert" className="mt-2 text-[0.75rem] font-medium text-red-700">{error}</p>}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="h-10 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-testid="whiteboard-profile-name-save"
                  disabled={busy || !draftName.trim()}
                  className="h-10 flex-1 rounded-xl bg-slate-900 text-sm font-semibold text-white disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </form>
          )}

          {deleting && (
            <form
              className="p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              <p className="text-sm font-semibold text-slate-900">Delete this account?</p>
              <p className="mt-1 text-[0.8125rem] leading-relaxed text-slate-500">
                Rooms you own will be removed. Type DELETE to confirm.
              </p>
              <input
                data-testid="whiteboard-profile-delete-confirm-input"
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
                autoComplete="off"
                className="mt-3 h-11 w-full rounded-xl border-2 border-slate-200 px-3 text-sm text-slate-900 outline-none focus:border-red-500"
              />
              {error && <p role="alert" className="mt-2 text-[0.75rem] font-medium text-red-700">{error}</p>}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setDeleting(false)}
                  className="h-10 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-testid="whiteboard-profile-delete-confirm"
                  disabled={busy || confirmText !== 'DELETE'}
                  className="h-10 flex-1 rounded-xl bg-red-700 text-sm font-semibold text-white disabled:opacity-40"
                >
                  Delete
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
