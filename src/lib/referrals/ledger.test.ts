import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyIdentitySchema,
  isTutorCapReached,
  resolveAccountForSubject,
} from '../identity/identityStore';
import { ensureReferralCode } from './codes';
import {
  confirmReferralRedemption,
  recordReferralRedemption,
  recordReferralReversal,
} from './ledger';

function accessAccount(db: Database.Database, subject: string): string {
  const outcome = resolveAccountForSubject(db, {
    issuer: 'https://issuer',
    subject,
  });
  if ('tutorCapReached' in outcome) throw new Error('unexpected tutor cap');
  return outcome.account.accountId;
}

function ownerWithCode(
  db: Database.Database,
  subject: string,
): { ownerId: string; code: string } {
  const ownerId = accessAccount(db, subject);
  const code = ensureReferralCode(db, { accountId: ownerId, now: 500 }).code;
  return { ownerId, code };
}

describe('referral ledger', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  it('records a pending redemption once per checkout object', () => {
    const { code } = ownerWithCode(db, 'ledger-owner');
    const referredId = accessAccount(db, 'ledger-referred');

    const first = recordReferralRedemption(db, {
      code,
      referredAccountId: referredId,
      referredCustomerId: 'cus_referred',
      objectId: 'cs_1',
      occurredAt: 1_000,
      recordedAt: 1_000,
      processorEventId: 'evt_1',
    });

    expect(first.outcome).toBe('recorded');
    if (first.outcome !== 'recorded') {
      throw new Error('expected a recorded redemption');
    }
    expect(first.redemption).toMatchObject({
      code,
      kind: 'redemption',
      referredAccountId: referredId,
      referredCustomerId: 'cus_referred',
      objectId: 'cs_1',
      rewardStatus: 'pending',
      confirmedAt: null,
      occurredAt: 1_000,
      recordedAt: 1_000,
      processorEventId: 'evt_1',
    });

    const replay = recordReferralRedemption(db, {
      code,
      referredAccountId: referredId,
      referredCustomerId: 'cus_referred',
      objectId: 'cs_1',
      occurredAt: 1_000,
      recordedAt: 2_000,
      processorEventId: 'evt_2',
    });

    expect(replay.outcome).toBe('duplicate');
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM referral_events`).get(),
    ).toEqual({ count: 1 });
  });

  it('refuses unknown, inactive and expired codes', () => {
    const referredId = accessAccount(db, 'ledger-validation-referred');

    const unknown = recordReferralRedemption(db, {
      code: 'ZZZZZZZZ',
      referredAccountId: referredId,
      objectId: 'cs_unknown',
      occurredAt: 1_000,
      recordedAt: 1_000,
    });
    expect(unknown.outcome).toBe('unknown_code');

    const { ownerId, code } = ownerWithCode(db, 'ledger-validation-owner');
    db.prepare(
      `UPDATE referral_codes SET active = 0 WHERE owner_account_id = ?`,
    ).run(ownerId);
    const inactive = recordReferralRedemption(db, {
      code,
      referredAccountId: referredId,
      objectId: 'cs_inactive',
      occurredAt: 1_000,
      recordedAt: 1_000,
    });
    expect(inactive.outcome).toBe('inactive_code');

    db.prepare(
      `UPDATE referral_codes SET active = 1, expires_at = 900
       WHERE owner_account_id = ?`,
    ).run(ownerId);
    const expired = recordReferralRedemption(db, {
      code,
      referredAccountId: referredId,
      objectId: 'cs_expired',
      occurredAt: 1_000,
      recordedAt: 1_000,
    });
    expect(expired.outcome).toBe('expired_code');

    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM referral_events`).get(),
    ).toEqual({ count: 0 });
  });

  it('refuses self-referral by account or by processor customer', () => {
    const { ownerId, code } = ownerWithCode(db, 'self-owner');

    const byAccount = recordReferralRedemption(db, {
      code,
      referredAccountId: ownerId,
      objectId: 'cs_self_account',
      occurredAt: 1_000,
      recordedAt: 1_000,
    });
    expect(byAccount.outcome).toBe('self_referral');

    db.prepare(
      `INSERT INTO entitlements (
         account_id, source, plan_id, status, updated_at, processor_customer_id
       ) VALUES (?, 'personal', 'tutor_pro_monthly', 'active', 500, 'cus_self')`,
    ).run(ownerId);

    const otherId = accessAccount(db, 'self-other');
    const byCustomer = recordReferralRedemption(db, {
      code,
      referredAccountId: otherId,
      referredCustomerId: 'cus_self',
      objectId: 'cs_self_customer',
      occurredAt: 1_000,
      recordedAt: 1_000,
    });
    expect(byCustomer.outcome).toBe('self_referral');

    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM referral_events`).get(),
    ).toEqual({ count: 0 });
  });

  it('stops at the code redemption cap', () => {
    const { ownerId, code } = ownerWithCode(db, 'cap-owner');
    db.prepare(
      `UPDATE referral_codes SET max_redemptions = 1 WHERE owner_account_id = ?`,
    ).run(ownerId);

    const firstId = accessAccount(db, 'cap-first');
    const first = recordReferralRedemption(db, {
      code,
      referredAccountId: firstId,
      objectId: 'cs_cap_1',
      occurredAt: 1_000,
      recordedAt: 1_000,
    });
    expect(first.outcome).toBe('recorded');

    const secondId = accessAccount(db, 'cap-second');
    const second = recordReferralRedemption(db, {
      code,
      referredAccountId: secondId,
      objectId: 'cs_cap_2',
      occurredAt: 1_000,
      recordedAt: 1_000,
    });
    expect(second.outcome).toBe('max_redemptions_reached');

    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM referral_events`).get(),
    ).toEqual({ count: 1 });
  });

  it('allows one referrer per account, ever', () => {
    const first = ownerWithCode(db, 'one-referrer-a');
    const second = ownerWithCode(db, 'one-referrer-b');
    const referredId = accessAccount(db, 'one-referrer-target');

    const recorded = recordReferralRedemption(db, {
      code: first.code,
      referredAccountId: referredId,
      objectId: 'cs_first_referrer',
      occurredAt: 1_000,
      recordedAt: 1_000,
    });
    expect(recorded.outcome).toBe('recorded');

    const secondAttempt = recordReferralRedemption(db, {
      code: second.code,
      referredAccountId: referredId,
      objectId: 'cs_second_referrer',
      occurredAt: 2_000,
      recordedAt: 2_000,
    });
    expect(secondAttempt.outcome).toBe('already_redeemed');

    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM referral_events
           WHERE kind = 'redemption' AND referred_account_id = ?`,
        )
        .get(referredId),
    ).toEqual({ count: 1 });
  });

  it('holds the one-redemption index while allowing reversal and renewal rows', () => {
    const first = ownerWithCode(db, 'index-owner-a');
    const second = ownerWithCode(db, 'index-owner-b');
    const referredId = accessAccount(db, 'index-target');
    recordReferralRedemption(db, {
      code: first.code,
      referredAccountId: referredId,
      objectId: 'cs_index',
      occurredAt: 1_000,
      recordedAt: 1_000,
    });

    expect(() =>
      db
        .prepare(
          `INSERT INTO referral_events (
             record_id, code, kind, referred_account_id, object_id,
             reward_status, occurred_at, recorded_at
           ) VALUES (?, ?, 'redemption', ?, ?, 'pending', 1, 1)`,
        )
        .run('manual-redemption', second.code, referredId, 'cs_manual'),
    ).toThrow(/UNIQUE constraint/);

    db.prepare(
      `INSERT INTO referral_events (
         record_id, code, kind, referred_account_id, object_id,
         reward_status, occurred_at, recorded_at
       ) VALUES (?, ?, 'reversal', ?, ?, 'none', 1, 1)`,
    ).run('manual-reversal', first.code, referredId, 're_manual');
    db.prepare(
      `INSERT INTO referral_events (
         record_id, code, kind, referred_account_id, object_id,
         reward_status, occurred_at, recorded_at
       ) VALUES (?, ?, 'renewal', ?, ?, 'none', 1, 1)`,
    ).run('manual-renewal', first.code, referredId, 'in_manual');

    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM referral_events`).get(),
    ).toEqual({ count: 3 });
  });

  it('confirms only on the first invoice that actually paid', () => {
    const { code } = ownerWithCode(db, 'confirm-owner');
    const referredId = accessAccount(db, 'confirm-referred');
    recordReferralRedemption(db, {
      code,
      referredAccountId: referredId,
      referredCustomerId: 'cus_confirm',
      objectId: 'cs_confirm',
      occurredAt: 1_000,
      recordedAt: 1_000,
    });

    const readRedemption = () =>
      db
        .prepare(
          `SELECT confirmed_at AS confirmedAt, reward_status AS rewardStatus
           FROM referral_events WHERE kind = 'redemption' AND object_id = 'cs_confirm'`,
        )
        .get() as { confirmedAt: number | null; rewardStatus: string };

    const free = confirmReferralRedemption(db, {
      referredCustomerId: 'cus_confirm',
      amountPaidCents: 0,
      occurredAt: 2_000,
    });
    expect(free.outcome).toBe('not_confirmed');
    expect(readRedemption()).toEqual({
      confirmedAt: null,
      rewardStatus: 'pending',
    });

    const paid = confirmReferralRedemption(db, {
      referredCustomerId: 'cus_confirm',
      amountPaidCents: 1_999,
      occurredAt: 3_000,
    });
    expect(paid).toEqual({ outcome: 'confirmed', confirmedAt: 3_000 });
    expect(readRedemption()).toEqual({
      confirmedAt: 3_000,
      rewardStatus: 'earned',
    });

    const later = confirmReferralRedemption(db, {
      referredCustomerId: 'cus_confirm',
      amountPaidCents: 2_999,
      occurredAt: 4_000,
    });
    expect(later.outcome).toBe('nothing_to_confirm');
    expect(readRedemption()).toEqual({
      confirmedAt: 3_000,
      rewardStatus: 'earned',
    });
  });

  it('reversal voids a redemption once per refund object and stops re-confirmation', () => {
    const { code } = ownerWithCode(db, 'reversal-owner');
    const referredId = accessAccount(db, 'reversal-referred');
    recordReferralRedemption(db, {
      code,
      referredAccountId: referredId,
      referredCustomerId: 'cus_reversal',
      objectId: 'cs_reversal',
      occurredAt: 1_000,
      recordedAt: 1_000,
    });
    confirmReferralRedemption(db, {
      referredCustomerId: 'cus_reversal',
      amountPaidCents: 1_999,
      occurredAt: 3_000,
    });

    const reversed = recordReferralReversal(db, {
      referredAccountId: referredId,
      objectId: 're_1',
      amountCents: 1_999,
      currency: 'gbp',
      occurredAt: 5_000,
      recordedAt: 5_000,
      processorEventId: 'evt_refund_1',
    });
    expect(reversed.outcome).toBe('reversed');
    if (reversed.outcome !== 'reversed') {
      throw new Error('expected a recorded reversal');
    }
    expect(reversed.reversal).toMatchObject({
      kind: 'reversal',
      code,
      referredAccountId: referredId,
      referredCustomerId: 'cus_reversal',
      objectId: 're_1',
      amountCents: 1_999,
      rewardStatus: 'none',
    });

    const redemption = db
      .prepare(
        `SELECT confirmed_at AS confirmedAt, reward_status AS rewardStatus
         FROM referral_events WHERE kind = 'redemption' AND object_id = 'cs_reversal'`,
      )
      .get() as { confirmedAt: number | null; rewardStatus: string };
    expect(redemption).toEqual({
      confirmedAt: 3_000,
      rewardStatus: 'voided',
    });

    const replay = recordReferralReversal(db, {
      referredAccountId: referredId,
      objectId: 're_1',
      amountCents: 1_999,
      occurredAt: 5_000,
      recordedAt: 6_000,
      processorEventId: 'evt_refund_2',
    });
    expect(replay.outcome).toBe('duplicate');

    const reconfirm = confirmReferralRedemption(db, {
      referredCustomerId: 'cus_reversal',
      amountPaidCents: 500,
      occurredAt: 6_000,
    });
    expect(reconfirm.outcome).toBe('nothing_to_confirm');

    const orphan = recordReferralReversal(db, {
      referredAccountId: 'missing-account',
      objectId: 're_orphan',
      occurredAt: 6_000,
      recordedAt: 6_000,
    });
    expect(orphan.outcome).toBe('no_redemption');
  });
});
