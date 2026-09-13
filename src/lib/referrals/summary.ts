import type { RoomDatabase } from '../whiteboard/db';
import { readReferralCode } from './codes';

export interface ReferralSummary {
  code: string;
  link: string;
  pendingCount: number;
  confirmedCount: number;
  redemptionCount: number;
}

export interface ReadReferralSummaryInput {
  accountId: string;
  baseUrl: string;
}

export function buildReferralLink(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/whiteboard?ref=${encodeURIComponent(code)}`;
}

export function readReferralSummary(
  db: RoomDatabase,
  input: ReadReferralSummaryInput,
): ReferralSummary | null {
  const code = readReferralCode(db, input.accountId);
  if (!code) return null;

  const row = db
    .prepare(
      `SELECT
         COUNT(DISTINCT CASE WHEN confirmed_at IS NULL
           THEN referred_account_id END) AS pendingCount,
         COUNT(DISTINCT CASE WHEN confirmed_at IS NOT NULL
           THEN referred_account_id END) AS confirmedCount
       FROM referral_events
       WHERE kind = 'redemption' AND code = ?
         AND reward_status != 'voided'`,
    )
    .get(code.code) as {
    pendingCount: number | null;
    confirmedCount: number | null;
  };

  const pendingCount = Number(row.pendingCount ?? 0);
  const confirmedCount = Number(row.confirmedCount ?? 0);
  return {
    code: code.code,
    link: buildReferralLink(input.baseUrl, code.code),
    pendingCount,
    confirmedCount,
    redemptionCount: pendingCount + confirmedCount,
  };
}
