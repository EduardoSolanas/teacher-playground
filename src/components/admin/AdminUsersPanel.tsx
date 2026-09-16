'use client';

import { useCallback, useEffect, useState } from 'react';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

interface AdminAccountSummary {
  accountId: string;
  state: string;
  provenance: string;
  displayName: string | null;
  organisation: string | null;
  plan: string | null;
  planStatus: string | null;
  rooms: number;
  createdAt: number;
  updatedAt: number;
  /** Backend fields beyond the known set ride along for the dynamic columns. */
  [key: string]: unknown;
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
  const organisation = record.organisation;
  const plan = record.plan;
  const planStatus = record.planStatus;
  const rooms = record.rooms;
  // Fields the panel does not know are preserved verbatim so the column
  // union can surface them; known fields are normalized above instead.
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!KNOWN_FIELDS.has(key)) extras[key] = value;
  }
  return {
    accountId,
    state,
    provenance,
    displayName: typeof displayName === 'string' && displayName.trim().length > 0 ? displayName : null,
    organisation:
      typeof organisation === 'string' && organisation.trim().length > 0 ? organisation : null,
    plan: typeof plan === 'string' && plan.trim().length > 0 ? plan : null,
    planStatus:
      typeof planStatus === 'string' && planStatus.trim().length > 0 ? planStatus : null,
    rooms: typeof rooms === 'number' && Number.isInteger(rooms) && rooms >= 0 ? rooms : 0,
    createdAt,
    updatedAt,
    ...extras,
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

/** One known column: header label, optional cell formatter, optional alignment. */
interface ColumnSpec {
  label: string;
  format?: (value: unknown) => string;
  align?: 'right';
}

/** Known fields first in this order; accountId deliberately closes the row. */
const PREFERRED_ORDER = [
  'displayName',
  'organisation',
  'plan',
  'planStatus',
  'rooms',
  'provenance',
  'state',
  'createdAt',
  'updatedAt',
  'accountId',
];

/**
 * Labels and formatting for the fields the panel knows by name. The table
 * itself is data-driven: deriveColumns unions the row keys, so a backend
 * field missing from this registry still renders as a column, labelled by
 * humanizeKey and formatted with String — no panel change needed.
 */
const COLUMN_SPECS: Record<string, ColumnSpec> = {
  displayName: { label: 'Display name' },
  organisation: { label: 'Organisation' },
  plan: { label: 'Plan' },
  planStatus: { label: 'Plan status' },
  rooms: { label: 'Rooms', align: 'right' },
  provenance: { label: 'Provenance' },
  state: { label: 'State' },
  createdAt: { label: 'Created', format: (value) => formatDate(Number(value)) },
  updatedAt: { label: 'Updated', format: (value) => formatDate(Number(value)) },
  accountId: { label: 'Account id' },
};

const KNOWN_FIELDS = new Set(Object.keys(COLUMN_SPECS));

/** camelCase backend key as a header, e.g. loginCount -> Login Count. */
function humanizeKey(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ');
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/**
 * One column per distinct key across all rows: known fields in
 * PREFERRED_ORDER first, then unknown keys in first-seen order. The caller
 * falls back to PREFERRED_ORDER for an empty list so an empty payload keeps
 * the header row the table has always shown.
 */
function deriveColumns(accounts: AdminAccountSummary[]): string[] {
  const present = new Set<string>();
  for (const account of accounts) {
    for (const key of Object.keys(account)) present.add(key);
  }
  const columns = PREFERRED_ORDER.filter((key) => present.has(key));
  for (const account of accounts) {
    for (const key of Object.keys(account)) {
      if (!KNOWN_FIELDS.has(key) && !columns.includes(key)) columns.push(key);
    }
  }
  return columns;
}

/** Em-dash for missing values, the registered formatter when present, else String. */
function renderCellValue(account: AdminAccountSummary, key: string): string {
  const value = account[key];
  if (value === null || value === undefined) return MISSING_VALUE;
  const spec: ColumnSpec | undefined = COLUMN_SPECS[key];
  if (spec?.format) return spec.format(value);
  return String(value);
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

/** Shown for any cell whose field is null, undefined, or absent. */
const MISSING_VALUE = '—';

/** Cell classes mirroring the brand `.compare` table (brand.css .compare th/td). */
const TABLE_HEAD_CELL =
  'border-b border-b-[color:var(--rule)] bg-[color:var(--paper2)] px-[0.9rem] py-[0.7rem] text-left align-top';
const TABLE_BODY_CELL =
  'border-t border-t-[color:var(--line)] px-[0.9rem] py-[0.7rem] text-left align-top text-[color:var(--ink2)]';

/** The numeric room count reads better against the right edge. */
const TABLE_HEAD_CELL_RIGHT = `${TABLE_HEAD_CELL} text-right`;
const TABLE_BODY_CELL_RIGHT = `${TABLE_BODY_CELL} text-right`;

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
  const columns =
    accounts.length === 0 ? [...PREFERRED_ORDER] : deriveColumns(accounts);

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
            className="w-full min-w-[52rem] border-collapse border border-[color:var(--line)] bg-white text-[0.94rem]"
          >
            <caption className="sr-only">All accounts</caption>
            <thead>
              <tr>
                {columns.map((key) => {
                  const spec: ColumnSpec | undefined = COLUMN_SPECS[key];
                  return (
                    <th
                      key={key}
                      scope="col"
                      className={
                        spec?.align === 'right' ? TABLE_HEAD_CELL_RIGHT : TABLE_HEAD_CELL
                      }
                    >
                      {spec ? spec.label : humanizeKey(key)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {newestFirst.map((account) => (
                <tr key={account.accountId} data-testid={`admin-user-${account.accountId}`}>
                  {columns.map((key) => {
                    const spec: ColumnSpec | undefined = COLUMN_SPECS[key];
                    return (
                      <td
                        key={key}
                        className={
                          spec?.align === 'right' ? TABLE_BODY_CELL_RIGHT : TABLE_BODY_CELL
                        }
                      >
                        {renderCellValue(account, key)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
