'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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

interface AdminUsersCursor {
  createdAt: number;
  accountId: string;
}

interface AdminUsersSummary {
  accounts: AdminAccountSummary[];
  total: number;
  nextCursor: AdminUsersCursor | null;
}

interface AdminErrorRow {
  at: number;
  scope: string;
  message: string;
  source: 'identity' | 'room';
  roomId?: string;
}

const ERROR_SOURCES: ReadonlySet<string> = new Set(['identity', 'room']);

function toErrorRow(entry: unknown): AdminErrorRow | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const at = record.at;
  const scope = record.scope;
  const message = record.message;
  const source = record.source;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (typeof scope !== 'string' || scope.length === 0) return null;
  if (typeof message !== 'string' || message.length === 0) return null;
  if (typeof source !== 'string' || !ERROR_SOURCES.has(source)) return null;
  const roomId = record.roomId;
  return {
    at,
    scope,
    message,
    source: source as AdminErrorRow['source'],
    ...(typeof roomId === 'string' && roomId.length > 0 ? { roomId } : {}),
  };
}

function parseAdminErrors(payload: unknown): AdminErrorRow[] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.errors)) return null;
  return record.errors
    .map(toErrorRow)
    .filter((row): row is AdminErrorRow => row !== null);
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
  // An absent, malformed, or null cursor means "this is the last page".
  const rawCursor = record.nextCursor;
  let nextCursor: AdminUsersCursor | null = null;
  if (rawCursor && typeof rawCursor === 'object' && !Array.isArray(rawCursor)) {
    const cursorRecord = rawCursor as Record<string, unknown>;
    const createdAt = cursorRecord.createdAt;
    const accountId = cursorRecord.accountId;
    if (
      typeof createdAt === 'number' &&
      Number.isFinite(createdAt) &&
      typeof accountId === 'string' &&
      accountId.length > 0
    ) {
      nextCursor = { createdAt, accountId };
    }
  }
  return { accounts, total, nextCursor };
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
  const [errors, setErrors] = useState<AdminErrorRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<AdminUsersCursor | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [searchApplied, setSearchApplied] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  /** The search the currently rendered list reflects; '' is the unsearched list. */
  const lastSearchRef = useRef('');

  const loadAccounts = useCallback(
    async (search: string, cursor: AdminUsersCursor | null = null) => {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', JSON.stringify(cursor));
      if (search.length > 0) params.set('search', search);
      const query = params.toString();
      setLoadFailed(false);
      setRefused(false);
      try {
        const response = await request(`/api/admin/users${query ? `?${query}` : ''}`);
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
        if (cursor) {
          // A loaded page continues the list; nothing already shown is dropped.
          setAccounts((existing) => [...(existing ?? []), ...parsed.accounts]);
        } else {
          setAccounts(parsed.accounts);
          setSearchApplied(search);
        }
        setTotal(parsed.total);
        setNextCursor(parsed.nextCursor);
      } catch {
        setLoadFailed(true);
      }
    },
    [request],
  );

  const loadMore = useCallback(async () => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      await loadAccounts(searchApplied, nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [loadAccounts, nextCursor, loadingMore, searchApplied]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // The rings are diagnostics: whatever happens to this fetch, the account
      // list must still render. Any failure — status or network — just hides
      // the section.
      try {
        const errorsResponse = await request('/api/admin/errors');
        const parsedErrors = errorsResponse.ok
          ? parseAdminErrors(await errorsResponse.json())
          : null;
        if (!cancelled) setErrors(parsedErrors);
      } catch {
        if (!cancelled) setErrors(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadAccounts('');
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAccounts]);

  // Debounced search: 300ms after the last keystroke the searched page
  // replaces the list; an emptied input returns to the unsearched list.
  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = searchInput.trim();
      if (trimmed === lastSearchRef.current) return;
      lastSearchRef.current = trimmed;
      void loadAccounts(trimmed);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, loadAccounts]);

  const retryUsers = useCallback(() => {
    void loadAccounts(lastSearchRef.current);
  }, [loadAccounts]);

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
          onClick={retryUsers}
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
        <div className="field-group">
          <label htmlFor="admin-users-search" className="app-label">
            Search display names
          </label>
          <input
            id="admin-users-search"
            type="search"
            data-testid="admin-users-search"
            value={searchInput}
            maxLength={200}
            onChange={(event) => setSearchInput(event.target.value)}
            className="field-input"
          />
        </div>
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
        {nextCursor !== null ? (
          <button
            type="button"
            data-testid="admin-users-load-more"
            onClick={() => {
              void loadMore();
            }}
            disabled={loadingMore}
            className="btn mt-4"
          >
            Load more
          </button>
        ) : null}
      </section>
      {errors !== null ? (
        <section data-testid="admin-errors" className="mt-10">
          <h2 className="app-h2">Recent errors</h2>
          <p className="app-small">
            Internal errors the room and identity stores logged, newest first. Bounded to the
            latest 100.
          </p>
          {errors.length === 0 ? (
            <p data-testid="admin-errors-empty" className="app-small">
              No recent errors.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table
                data-testid="admin-errors-table"
                className="w-full min-w-[52rem] border-collapse border border-[color:var(--line)] bg-white text-[0.94rem]"
              >
                <caption className="sr-only">Recent internal errors</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE_HEAD_CELL}>Time</th>
                    <th scope="col" className={TABLE_HEAD_CELL}>Scope</th>
                    <th scope="col" className={TABLE_HEAD_CELL}>Source</th>
                    <th scope="col" className={TABLE_HEAD_CELL}>Room</th>
                    <th scope="col" className={TABLE_HEAD_CELL}>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.map((row, index) => (
                    <tr
                      key={`${row.at}-${row.scope}-${index}`}
                      data-testid="admin-error-row"
                    >
                      <td className={TABLE_BODY_CELL}>{formatDate(row.at)}</td>
                      <td className={TABLE_BODY_CELL}>{row.scope}</td>
                      <td className={TABLE_BODY_CELL}>{row.source}</td>
                      <td className={TABLE_BODY_CELL}>{row.roomId ?? MISSING_VALUE}</td>
                      <td className={TABLE_BODY_CELL}>{row.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
