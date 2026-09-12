'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';
import CopyButton from '@/components/whiteboard/CopyButton';
import InertConfirmDialog from './InertConfirmDialog';
import {
  parseCompanySummary,
  readInviteToken,
  readMintedToken,
  type CompanySummary,
} from './companySummary';

type DestructiveActionId = 'transfer' | 'rename' | 'disable';

const DESTRUCTIVE_ACTIONS: Record<
  DestructiveActionId,
  { title: string; body: string; confirmLabel: string; note: string }
> = {
  transfer: {
    title: 'Transfer ownership',
    body: 'Ownership moves to another admin, who becomes the owner. The current owner becomes an admin.',
    confirmLabel: 'Transfer ownership',
    note: 'Transfer is not available from this page yet.',
  },
  rename: {
    title: 'Rename company',
    body: 'The new name appears on invoices and on every member’s plan.',
    confirmLabel: 'Rename company',
    note: 'Renaming is not available from this page yet.',
  },
  disable: {
    title: 'Disable company',
    body: 'Every member loses their company seat. Rooms and boards are not deleted.',
    confirmLabel: 'Disable company',
    note: 'Disabling is not available from this page yet.',
  },
};

export default function CompanyAdminPanel({
  request = ajaxFetch,
}: {
  request?: AjaxFetch;
} = {}) {
  const [summary, setSummary] = useState<CompanySummary | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refused, setRefused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [inviteToken, setInviteToken] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : readInviteToken(window.location.hash),
  );
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');
  const [minting, setMinting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [seatBusy, setSeatBusy] = useState(false);
  const [seatError, setSeatError] = useState<string | null>(null);
  const [seatStatus, setSeatStatus] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<DestructiveActionId | null>(null);

  const refreshSummary = useCallback(async () => {
    try {
      const response = await request('/api/company');
      if (!response.ok) {
        setSeatError('Could not refresh the seat change. Try again.');
        return;
      }
      const parsed = parseCompanySummary(await response.json());
      if (parsed === null) {
        setSeatError('Could not refresh the seat change. Try again.');
        return;
      }
      setSummary(parsed);
    } catch {
      setSeatError('Could not refresh the seat change. Try again.');
    }
  }, [request]);

  const loadSummary = useCallback(async () => {
    setLoadFailed(false);
    setRefused(false);
    try {
      const response = await request('/api/company');
      if (!response.ok) {
        if (response.status === 403 || response.status === 404) {
          setRefused(true);
        } else {
          setLoadFailed(true);
        }
        return;
      }
      const parsed = parseCompanySummary(await response.json());
      if (parsed === null) {
        setLoadFailed(true);
      } else if (parsed.role === 'member') {
        setRefused(true);
      } else {
        setSummary(parsed);
      }
    } catch {
      setLoadFailed(true);
    }
  }, [request]);

  const handleRedeem = async () => {
    if (inviteToken === null) return;
    setAccepting(true);
    setInviteError(null);
    setInviteStatus(null);
    try {
      const response = await request('/api/company/invites/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: inviteToken }),
      });
      if (response.status === 402) {
        setInviteError('This company has no free seats right now.');
        return;
      }
      if (response.status === 404) {
        setInviteError('This invite link is invalid or has expired.');
        return;
      }
      if (!response.ok) {
        setInviteError('Could not accept the invite. Try again.');
        return;
      }
      setInviteStatus('Invite accepted. Your company plan appears after the first payment.');
    } catch {
      setInviteError('Could not accept the invite. Try again.');
    } finally {
      setAccepting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadSummary();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSummary]);

  if (loading) {
    return (
      <p data-testid="company-loading" className="app-small">
        Loading company details...
      </p>
    );
  }

  if (refused) {
    if (inviteToken !== null) {
      return (
        <section data-testid="company-invite-redeem" className="callout">
          <h2 className="app-h2">Company invitation</h2>
          <p className="app-small">
            You have been invited to join a company on Teacher Playground.
          </p>
          <button
            type="button"
            data-testid="company-invite-accept"
            disabled={accepting}
            onClick={() => {
              void handleRedeem();
            }}
            className="btn"
          >
            Accept invite
          </button>
          {inviteError !== null && (
            <p role="alert" data-testid="company-invite-error" className="app-error">
              {inviteError}
            </p>
          )}
          <p role="status" data-testid="company-invite-status" className="app-small">
            {inviteStatus ?? ''}
          </p>
        </section>
      );
    }
    return (
      <section data-testid="company-refused" className="callout">
        <h2 className="app-h2">Company administration</h2>
        <p className="app-small">
          You need owner or admin access to manage this company.
        </p>
        <Link href="/whiteboard" prefetch={false} className="app-small underline">
          Back to your rooms
        </Link>
      </section>
    );
  }

  if (loadFailed || summary === null) {
    return (
      <div>
        <p role="alert" data-testid="company-load-error" className="app-error">
          Could not load company details. Try again.
        </p>
        <button
          type="button"
          data-testid="company-load-retry"
          onClick={() => {
            void loadSummary();
          }}
          className="btn"
        >
          Try again
        </button>
      </div>
    );
  }

  const handleMint = async () => {
    setMinting(true);
    setInviteError(null);
    try {
      const response = await request('/api/company/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: inviteRole }),
      });
      if (!response.ok) {
        setInviteError('Could not create an invite link. Try again.');
        return;
      }
      const token = readMintedToken(await response.json());
      if (token === null) {
        setInviteError('Could not create an invite link. Try again.');
        return;
      }
      setInviteStatus('Invite link created. Share it now; it is shown once.');
      setInviteToken(token);
    } catch {
      setInviteError('Could not create an invite link. Try again.');
    } finally {
      setMinting(false);
    }
  };

  const handleRevoke = async () => {
    if (inviteToken === null) return;
    setRevoking(true);
    setInviteError(null);
    setInviteStatus(null);
    try {
      const response = await request('/api/company/invites', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: inviteToken }),
      });
      if (!response.ok) {
        setInviteError('Could not revoke the invite link. Try again.');
        return;
      }
      setInviteToken(null);
      setInviteStatus('Invite revoked.');
      if (typeof window !== 'undefined') {
        window.history.replaceState({}, '', '/account/company');
      }
    } catch {
      setInviteError('Could not revoke the invite link. Try again.');
    } finally {
      setRevoking(false);
    }
  };

  const handleSettleSeats = async () => {
    const pending = summary?.pendingSeats ?? null;
    if (pending === null) return;
    setSeatBusy(true);
    setSeatError(null);
    setSeatStatus(null);
    try {
      const response = await request('/api/company/seats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetQuantity: pending.quantity,
          operationId: pending.operationId,
        }),
      });
      if (response.status === 202 || response.status === 409) {
        setSeatStatus('The seat change is still pending. Check again shortly.');
        return;
      }
      if (!response.ok) {
        setSeatError('Could not settle the seat change. Try again.');
        return;
      }
      setSeatStatus('Seat change settled.');
      await refreshSummary();
    } catch {
      setSeatError('Could not settle the seat change. Try again.');
    } finally {
      setSeatBusy(false);
    }
  };

  const inviteUrl =
    inviteToken === null
      ? null
      : `${typeof window === 'undefined' ? '' : window.location.origin}/account/company#invite=${inviteToken}`;

  return (
    <>
      <section data-testid="company-summary" className="mt-6">
        <h2 className="app-h2">{summary.name}</h2>
        <p data-testid="company-capacity" className="app-small">
          Capacity: {summary.capacity} seats
        </p>
        {summary.pendingSeats !== null && (
          <div data-testid="company-pending-seats" className="callout">
            <p className="app-small">
              Seat change to {summary.pendingSeats.quantity} seats pending.
            </p>
            <button
              type="button"
              data-testid="company-seat-change-settle"
              disabled={seatBusy}
              onClick={() => {
                void handleSettleSeats();
              }}
              className="btn"
            >
              Settle seat change
            </button>
          </div>
        )}
        {seatError !== null && (
          <p role="alert" data-testid="company-seat-error" className="app-error">
            {seatError}
          </p>
        )}
        <p role="status" data-testid="company-seat-status" className="app-small">
          {seatStatus ?? ''}
        </p>
        {summary.invoiceUrl !== null && (
          <p className="app-small">
            <a
              data-testid="company-invoice-link"
              href={summary.invoiceUrl}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              View invoice
            </a>
          </p>
        )}
        <ul className="mt-3">
          {summary.members.map((member) => (
            <li key={member.accountId} data-testid={`company-member-${member.accountId}`} className="app-small">
              {member.displayName} · {member.role} · joined{' '}
              {member.joinedAt === null ? 'unknown' : new Date(member.joinedAt).toLocaleDateString()}
            </li>
          ))}
        </ul>
      </section>

      {inviteUrl !== null ? (
        <section data-testid="company-invite-panel" className="mt-6">
          <h2 className="app-h2">Invite link</h2>
          <a data-testid="company-invite-link" href={inviteUrl} className="app-small break-all underline">
            {inviteUrl}
          </a>
          <CopyButton value={inviteUrl} label="company invite link" />
          <button
            type="button"
            data-testid="company-invite-revoke"
            disabled={revoking}
            onClick={() => {
              void handleRevoke();
            }}
            className="btn"
          >
            Revoke invite
          </button>
        </section>
      ) : (
        <section data-testid="company-invite-form" className="mt-6">
          <h2 className="app-h2">Invite a teammate</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleMint();
            }}
          >
            <div className="field-group">
              <label htmlFor="company-invite-role" className="app-label">
                Seat role
              </label>
              <select
                id="company-invite-role"
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value === 'admin' ? 'admin' : 'member')}
                className="field-input nudge-top"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button
              type="submit"
              data-testid="company-invite-mint"
              disabled={minting}
              className="btn btn-block"
            >
              Create invite link
            </button>
          </form>
          {inviteError !== null && (
            <p role="alert" data-testid="company-invite-error" className="app-error">
              {inviteError}
            </p>
          )}
        </section>
      )}

      <p role="status" data-testid="company-invite-status" className="app-small">
        {inviteStatus ?? ''}
      </p>

      <section data-testid="company-settings" className="mt-6">
        <h2 className="app-h2">Company settings</h2>
        <div className="flex flex-wrap gap-2">
          {summary.role === 'owner' && (
            <button
              type="button"
              data-testid="company-transfer"
              onClick={() => setPendingAction('transfer')}
              className="btn"
            >
              Transfer ownership
            </button>
          )}
          <button
            type="button"
            data-testid="company-rename"
            onClick={() => setPendingAction('rename')}
            className="btn"
          >
            Rename company
          </button>
          <button
            type="button"
            data-testid="company-disable"
            onClick={() => setPendingAction('disable')}
            className="btn"
          >
            Disable company
          </button>
        </div>
      </section>

      {pendingAction !== null && (
        <InertConfirmDialog
          title={DESTRUCTIVE_ACTIONS[pendingAction].title}
          body={DESTRUCTIVE_ACTIONS[pendingAction].body}
          confirmLabel={DESTRUCTIVE_ACTIONS[pendingAction].confirmLabel}
          note={DESTRUCTIVE_ACTIONS[pendingAction].note}
          testIdPrefix={`company-${pendingAction}`}
          onCancel={() => setPendingAction(null)}
        />
      )}
    </>
  );
}
