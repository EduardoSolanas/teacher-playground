'use client';

import { useCallback, useEffect, useState } from 'react';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

interface AdminAccountSummary {
  accountId: string;
  state: string;
  provenance: string;
  displayName: string | null;
  createdAt: number;
  updatedAt: number;
}

interface AdminUsersSummary {
  accounts: AdminAccountSummary[];
  total: number;
}

function toAccount(entry: unknown): AdminAccountSummary | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const accountId = record.accountId;
  const provenance = record.provenance;
  const state = record.state;
  if (
    typeof accountId !== 'string' ||
    accountId.length === 0 ||
    typeof provenance !== 'string' ||
    typeof state !== 'string'
  ) {
    return null;
  }
  const createdAt = record.createdAt;
  const updatedAt = record.updatedAt;
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') return null;
  const displayName = record.displayName;
  return {
    accountId,
    state,
    provenance,
    displayName: typeof displayName === 'string' && displayName.trim().length > 0 ? displayName : null,
    createdAt,
    updatedAt,
  };
}

function parseAdminUsers(payload: unknown): AdminUsersSummary | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const total = record.total;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) return null;
  const accountsPayload = Array.isArray(record.accounts) ? record.accounts : [];
  const accounts = accountsPayload
    .map(toAccount)
    .filter((account): account is AdminAccountSummary => account !== null);
  return { accounts, total };
}

/**
 * Room-list timestamp wording for the account table.
 *
 * The room list keeps this helper private to TeacherRoomList, so it is
 * mirrored here rather than widened into an export the pinned file scope
 * cannot make. Keep the two in step: relative for fresh timestamps, short
 * date otherwise.
 */
function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Shown for an account the backend knows by id only. */
const NO_DISPLAY_NAME = '—';

/** Cell classes mirroring the brand `.compare` table (brand.css .compare th/td). */
const TABLE_HEAD_CELL =
  'border-b border-b-[color:var(--rule)] bg-[color:var(--paper2)] px-[0.9rem] py-[0.7rem] text-left align-top';
const TABLE_BODY_CELL =
  'border-t border-t-[color:var(--line)] px-[0.9rem] py-[0.7rem] text-left align-top text-[color:var(--ink2)]';

export default function AdminUsersPanel({
  request = ajaxFetch,
}: {
  request?: AjaxFetch;
} = {}) {
  const [accounts, setAccounts] = useState<AdminAccountSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refused, setRefused] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadUsers = useCallback(async () => {
    setLoadFailed(false);
    setRefused(false);
    try {
      const response = await request('/api/admin/users');
      if (!response.ok) {
        // 403 and 404 are both "this page is not for you": a disabled admin
        // surface must be indistinguishable from a denied account, so neither
        // response may leak which one it was.
        if (response.status === 403 || response.status === 404) {
          setRefused(true);
        } else {
          setLoadFailed(true);
        }
        return;
      }
      const parsed = parseAdminUsers(await response.json());
      if (parsed === null) {
        setLoadFailed(true);
        return;
      }
      setAccounts(parsed.accounts);
      setTotal(parsed.total);
    } catch {
      setLoadFailed(true);
    }
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadUsers();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadUsers]);

  if (loading) {
    return (
      <>
        <p data-testid="admin-users-sub" className="app-sub">
          All Teacher Playground accounts, newest first.
        </p>
        <p role="status" data-testid="admin-loading" className="app-small">
          Loading accounts...
        </p>
      </>
    );
  }

  if (refused) {
    return (
      <section role="alert" data-testid="admin-denied" className="callout">
        <h2 className="app-h2">No access</h2>
        <p className="app-small">You do not have access to this page.</p>
      </section>
    );
  }

  if (loadFailed || accounts === null) {
    return (
      <div>
        <p role="alert" data-testid="admin-load-error" className="app-error">
          Could not load the account list. Try again.
        </p>
        <button
          type="button"
          data-testid="admin-load-retry"
          onClick={() => {
            void loadUsers();
          }}
          className="btn"
        >
          Try again
        </button>
      </div>
    );
  }

  const newestFirst = [...accounts].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <>
      <p data-testid="admin-users-sub" className="app-sub">
        All Teacher Playground accounts, newest first.
      </p>
      <section data-testid="admin-users" className="mt-6">
        <p data-testid="admin-users-total" className="app-small">
          {total} {total === 1 ? 'account' : 'accounts'}
        </p>
        {total > accounts.length ? (
          <p data-testid="admin-users-showing" className="app-small">
            Showing the newest {accounts.length} of {total} accounts.
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <table
            data-testid="admin-users-table"
            className="w-full min-w-[40rem] border-collapse border border-[color:var(--line)] bg-white text-[0.94rem]"
          >
            <caption className="sr-only">All accounts</caption>
            <thead>
              <tr>
                <th scope="col" className={TABLE_HEAD_CELL}>Display name</th>
                <th scope="col" className={TABLE_HEAD_CELL}>Provenance</th>
                <th scope="col" className={TABLE_HEAD_CELL}>State</th>
                <th scope="col" className={TABLE_HEAD_CELL}>Created</th>
                <th scope="col" className={TABLE_HEAD_CELL}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {newestFirst.map((account) => (
                <tr key={account.accountId} data-testid={`admin-user-${account.accountId}`}>
                  <td className={TABLE_BODY_CELL}>{account.displayName ?? NO_DISPLAY_NAME}</td>
                  <td className={TABLE_BODY_CELL}>{account.provenance}</td>
                  <td className={TABLE_BODY_CELL}>{account.state}</td>
                  <td className={TABLE_BODY_CELL}>{formatDate(account.createdAt)}</td>
                  <td className={TABLE_BODY_CELL}>{formatDate(account.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
