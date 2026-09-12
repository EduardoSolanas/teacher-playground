import type { RoomDatabase } from '../whiteboard/db';
import { findReferralCode } from './codes';

export type ReferralEventKind = 'redemption' | 'renewal' | 'reversal';
export type ReferralRewardStatus = 'none' | 'pending' | 'earned' | 'voided';

export interface ReferralEventRecord {
  recordId: string;
  processorEventId: string | null;
  code: string;
  kind: ReferralEventKind;
  referredAccountId: string;
  referredCustomerId: string | null;
  objectId: string;
  amountCents: number;
  currency: string | null;
  rewardStatus: ReferralRewardStatus;
  confirmedAt: number | null;
  occurredAt: number;
  recordedAt: number;
}

interface ReferralEventDbRow {
  record_id: string;
  processor_event_id: string | null;
  code: string;
  kind: ReferralEventKind;
  referred_account_id: string;
  referred_customer_id: string | null;
  object_id: string;
  amount_cents: number;
  currency: string | null;
  reward_status: ReferralRewardStatus;
  confirmed_at: number | null;
  occurred_at: number;
  recorded_at: number;
}

function toReferralEvent(row: ReferralEventDbRow): ReferralEventRecord {
  return {
    recordId: row.record_id,
    processorEventId: row.processor_event_id,
    code: row.code,
    kind: row.kind,
    referredAccountId: row.referred_account_id,
    referredCustomerId: row.referred_customer_id,
    objectId: row.object_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    rewardStatus: row.reward_status,
    confirmedAt: row.confirmed_at,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}

function readEventByObject(
  db: RoomDatabase,
  kind: ReferralEventKind,
  objectId: string,
): ReferralEventRecord | null {
  const row = db
    .prepare(
      `SELECT record_id, processor_event_id, code, kind, referred_account_id,
              referred_customer_id, object_id, amount_cents, currency,
              reward_status, confirmed_at, occurred_at, recorded_at
       FROM referral_events WHERE kind = ? AND object_id = ?`,
    )
    .get(kind, objectId) as ReferralEventDbRow | undefined;
  return row ? toReferralEvent(row) : null;
}

function readOwnerCustomerId(
  db: RoomDatabase,
  ownerAccountId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT processor_customer_id FROM entitlements
       WHERE account_id = ? AND source = 'personal'`,
    )
    .get(ownerAccountId) as { processor_customer_id: string | null } | undefined;
  return row?.processor_customer_id ?? null;
}

export interface RecordReferralRedemptionInput {
  code: string;
  referredAccountId: string;
  referredCustomerId?: string | null;
  objectId: string;
  occurredAt: number;
  recordedAt: number;
  processorEventId?: string | null;
  amountCents?: number;
  currency?: string | null;
}

export type RecordReferralRedemptionOutcome =
  | { outcome: 'recorded'; redemption: ReferralEventRecord }
  | { outcome: 'duplicate'; redemption: ReferralEventRecord }
  | { outcome: 'unknown_code' }
  | { outcome: 'inactive_code' }
  | { outcome: 'expired_code' }
  | { outcome: 'max_redemptions_reached' }
  | { outcome: 'self_referral' }
  | { outcome: 'already_redeemed' };

export function recordReferralRedemption(
  db: RoomDatabase,
  input: RecordReferralRedemptionInput,
): RecordReferralRedemptionOutcome {
  const existing = readEventByObject(db, 'redemption', input.objectId);
  if (existing) return { outcome: 'duplicate', redemption: existing };

  const code = findReferralCode(db, input.code);
  if (!code) return { outcome: 'unknown_code' };
  if (!code.active) return { outcome: 'inactive_code' };
  if (code.expiresAt !== null && input.occurredAt >= code.expiresAt) {
    return { outcome: 'expired_code' };
  }
  if (input.referredAccountId === code.ownerAccountId) {
    return { outcome: 'self_referral' };
  }
  if (
    input.referredCustomerId &&
    input.referredCustomerId === readOwnerCustomerId(db, code.ownerAccountId)
  ) {
    return { outcome: 'self_referral' };
  }
  if (code.maxRedemptions !== null) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM referral_events
         WHERE code = ? AND kind = 'redemption'`,
      )
      .get(code.code) as { count: number };
    if (Number(row.count) >= code.maxRedemptions) {
      return { outcome: 'max_redemptions_reached' };
    }
  }
  const priorRedemption = db
    .prepare(
      `SELECT 1 AS present FROM referral_events
       WHERE kind = 'redemption' AND referred_account_id = ?`,
    )
    .get(input.referredAccountId) as { present: number } | undefined;
  if (priorRedemption) return { outcome: 'already_redeemed' };

  db.prepare(
    `INSERT INTO referral_events (
       record_id, processor_event_id, code, kind, referred_account_id,
       referred_customer_id, object_id, amount_cents, currency, reward_status,
       confirmed_at, occurred_at, recorded_at
     ) VALUES (?, ?, ?, 'redemption', ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    input.processorEventId ?? null,
    code.code,
    input.referredAccountId,
    input.referredCustomerId ?? null,
    input.objectId,
    input.amountCents ?? 0,
    input.currency ?? null,
    input.occurredAt,
    input.recordedAt,
  );

  const recorded = readEventByObject(db, 'redemption', input.objectId);
  if (!recorded) throw new Error('failed to record referral redemption');
  return { outcome: 'recorded', redemption: recorded };
}

export interface ConfirmReferralRedemptionInput {
  referredCustomerId: string;
  amountPaidCents: number;
  occurredAt: number;
}

export type ConfirmReferralRedemptionOutcome =
  | { outcome: 'confirmed'; confirmedAt: number }
  | { outcome: 'not_confirmed' }
  | { outcome: 'nothing_to_confirm' };

export function confirmReferralRedemption(
  db: RoomDatabase,
  input: ConfirmReferralRedemptionInput,
): ConfirmReferralRedemptionOutcome {
  if (!(input.amountPaidCents > 0)) return { outcome: 'not_confirmed' };

  const changed = db
    .prepare(
      `UPDATE referral_events
       SET confirmed_at = ?, reward_status = 'earned'
       WHERE kind = 'redemption' AND referred_customer_id = ?
         AND reward_status = 'pending' AND confirmed_at IS NULL`,
    )
    .run(input.occurredAt, input.referredCustomerId).changes;

  if (changed === 0) return { outcome: 'nothing_to_confirm' };
  return { outcome: 'confirmed', confirmedAt: input.occurredAt };
}

const EVENT_COLUMNS = `record_id, processor_event_id, code, kind,
  referred_account_id, referred_customer_id, object_id, amount_cents, currency,
  reward_status, confirmed_at, occurred_at, recorded_at`;

function readRedemptionByAccount(
  db: RoomDatabase,
  accountId: string,
): ReferralEventRecord | null {
  const row = db
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM referral_events
       WHERE kind = 'redemption' AND referred_account_id = ?`,
    )
    .get(accountId) as ReferralEventDbRow | undefined;
  return row ? toReferralEvent(row) : null;
}

function readRedemptionByCustomer(
  db: RoomDatabase,
  customerId: string,
): ReferralEventRecord | null {
  const row = db
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM referral_events
       WHERE kind = 'redemption' AND referred_customer_id = ?`,
    )
    .get(customerId) as ReferralEventDbRow | undefined;
  return row ? toReferralEvent(row) : null;
}

export interface RecordReferralReversalInput {
  objectId: string;
  referredAccountId?: string;
  referredCustomerId?: string | null;
  amountCents?: number;
  currency?: string | null;
  occurredAt: number;
  recordedAt: number;
  processorEventId?: string | null;
}

export type RecordReferralReversalOutcome =
  | { outcome: 'reversed'; reversal: ReferralEventRecord }
  | { outcome: 'duplicate'; reversal: ReferralEventRecord }
  | { outcome: 'no_redemption' };

export function recordReferralReversal(
  db: RoomDatabase,
  input: RecordReferralReversalInput,
): RecordReferralReversalOutcome {
  const existing = readEventByObject(db, 'reversal', input.objectId);
  if (existing) return { outcome: 'duplicate', reversal: existing };

  let redemption: ReferralEventRecord | null = null;
  if (input.referredAccountId) {
    redemption = readRedemptionByAccount(db, input.referredAccountId);
  }
  if (!redemption && input.referredCustomerId) {
    redemption = readRedemptionByCustomer(db, input.referredCustomerId);
  }
  if (!redemption) return { outcome: 'no_redemption' };

  db.prepare(
    `INSERT INTO referral_events (
       record_id, processor_event_id, code, kind, referred_account_id,
       referred_customer_id, object_id, amount_cents, currency, reward_status,
       confirmed_at, occurred_at, recorded_at
     ) VALUES (?, ?, ?, 'reversal', ?, ?, ?, ?, ?, 'none', NULL, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    input.processorEventId ?? null,
    redemption.code,
    redemption.referredAccountId,
    redemption.referredCustomerId,
    input.objectId,
    input.amountCents ?? 0,
    input.currency ?? null,
    input.occurredAt,
    input.recordedAt,
  );
  db.prepare(
    `UPDATE referral_events SET reward_status = 'voided'
     WHERE record_id = ? AND reward_status != 'voided'`,
  ).run(redemption.recordId);

  const reversal = readEventByObject(db, 'reversal', input.objectId);
  if (!reversal) throw new Error('failed to record referral reversal');
  return { outcome: 'reversed', reversal };
}
