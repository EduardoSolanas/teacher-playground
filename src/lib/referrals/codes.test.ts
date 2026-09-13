import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyIdentitySchema,
  isTutorCapReached,
  resolveAccountForSubject,
} from '../identity/identityStore';
import {
  REFERRAL_CODE_ALPHABET,
  REFERRAL_CODE_LENGTH,
  ensureReferralCode,
  findReferralCode,
  generateReferralCode,
  readReferralCode,
} from './codes';

function accessAccount(db: Database.Database, subject: string): string {
  const outcome = resolveAccountForSubject(db, {
    issuer: 'https://issuer',
    subject,
  });
  if (isTutorCapReached(outcome)) throw new Error('unexpected tutor cap');
  return outcome.account.accountId;
}

describe('referral code generation', () => {
  it('mints unique codes from the documented alphabet', () => {
    expect(REFERRAL_CODE_LENGTH).toBeGreaterThanOrEqual(8);
    expect(new Set(REFERRAL_CODE_ALPHABET).size).toBeGreaterThanOrEqual(32);

    const codes = Array.from({ length: 200 }, () => generateReferralCode());
    const pattern = new RegExp(
      `^[${REFERRAL_CODE_ALPHABET}]{${REFERRAL_CODE_LENGTH}}$`,
    );
    for (const code of codes) {
      expect(code).toMatch(pattern);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('referral code store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  it('mints one code per account and returns it on later calls', () => {
    const ownerId = accessAccount(db, 'codes-owner');
    const first = ensureReferralCode(db, { accountId: ownerId, now: 1_000 });

    expect(first.code).toMatch(
      new RegExp(`^[${REFERRAL_CODE_ALPHABET}]{${REFERRAL_CODE_LENGTH}}$`),
    );
    expect(first.ownerAccountId).toBe(ownerId);
    expect(first.active).toBe(true);
    expect(first.expiresAt).toBeNull();
    expect(first.maxRedemptions).toBeNull();
    expect(first.createdAt).toBe(1_000);

    const second = ensureReferralCode(db, { accountId: ownerId, now: 2_000 });
    expect(second.code).toBe(first.code);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM referral_codes WHERE owner_account_id = ?`,
        )
        .get(ownerId),
    ).toEqual({ count: 1 });

    const otherId = accessAccount(db, 'codes-other');
    const other = ensureReferralCode(db, { accountId: otherId, now: 1_000 });
    expect(other.code).not.toBe(first.code);
  });

  it('finds a code case-insensitively and returns nothing for unknown codes', () => {
    const ownerId = accessAccount(db, 'codes-lookup');
    const minted = ensureReferralCode(db, { accountId: ownerId, now: 1_000 });

    expect(readReferralCode(db, ownerId)?.code).toBe(minted.code);
    expect(findReferralCode(db, minted.code.toLowerCase())?.ownerAccountId).toBe(
      ownerId,
    );
    expect(findReferralCode(db, 'ZZZZZZZZ')).toBeNull();
    expect(readReferralCode(db, 'missing-account')).toBeNull();
  });
});
