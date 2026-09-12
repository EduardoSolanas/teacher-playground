'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';
import CopyButton from '@/components/whiteboard/CopyButton';
import ConfirmDialog from './ConfirmDialog';
import {
  inviteTokenHash,
  parseCompanySummary,
  readInviteToken,
  readMintedInvite,
  type CompanySummary,
} from './companySummary';

type DestructiveActionId = 'transfer' | 'rename' | 'disable';

const DESTRUCTIVE_ACTIONS: Record<
  DestructiveActionId,
  { title: string; body: string; confirmLabel: string }
> = {
  transfer: {
    title: 'Transfer ownership',
    body: 'Ownership moves to the member you choose, who becomes the owner. The current owner becomes an admin.',
    confirmLabel: 'Transfer ownership',
  },
  rename: {
    title: 'Rename company',
    body: 'The new name appears on invoices and on every member’s plan.',
    confirmLabel: 'Rename company',
  },
  disable: {
    title: 'Disable company',
    body: 'Every member loses their company seat. Rooms and boards are not deleted.',
    confirmLabel: 'Disable company',
  },
};

async function actionErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (body && typeof body.error === 'string' && body.error.trim().length > 0) {
    return body.error;
  }
  return fallback;
}

export default function CompanyAdminPanel({
  request = ajaxFetch,
}: {
  request?: AjaxFetch;
} = {}) {
  const [summary, setSummary] = useState<CompanySummary | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refused, setRefused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : readInviteToken(window.location.hash),
  );
  const [mintedInviteHash, setMintedInviteHash] = useState<string | null>(null);
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
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [renameName, setRenameName] = useState('');
  const [transferTarget, setTransferTarget] = useState('');

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

  if (disabled) {
    return (
      <section data-testid="company-disabled" className="callout">
        <h2 className="app-h2">Company disabled</h2>
        <p className="app-small">
          Every member lost their company seat. Rooms and boards were not deleted.
        </p>
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

  const transferCandidates = summary.members.filter((member) => member.role !== 'owner');

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
      const minted = readMintedInvite(await response.json());
      if (minted === null) {
        setInviteError('Could not create an invite link. Try again.');
        return;
      }
      setInviteStatus('Invite link created. Share it now; it is shown once.');
      setInviteToken(minted.token);
      setMintedInviteHash(minted.inviteHash);
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
      const inviteHash = mintedInviteHash ?? (await inviteTokenHash(inviteToken));
      const response = await request('/api/company/invites', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteHash }),
      });
      if (!response.ok) {
        setInviteError('Could not revoke the invite link. Try again.');
        return;
      }
      setInviteToken(null);
      setMintedInviteHash(null);
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
          quantity: pending.quantity,
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

  const openAction = (action: DestructiveActionId) => {
    setActionError(null);
    setPendingAction(action);
    if (action === 'rename') {
      setRenameName(summary.name);
    }
    if (action === 'transfer') {
      setTransferTarget(
        summary.members.find((member) => member.role !== 'owner')?.accountId ?? '',
      );
    }
  };

  const closeAction = () => {
    setPendingAction(null);
    setActionError(null);
  };

  const handleTransfer = async () => {
    if (transferTarget === '') return;
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await request('/api/company/owner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: transferTarget }),
      });
      if (!response.ok) {
        setActionError(
          await actionErrorMessage(response, 'Could not transfer ownership. Try again.'),
        );
        return;
      }
      closeAction();
      await loadSummary();
    } catch {
      setActionError('Could not transfer ownership. Try again.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleRename = async () => {
    const name = renameName.trim();
    if (name.length === 0) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await request('/api/company', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        setActionError(await actionErrorMessage(response, 'Could not rename the company. Try again.'));
        return;
      }
      closeAction();
      await loadSummary();
    } catch {
      setActionError('Could not rename the company. Try again.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleDisable = async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await request('/api/company', { method: 'DELETE' });
      if (!response.ok) {
        setActionError(await actionErrorMessage(response, 'Could not disable the company. Try again.'));
        return;
      }
      closeAction();
      setDisabled(true);
    } catch {
      setActionError('Could not disable the company. Try again.');
    } finally {
      setActionBusy(false);
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
        <ul className="mt-3">
          {summary.members.map((member) => (
            <li key={member.accountId} data-testid={`company-member-${member.accountId}`} className="app-small">
              {member.accountId} · {member.role} · joined{' '}
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
              onClick={() => openAction('transfer')}
              className="btn"
            >
              Transfer ownership
            </button>
          )}
          <button
            type="button"
            data-testid="company-rename"
            onClick={() => openAction('rename')}
            className="btn"
          >
            Rename company
          </button>
          {summary.role === 'owner' && (
            <button
              type="button"
              data-testid="company-disable"
              onClick={() => openAction('disable')}
              className="btn"
            >
              Disable company
            </button>
          )}
        </div>
      </section>

      {pendingAction === 'transfer' && (
        <ConfirmDialog
          title={DESTRUCTIVE_ACTIONS.transfer.title}
          body={DESTRUCTIVE_ACTIONS.transfer.body}
          confirmLabel={DESTRUCTIVE_ACTIONS.transfer.confirmLabel}
          testIdPrefix="company-transfer"
          busy={actionBusy}
          error={actionError}
          confirmDisabled={transferTarget === ''}
          onCancel={closeAction}
          onConfirm={() => {
            void handleTransfer();
          }}
        >
          {transferCandidates.length > 0 ? (
            <div className="field-group">
              <label htmlFor="company-transfer-target" className="app-label">
                New owner
              </label>
              <select
                id="company-transfer-target"
                data-testid="company-transfer-target"
                value={transferTarget}
                onChange={(event) => setTransferTarget(event.target.value)}
                className="field-input nudge-top"
              >
                {transferCandidates.map((member) => (
                  <option key={member.accountId} value={member.accountId}>
                    {member.accountId}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="app-small">Add an admin or a member before transferring ownership.</p>
          )}
        </ConfirmDialog>
      )}

      {pendingAction === 'rename' && (
        <ConfirmDialog
          title={DESTRUCTIVE_ACTIONS.rename.title}
          body={DESTRUCTIVE_ACTIONS.rename.body}
          confirmLabel={DESTRUCTIVE_ACTIONS.rename.confirmLabel}
          testIdPrefix="company-rename"
          busy={actionBusy}
          error={actionError}
          confirmDisabled={renameName.trim().length === 0}
          onCancel={closeAction}
          onConfirm={() => {
            void handleRename();
          }}
        >
          <div className="field-group">
            <label htmlFor="company-rename-name" className="app-label">
              Company name
            </label>
            <input
              id="company-rename-name"
              data-testid="company-rename-name"
              value={renameName}
              maxLength={100}
              onChange={(event) => setRenameName(event.target.value)}
              className="field-input nudge-top"
            />
          </div>
        </ConfirmDialog>
      )}

      {pendingAction === 'disable' && (
        <ConfirmDialog
          title={DESTRUCTIVE_ACTIONS.disable.title}
          body={DESTRUCTIVE_ACTIONS.disable.body}
          confirmLabel={DESTRUCTIVE_ACTIONS.disable.confirmLabel}
          testIdPrefix="company-disable"
          busy={actionBusy}
          error={actionError}
          onCancel={closeAction}
          onConfirm={() => {
            void handleDisable();
          }}
        />
      )}
    </>
  );
}
