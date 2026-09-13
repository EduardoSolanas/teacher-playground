import type { RoomDatabase } from '../whiteboard/db';
import { IdentityInputError } from '../identity/identityStore';

export const REFERRAL_CODE_LENGTH = 8;
export const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const MAX_MINT_ATTEMPTS = 3;

export function generateReferralCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(REFERRAL_CODE_LENGTH));
  let code = '';
  for (const byte of bytes) {
    code += REFERRAL_CODE_ALPHABET[byte & 31];
  }
  return code;
}

export interface ReferralCodeRecord {
  code: string;
  ownerAccountId: string;
  promotionCodeId: string | null;
  active: boolean;
  expiresAt: number | null;
  maxRedemptions: number | null;
  createdAt: number;
}

export interface EnsureReferralCodeInput {
  accountId: string;
  now: number;
  promotionCodeId?: string | null;
  expiresAt?: number | null;
  maxRedemptions?: number | null;
}

interface ReferralCodeDbRow {
  code: string;
  owner_account_id: string;
  promotion_code_id: string | null;
  active: number;
  expires_at: number | null;
  max_redemptions: number | null;
  created_at: number;
}

function toReferralCode(row: ReferralCodeDbRow): ReferralCodeRecord {
  return {
    code: row.code,
    ownerAccountId: row.owner_account_id,
    promotionCodeId: row.promotion_code_id,
    active: row.active === 1,
    expiresAt: row.expires_at,
    maxRedemptions: row.max_redemptions,
    createdAt: row.created_at,
  };
}

function readCodeByOwner(
  db: RoomDatabase,
  accountId: string,
): ReferralCodeRecord | null {
  const row = db
    .prepare(
      `SELECT code, owner_account_id, promotion_code_id, active, expires_at,
              max_redemptions, created_at
       FROM referral_codes WHERE owner_account_id = ?`,
    )
    .get(accountId) as ReferralCodeDbRow | undefined;
  return row ? toReferralCode(row) : null;
}

export function readReferralCode(
  db: RoomDatabase,
  accountId: string,
): ReferralCodeRecord | null {
  return readCodeByOwner(db, accountId);
}

export function findReferralCode(
  db: RoomDatabase,
  code: string,
): ReferralCodeRecord | null {
  const row = db
    .prepare(
      `SELECT code, owner_account_id, promotion_code_id, active, expires_at,
              max_redemptions, created_at
       FROM referral_codes WHERE code = ?`,
    )
    .get(code.toUpperCase()) as ReferralCodeDbRow | undefined;
  return row ? toReferralCode(row) : null;
}

export function ensureReferralCode(
  db: RoomDatabase,
  input: EnsureReferralCodeInput,
): ReferralCodeRecord {
  const existing = readCodeByOwner(db, input.accountId);
  if (existing) return existing;

  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
    const code = generateReferralCode();
    try {
      db.prepare(
        `INSERT INTO referral_codes (
           code, owner_account_id, promotion_code_id, expires_at,
           max_redemptions, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        code,
        input.accountId,
        input.promotionCodeId ?? null,
        input.expiresAt ?? null,
        input.maxRedemptions ?? null,
        input.now,
      );
      const minted = readCodeByOwner(db, input.accountId);
      if (minted) return minted;
    } catch (error) {
      const raced = readCodeByOwner(db, input.accountId);
      if (raced) return raced;
      if (attempt === MAX_MINT_ATTEMPTS - 1) throw error;
    }
  }

  throw new IdentityInputError('could not mint a referral code');
}
