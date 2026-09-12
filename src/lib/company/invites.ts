import type { RoomDatabase } from '../whiteboard/db';
import { assertOneActiveOwner, readMember } from './membership';
import { activeMemberCount, seatCapacity } from './seats';
import { materializeCompanyMemberEntitlement } from './companyEntitlements';

export type InviteRole = 'admin' | 'member';

export const COMPANY_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface MintedInvite {
  token: string;
  inviteHash: string;
  expiresAt: number;
}

export type MintInviteOutcome =
  | { outcome: 'minted'; invite: MintedInvite }
  | { outcome: 'forbidden' };

function generateInviteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export async function inviteTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export interface CompanyInviteRecord {
  inviteHash: string;
  companyId: string;
  role: InviteRole;
  createdBy: string;
  expiresAt: number;
  redeemedBy: string | null;
  redeemedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

interface InviteDbRow {
  invite_hash: string;
  company_id: string;
  role: InviteRole;
  created_by: string;
  expires_at: number;
  redeemed_by: string | null;
  redeemed_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

function toInvite(row: InviteDbRow): CompanyInviteRecord {
  return {
    inviteHash: row.invite_hash,
    companyId: row.company_id,
    role: row.role,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    redeemedBy: row.redeemed_by,
    redeemedAt: row.redeemed_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export function readInvite(
  db: RoomDatabase,
  inviteHash: string,
): CompanyInviteRecord | null {
  const row = db
    .prepare(
      `SELECT invite_hash, company_id, role, created_by, expires_at,
              redeemed_by, redeemed_at, revoked_at, created_at
       FROM company_invites WHERE invite_hash = ?`,
    )
    .get(inviteHash) as InviteDbRow | undefined;
  return row ? toInvite(row) : null;
}

export type RevokeInviteOutcome =
  | 'revoked'
  | 'redeemed'
  | 'already_revoked'
  | 'not_found'
  | 'forbidden';

export function revokeInvite(
  db: RoomDatabase,
  input: {
    companyId: string;
    inviteHash: string;
    actorAccountId: string;
    now: number;
  },
): { outcome: RevokeInviteOutcome } {
  return db.transaction((): { outcome: RevokeInviteOutcome } => {
    const actor = readMember(db, input.companyId, input.actorAccountId);
    if (!actor || actor.state !== 'active' || actor.role === 'member') {
      return { outcome: 'forbidden' };
    }

    const invite = readInvite(db, input.inviteHash);
    if (!invite || invite.companyId !== input.companyId) {
      return { outcome: 'not_found' };
    }
    if (invite.redeemedAt !== null) return { outcome: 'redeemed' };
    if (invite.revokedAt !== null) return { outcome: 'already_revoked' };

    db.prepare(
      `UPDATE company_invites SET revoked_at = ?
       WHERE invite_hash = ? AND company_id = ?
         AND redeemed_at IS NULL AND revoked_at IS NULL`,
    ).run(input.now, input.inviteHash, input.companyId);
    return { outcome: 'revoked' };
  })();
}

export async function mintInvite(
  db: RoomDatabase,
  input: {
    companyId: string;
    role: InviteRole;
    createdBy: string;
    now: number;
    ttlMs?: number;
  },
): Promise<MintInviteOutcome> {
  const actor = readMember(db, input.companyId, input.createdBy);
  if (!actor || actor.state !== 'active' || actor.role === 'member') {
    return { outcome: 'forbidden' };
  }

  const expiresAt = input.now + (input.ttlMs ?? COMPANY_INVITE_TTL_MS);
  const token = generateInviteToken();
  const inviteHash = await inviteTokenHash(token);
  db.prepare(
    `INSERT INTO company_invites (
       invite_hash, company_id, role, created_by, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    inviteHash,
    input.companyId,
    input.role,
    input.createdBy,
    expiresAt,
    input.now,
  );

  return { outcome: 'minted', invite: { token, inviteHash, expiresAt } };
}

export type RedeemInviteOutcome =
  | { outcome: 'redeemed'; companyId: string; role: InviteRole }
  | { outcome: 'not_found' }
  | { outcome: 'no_capacity' }
  | { outcome: 'already_member' };

function isAccessAccount(db: RoomDatabase, accountId: string): boolean {
  const row = db
    .prepare(
      `SELECT provenance, state FROM accounts WHERE account_id = ?`,
    )
    .get(accountId) as { provenance: string; state: string } | undefined;
  return row?.provenance === 'access' && row.state === 'active';
}

export async function redeemInvite(
  db: RoomDatabase,
  input: { token: string; accountId: string; now: number },
): Promise<RedeemInviteOutcome> {
  const inviteHash = await inviteTokenHash(input.token);
  const invite = readInvite(db, inviteHash);
  if (
    !invite ||
    invite.revokedAt !== null ||
    invite.redeemedAt !== null ||
    input.now >= invite.expiresAt ||
    !isAccessAccount(db, input.accountId)
  ) {
    return { outcome: 'not_found' };
  }

  return db.transaction((): RedeemInviteOutcome => {
    const current = readInvite(db, inviteHash);
    if (
      !current ||
      current.revokedAt !== null ||
      current.redeemedAt !== null ||
      input.now >= current.expiresAt
    ) {
      return { outcome: 'not_found' };
    }
    if (activeMembershipExists(db, input.accountId)) {
      return { outcome: 'already_member' };
    }
    if (
      activeMemberCount(db, current.companyId) + 1 >
      seatCapacity(db, current.companyId)
    ) {
      return { outcome: 'no_capacity' };
    }

    const consumed = db
      .prepare(
        `UPDATE company_invites SET redeemed_by = ?, redeemed_at = ?
         WHERE invite_hash = ? AND redeemed_at IS NULL AND revoked_at IS NULL`,
      )
      .run(input.accountId, input.now, inviteHash).changes;
    if (consumed !== 1) return { outcome: 'not_found' };

    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, ?, 'active', ?)`,
    ).run(current.companyId, input.accountId, current.role, input.now);
    assertOneActiveOwner(db, current.companyId);
    materializeCompanyMemberEntitlement(db, {
      companyId: current.companyId,
      accountId: input.accountId,
      cause: {
        kind: 'membership',
        id: inviteHash,
        actor: input.accountId,
        reason: 'company invite redeemed',
      },
      now: input.now,
    });

    return {
      outcome: 'redeemed',
      companyId: current.companyId,
      role: current.role,
    };
  })();
}

function activeMembershipExists(
  db: RoomDatabase,
  accountId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS present FROM company_members
       WHERE account_id = ? AND state = 'active'`,
    )
    .get(accountId) as { present: number } | undefined;
  return row !== undefined;
}
