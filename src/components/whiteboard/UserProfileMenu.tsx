'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import { completeSignOut } from '@/lib/identity/completeSignOut';
import type { PlanId } from '@/lib/plan/catalog';
import type { EntitlementStatus } from '@/lib/plan/effectivePlan';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

/**
 * The trigger's default skin is tuned for the rooms-list header, which sits on
 * a dark band. Floating it over the whiteboard's light canvas needs the dark
 * pill the other in-room controls use, so the caller can override it.
 */
const DEFAULT_TRIGGER_CLASS =
  'inline-flex h-11 max-w-[min(100%,16rem)] shrink-0 items-center gap-2 rounded-xl border border-white/30 bg-white/10 px-3 text-sm font-semibold text-white backdrop-blur-md transition-colors hover:bg-white/20 active:bg-white/25 sm:px-4';

export interface UserProfilePlan {
  planId: PlanId;
  status: EntitlementStatus;
  graceUntil?: number | null;
  collectionPaused?: boolean;
}

export interface UserProfileCompany {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
}

const PLAN_NAMES: Record<PlanId, string> = {
  free: 'Free',
  tutor_pro_monthly: 'Tutor Pro',
  tutor_pro_annual: 'Tutor Pro',
  corporate_seat: 'Corporate seat',
};

const UPGRADE_PLAN_ID: PlanId = 'tutor_pro_monthly';

export function UserProfileMenu({
  displayName,
  onDisplayNameChange,
  triggerClassName = DEFAULT_TRIGGER_CLASS,
  showDisplayName = true,
  plan = null,
  company = null,
  request = ajaxFetch,
  navigate = (url: string) => {
    window.location.assign(url);
  },
}: {
  displayName: string | null;
  onDisplayNameChange: (name: string) => void;
  triggerClassName?: string;
  showDisplayName?: boolean;
  plan?: UserProfilePlan | null;
  company?: UserProfileCompany | null;
  request?: AjaxFetch;
  navigate?: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [draftName, setDraftName] = useState(displayName ?? '');
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const label = displayName?.trim() || 'Account';
  // The menu role is only true while menu items are what the container holds.
  // The name and delete forms replace them, and a role="menu" wrapping a form
  // promises arrow-key navigation over children that are not menu items.
  const showMenuItems = !editing && !deleting;

  useEffect(() => {
    setDraftName(displayName ?? '');
  }, [displayName]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setEditing(false);
        setDeleting(false);
        /*
         * The menu promised focus-within, so closing it has to give focus
         * back. Without this Escape dropped focus on the body and keyboard
         * users lost their place in the header.
         */
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /* Focus enters with the menu, the way `role="menu"` says it will. */
  useEffect(() => {
    if (!open || !showMenuItems) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, showMenuItems]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!showMenuItems) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(current + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(current - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      setEditing(false);
      setDeleting(false);
      triggerRef.current?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
      setEditing(false);
      setDeleting(false);
    }
  };

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
      navigate('/');
    } catch {
      setError('Could not delete this account. Try again.');
      setBusy(false);
    }
  };

  const startBilling = async (path: string, body: Record<string, unknown> = {}) => {
    setBillingError(null);
    try {
      const response = await request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, operationId: crypto.randomUUID() }),
      });
      if (!response.ok) throw new Error('billing');
      const parsed: unknown = await response.json();
      const url = parsed && typeof parsed === 'object'
        ? (parsed as { url?: unknown }).url
        : undefined;
      if (typeof url !== 'string' || url.length === 0) throw new Error('billing');
      navigate(url);
    } catch {
      setBillingError('Could not open billing. Try again.');
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="whiteboard-profile-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? labelId : undefined}
        aria-label={`Open profile for ${label}`}
        title={label}
        onClick={() => {
          setOpen((current) => !current);
          setEditing(false);
          setDeleting(false);
          setError(null);
          setBillingError(null);
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
          ref={menuRef}
          id={labelId}
          role={showMenuItems ? 'menu' : undefined}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 z-30 mt-2 w-64 overflow-hidden rounded-xl border border-slate-700 bg-slate-800 text-slate-200 shadow-xl shadow-slate-950/40"
        >
          {!editing && !deleting && plan && (
            <div className="border-b border-slate-700 p-1.5">
              <p className="truncate px-3 py-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400">
                Plan
              </p>
              <p
                data-testid="whiteboard-profile-plan"
                className="truncate px-3 pb-1 text-sm font-medium text-slate-100"
              >
                {PLAN_NAMES[plan.planId]}
              </p>
              {company && (
                <p
                  data-testid="whiteboard-profile-company"
                  className="truncate px-3 pb-1 text-[0.75rem] text-slate-400"
                >
                  {company.name} · {company.role}
                </p>
              )}
              {plan.status === 'past_due' && typeof plan.graceUntil === 'number' && (
                <p
                  data-testid="whiteboard-profile-plan-grace"
                  className="px-3 pb-1 text-[0.75rem] font-medium text-amber-400"
                >
                  payment overdue until {new Date(plan.graceUntil).toLocaleDateString()}
                </p>
              )}
              {plan.collectionPaused === true && (
                <p
                  data-testid="whiteboard-profile-plan-hold"
                  className="px-3 pb-1 text-[0.75rem] font-medium text-amber-400"
                >
                  billing on hold
                </p>
              )}
              {plan.planId === 'free' ? (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="whiteboard-profile-plan-upgrade"
                  onClick={() => {
                    void startBilling('/api/billing/checkout', { planId: UPGRADE_PLAN_ID });
                  }}
                  className="flex w-full items-center rounded-md px-3 py-2.5 text-left text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700"
                >
                  Upgrade
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="whiteboard-profile-plan-manage"
                  onClick={() => {
                    void startBilling('/api/billing/portal');
                  }}
                  className="flex w-full items-center rounded-md px-3 py-2.5 text-left text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700"
                >
                  Manage
                </button>
              )}
              {billingError && (
                <p
                  role="alert"
                  data-testid="whiteboard-profile-plan-error"
                  className="px-3 pb-1 text-[0.75rem] font-medium text-red-400"
                >
                  {billingError}
                </p>
              )}
            </div>
          )}

          {!editing && !deleting && (
            <div className="p-1.5">
              <p className="truncate px-3 py-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400">
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
                className="flex w-full items-center rounded-md px-3 py-2.5 text-left text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700"
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
                className="flex w-full items-center rounded-md px-3 py-2.5 text-left text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700"
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
                className="flex w-full items-center rounded-md px-3 py-2.5 text-left text-sm font-medium text-red-400 transition-colors hover:bg-red-500/15"
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
              <label htmlFor="whiteboard-profile-name" className="block text-[0.8125rem] font-semibold text-slate-300">
                Display name
              </label>
              <input
                id="whiteboard-profile-name"
                data-testid="whiteboard-profile-name-input"
                value={draftName}
                maxLength={100}
                onChange={(event) => setDraftName(event.target.value)}
                className="mt-1.5 h-11 w-full rounded-md border border-slate-600 bg-slate-900 px-3 text-sm text-slate-100"
              />
              {error && <p role="alert" className="mt-2 text-[0.75rem] font-medium text-red-400">{error}</p>}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="h-10 flex-1 rounded-md border border-slate-600 text-sm font-semibold text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-testid="whiteboard-profile-name-save"
                  disabled={busy || !draftName.trim()}
                  className="h-10 flex-1 rounded-md bg-slate-700 text-sm font-semibold text-white transition-colors hover:bg-slate-600 disabled:opacity-50"
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
              <p className="text-sm font-semibold text-slate-100">Delete this account?</p>
              <p className="mt-1 text-[0.8125rem] leading-relaxed text-slate-400">
                Rooms you own will be removed. Type DELETE to confirm.
              </p>
              <input
                data-testid="whiteboard-profile-delete-confirm-input"
                aria-label="Type DELETE to confirm"
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
                autoComplete="off"
                className="mt-3 h-11 w-full rounded-md border border-slate-600 bg-slate-900 px-3 text-sm text-slate-100"
              />
              {error && <p role="alert" className="mt-2 text-[0.75rem] font-medium text-red-400">{error}</p>}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setDeleting(false)}
                  className="h-10 flex-1 rounded-md border border-slate-600 text-sm font-semibold text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-testid="whiteboard-profile-delete-confirm"
                  disabled={busy || confirmText !== 'DELETE'}
                  className="h-10 flex-1 rounded-md bg-red-700 text-sm font-semibold text-white disabled:opacity-40"
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
