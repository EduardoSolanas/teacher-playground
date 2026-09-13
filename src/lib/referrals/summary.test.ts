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
import { readReferralSummary } from './summary';

function accessAccount(db: Database.Database, subject: string): string {
  const outcome = resolveAccountForSubject(db, {
    issuer: 'https://issuer',
    subject,
  });
  if (isTutorCapReached(outcome)) throw new Error('unexpected tutor cap');
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

describe('referral summary', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  it('returns the caller code, teacher link and split tallies', () => {
    const { ownerId, code } = ownerWithCode(db, 'summary-owner');
    const pendingId = accessAccount(db, 'summary-pending');
    const confirmedId = accessAccount(db, 'summary-confirmed');

    recordReferralRedemption(db, {
      code,
      referredAccountId: pendingId,
      referredCustomerId: 'cus_pending',
      objectId: 'cs_pending',
      occurredAt: 1_000,
      recordedAt: 1_000,
    });
    recordReferralRedemption(db, {
      code,
      referredAccountId: confirmedId,
      referredCustomerId: 'cus_confirmed',
      objectId: 'cs_confirmed',
      occurredAt: 1_000,
      recordedAt: 1_000,
    });
    confirmReferralRedemption(db, {
      referredCustomerId: 'cus_confirmed',
      amountPaidCents: 500,
      occurredAt: 2_000,
    });

    expect(
      readReferralSummary(db, {
        accountId: ownerId,
        baseUrl: 'https://teacher.example.com/',
      }),
    ).toEqual({
      code,
      link: `https://teacher.example.com/whiteboard?ref=${code}`,
      pendingCount: 1,
      confirmedCount: 1,
      redemptionCount: 2,
    });
  });

  it('does not fabricate a summary for an account without a code', () => {
    const strangerId = accessAccount(db, 'summary-stranger');

    expect(
      readReferralSummary(db, {
        accountId: strangerId,
        baseUrl: 'https://teacher.example.com',
      }),
    ).toBeNull();
  });

  it('returns only the caller code and tallies', () => {
    const first = ownerWithCode(db, 'summary-caller-a');
    const second = ownerWithCode(db, 'summary-caller-b');
    const referredId = accessAccount(db, 'summary-caller-target');
    recordReferralRedemption(db, {
      code: first.code,
      referredAccountId: referredId,
      objectId: 'cs_caller',
      occurredAt: 1_000,
      recordedAt: 1_000,
    });

    expect(
      readReferralSummary(db, {
        accountId: first.ownerId,
        baseUrl: 'https://one.example',
      }),
    ).toMatchObject({
      code: first.code,
      link: `https://one.example/whiteboard?ref=${first.code}`,
      pendingCount: 1,
      confirmedCount: 0,
      redemptionCount: 1,
    });
    expect(
      readReferralSummary(db, {
        accountId: second.ownerId,
        baseUrl: 'https://two.example',
      }),
    ).toMatchObject({
      code: second.code,
      pendingCount: 0,
      confirmedCount: 0,
      redemptionCount: 0,
    });
  });

  it('removes a reversed referral from the tallies', () => {
    const { ownerId, code } = ownerWithCode(db, 'summary-reversal');
    const referredId = accessAccount(db, 'summary-reversal-target');
    recordReferralRedemption(db, {
      code,
      referredAccountId: referredId,
      referredCustomerId: 'cus_summary_reversal',
      objectId: 'cs_summary_reversal',
      occurredAt: 1_000,
      recordedAt: 1_000,
    });
    confirmReferralRedemption(db, {
      referredCustomerId: 'cus_summary_reversal',
      amountPaidCents: 1_999,
      occurredAt: 2_000,
    });
    expect(
      readReferralSummary(db, {
        accountId: ownerId,
        baseUrl: 'https://teacher.example.com',
      }),
    ).toMatchObject({ pendingCount: 0, confirmedCount: 1, redemptionCount: 1 });

    recordReferralReversal(db, {
      referredAccountId: referredId,
      objectId: 're_summary',
      occurredAt: 5_000,
      recordedAt: 5_000,
    });

    expect(
      readReferralSummary(db, {
        accountId: ownerId,
        baseUrl: 'https://teacher.example.com',
      }),
    ).toMatchObject({ pendingCount: 0, confirmedCount: 0, redemptionCount: 0 });
  });
});
