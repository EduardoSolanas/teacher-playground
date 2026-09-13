'use client';

import { useCallback, useEffect, useState } from 'react';
import CopyButton from './CopyButton';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

interface ReferralSummary {
  code: string;
  link: string;
  pendingCount: number;
  confirmedCount: number;
  redemptionCount: number;
}

function parseReferralSummary(payload: unknown): ReferralSummary | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.code !== 'string' || record.code.length === 0) return null;
  if (typeof record.link !== 'string' || record.link.length === 0) return null;
  return {
    code: record.code,
    link: record.link,
    pendingCount: typeof record.pendingCount === 'number' ? record.pendingCount : 0,
    confirmedCount: typeof record.confirmedCount === 'number' ? record.confirmedCount : 0,
    redemptionCount: typeof record.redemptionCount === 'number' ? record.redemptionCount : 0,
  };
}

export default function ReferralPanel({ request = ajaxFetch }: { request?: AjaxFetch }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [summary, setSummary] = useState<ReferralSummary | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const response = await request('/api/referrals/me');
      if (!response.ok) {
        setStatus('error');
        return;
      }
      const parsed = parseReferralSummary(await response.json());
      if (parsed) {
        setSummary(parsed);
        setStatus('ready');
      } else {
        setStatus('empty');
      }
    } catch {
      setStatus('error');
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === 'loading') {
    return (
      <p data-testid="referral-loading" className="px-3 py-2 text-[0.6875rem] text-slate-400">
        Loading referral link...
      </p>
    );
  }

  if (status === 'error') {
    return (
      <div data-testid="referral-error" role="alert" className="px-3 py-2">
        <p className="text-[0.75rem] font-medium text-red-400">
          Could not load your referral link.
        </p>
        <button
          type="button"
          data-testid="referral-retry"
          onClick={() => { void load(); }}
          className="mt-1 text-[0.75rem] font-semibold text-slate-200 underline"
        >
          Try again
        </button>
      </div>
    );
  }

  if (status === 'empty' || !summary) {
    return (
      <p data-testid="referral-empty" className="px-3 py-2 text-[0.6875rem] text-slate-400">
        No referral link is available on this account yet.
      </p>
    );
  }

  return (
    <div data-testid="referral-panel">
      <p className="truncate px-3 py-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400">
        Refer a tutor
      </p>
      <div className="flex items-center gap-2 px-3 pb-2">
        <span
          data-testid="referral-code"
          className="truncate rounded-md bg-slate-900 px-2 py-1 font-mono text-[0.75rem] text-slate-100"
        >
          {summary.code}
        </span>
        <CopyButton value={summary.link} label="referral link" />
      </div>
      <div className="flex items-center gap-2 px-3 pb-2">
        <span
          data-testid="referral-counter"
          role="status"
          aria-live="polite"
          className="text-[10px] font-semibold text-emerald-400"
        >
          {summary.redemptionCount} {summary.redemptionCount === 1 ? 'referral' : 'referrals'}
        </span>
        <span data-testid="referral-counts" className="text-[10px] text-slate-400">
          {summary.confirmedCount} confirmed · {summary.pendingCount} pending
        </span>
      </div>
    </div>
  );
}
