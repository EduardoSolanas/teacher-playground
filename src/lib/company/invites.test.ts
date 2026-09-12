import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyIdentitySchema,
  createGuestAccount,
  resolveAccountForSubject,
} from '../identity/identityStore';
import { createCompany, readMember } from './membership';
import { COMPANY_INVITE_TTL_MS, mintInvite, redeemInvite, revokeInvite } from './invites';

function accessAccount(db: Database.Database, subject: string): string {
  const outcome = resolveAccountForSubject(db, {
    issuer: 'https://issuer',
    subject,
  });
  if ('tutorCapReached' in outcome) throw new Error('unexpected tutor cap');
  return outcome.account.accountId;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function insertSubscription(
  db: Database.Database,
  input: {
    companyId: string;
    quantity: number;
    pendingQuantity?: number | null;
    status?: string;
    collectionMethod?: string;
    firstPaidAt?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO company_subscriptions (
       company_id, processor_subscription_id, quantity, pending_quantity,
       pending_operation_id, status, collection_method, first_paid_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1_000)`,
  ).run(
    input.companyId,
    `sub_${input.companyId}`,
    input.quantity,
    input.pendingQuantity ?? null,
    input.pendingQuantity ? 'op-pending' : null,
    input.status ?? 'active',
    input.collectionMethod ?? 'charge_automatically',
    input.firstPaidAt ?? null,
  );
}

describe('company invites', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  async function companyWithOwner(
    subject: string,
  ): Promise<{ companyId: string; ownerId: string }> {
    const ownerId = accessAccount(db, subject);
    const created = createCompany(db, {
      name: `Company ${subject}`,
      ownerAccountId: ownerId,
      now: 1_000,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    return { companyId: created.company.companyId, ownerId };
  }

  it('mints a hashed, expiring invite token without storing the token', async () => {
    const { companyId, ownerId } = await companyWithOwner('mint-owner');

    const first = await mintInvite(db, {
      companyId,
      role: 'member',
      createdBy: ownerId,
      now: 10_000,
    });

    expect(first.outcome).toBe('minted');
    if (first.outcome !== 'minted') throw new Error('expected a minted invite');
    expect(first.invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.invite.inviteHash).toBe(await sha256Hex(first.invite.token));
    expect(first.invite.expiresAt).toBe(10_000 + COMPANY_INVITE_TTL_MS);

    const row = db
      .prepare(
        `SELECT invite_hash AS inviteHash, company_id AS companyId, role,
                created_by AS createdBy, expires_at AS expiresAt,
                redeemed_by AS redeemedBy, redeemed_at AS redeemedAt,
                revoked_at AS revokedAt, created_at AS createdAt
         FROM company_invites`,
      )
      .get();
    expect(row).toEqual({
      inviteHash: first.invite.inviteHash,
      companyId,
      role: 'member',
      createdBy: ownerId,
      expiresAt: 10_000 + COMPANY_INVITE_TTL_MS,
      redeemedBy: null,
      redeemedAt: null,
      revokedAt: null,
      createdAt: 10_000,
    });

    const second = await mintInvite(db, {
      companyId,
      role: 'admin',
      createdBy: ownerId,
      now: 11_000,
    });
    if (second.outcome !== 'minted') throw new Error('expected a minted invite');
    expect(second.invite.token).not.toBe(first.invite.token);
    expect(second.invite.inviteHash).not.toBe(first.invite.inviteHash);
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM company_invites`).get(),
    ).toEqual({ count: 2 });
  });

  it('revokes only unredeemed invites and only for owner or admin', async () => {
    const { companyId, ownerId } = await companyWithOwner('revoke-invite-owner');
    const memberId = accessAccount(db, 'revoke-invite-member');
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'member', 'active', 2_000)`,
    ).run(companyId, memberId);
    const minted = await mintInvite(db, {
      companyId,
      role: 'member',
      createdBy: ownerId,
      now: 3_000,
    });
    if (minted.outcome !== 'minted') throw new Error('expected a minted invite');

    const forbidden = revokeInvite(db, {
      companyId,
      inviteHash: minted.invite.inviteHash,
      actorAccountId: memberId,
      now: 4_000,
    });
    expect(forbidden).toEqual({ outcome: 'forbidden' });

    const revoked = revokeInvite(db, {
      companyId,
      inviteHash: minted.invite.inviteHash,
      actorAccountId: ownerId,
      now: 5_000,
    });
    expect(revoked).toEqual({ outcome: 'revoked' });
    const row = db
      .prepare(
        `SELECT revoked_at AS revokedAt FROM company_invites WHERE invite_hash = ?`,
      )
      .get(minted.invite.inviteHash);
    expect(row).toEqual({ revokedAt: 5_000 });

    expect(
      revokeInvite(db, {
        companyId,
        inviteHash: minted.invite.inviteHash,
        actorAccountId: ownerId,
        now: 6_000,
      }),
    ).toEqual({ outcome: 'already_revoked' });

    expect(
      revokeInvite(db, {
        companyId,
        inviteHash: 'f'.repeat(64),
        actorAccountId: ownerId,
        now: 6_000,
      }),
    ).toEqual({ outcome: 'not_found' });

    const redeemed = await mintInvite(db, {
      companyId,
      role: 'member',
      createdBy: ownerId,
      now: 7_000,
    });
    if (redeemed.outcome !== 'minted') throw new Error('expected a minted invite');
    db.prepare(
      `UPDATE company_invites SET redeemed_by = ?, redeemed_at = 8_000
       WHERE invite_hash = ?`,
    ).run(memberId, redeemed.invite.inviteHash);

    expect(
      revokeInvite(db, {
        companyId,
        inviteHash: redeemed.invite.inviteHash,
        actorAccountId: ownerId,
        now: 9_000,
      }),
    ).toEqual({ outcome: 'redeemed' });
    expect(
      db
        .prepare(
          `SELECT revoked_at AS revokedAt FROM company_invites WHERE invite_hash = ?`,
        )
        .get(redeemed.invite.inviteHash),
    ).toEqual({ revokedAt: null });
  });

  it('answers unknown, revoked, and expired tokens with the same not-found result', async () => {
    const { companyId, ownerId } = await companyWithOwner('redeem-guards-owner');
    const candidateId = accessAccount(db, 'redeem-guards-candidate');

    expect(
      await redeemInvite(db, {
        token: 'z'.repeat(43),
        accountId: candidateId,
        now: 10_000,
      }),
    ).toEqual({ outcome: 'not_found' });

    const revoked = await mintInvite(db, {
      companyId,
      role: 'member',
      createdBy: ownerId,
      now: 10_000,
    });
    if (revoked.outcome !== 'minted') throw new Error('expected a minted invite');
    revokeInvite(db, {
      companyId,
      inviteHash: revoked.invite.inviteHash,
      actorAccountId: ownerId,
      now: 11_000,
    });
    expect(
      await redeemInvite(db, {
        token: revoked.invite.token,
        accountId: candidateId,
        now: 12_000,
      }),
    ).toEqual({ outcome: 'not_found' });

    const expired = await mintInvite(db, {
      companyId,
      role: 'member',
      createdBy: ownerId,
      now: 20_000,
      ttlMs: 1_000,
    });
    if (expired.outcome !== 'minted') throw new Error('expected a minted invite');
    expect(
      await redeemInvite(db, {
        token: expired.invite.token,
        accountId: candidateId,
        now: 21_000,
      }),
    ).toEqual({ outcome: 'not_found' });
  });

  it('refuses a redemption with no free seat or without an Access account', async () => {
    const { companyId, ownerId } = await companyWithOwner('redeem-capacity-owner');

    const live = await mintInvite(db, {
      companyId,
      role: 'member',
      createdBy: ownerId,
      now: 10_000,
    });
    if (live.outcome !== 'minted') throw new Error('expected a minted invite');

    expect(
      await redeemInvite(db, {
        token: live.invite.token,
        accountId: accessAccount(db, 'redeem-capacity-candidate'),
        now: 11_000,
      }),
    ).toEqual({ outcome: 'no_capacity' });

    const guestId = createGuestAccount(db, {
      roomId: 'guest-room',
      now: 11_500,
    }).accountId;
    expect(
      await redeemInvite(db, { token: live.invite.token, accountId: guestId, now: 12_000 }),
    ).toEqual({ outcome: 'not_found' });

    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM company_members`).get(),
    ).toEqual({ count: 1 });
  });

  it('redeems a token once, copies the role, and keeps it consumed after erasure clears the redeemer', async () => {
    const { companyId, ownerId } = await companyWithOwner('redeem-success-owner');
    insertSubscription(db, { companyId, quantity: 3 });
    const adminId = accessAccount(db, 'redeem-success-admin');
    const otherId = accessAccount(db, 'redeem-success-other');
    const minted = await mintInvite(db, {
      companyId,
      role: 'admin',
      createdBy: ownerId,
      now: 10_000,
    });
    if (minted.outcome !== 'minted') throw new Error('expected a minted invite');

    const redeemed = await redeemInvite(db, {
      token: minted.invite.token,
      accountId: adminId,
      now: 11_000,
    });

    expect(redeemed).toEqual({
      outcome: 'redeemed',
      companyId,
      role: 'admin',
    });
    expect(readMember(db, companyId, adminId)).toMatchObject({
      role: 'admin',
      state: 'active',
      createdAt: 11_000,
    });
    expect(
      db
        .prepare(
          `SELECT redeemed_by AS redeemedBy, redeemed_at AS redeemedAt
           FROM company_invites WHERE invite_hash = ?`,
        )
        .get(minted.invite.inviteHash),
    ).toEqual({ redeemedBy: adminId, redeemedAt: 11_000 });

    expect(
      await redeemInvite(db, {
        token: minted.invite.token,
        accountId: otherId,
        now: 12_000,
      }),
    ).toEqual({ outcome: 'not_found' });

    db.prepare(
      `UPDATE company_invites SET redeemed_by = NULL WHERE invite_hash = ?`,
    ).run(minted.invite.inviteHash);
    expect(
      await redeemInvite(db, {
        token: minted.invite.token,
        accountId: otherId,
        now: 13_000,
      }),
    ).toEqual({ outcome: 'not_found' });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM company_members WHERE company_id = ?`,
        )
        .get(companyId),
    ).toEqual({ count: 2 });
  });

  it('refuses an account that already belongs to a company and allows it after revocation', async () => {
    const { companyId, ownerId } = await companyWithOwner('redeem-member-owner');
    insertSubscription(db, { companyId, quantity: 3 });
    const otherOwnerId = accessAccount(db, 'redeem-member-other-owner');
    const candidateId = accessAccount(db, 'redeem-member-candidate');
    const other = createCompany(db, {
      name: 'Other Co',
      ownerAccountId: otherOwnerId,
      now: 2_000,
    });
    if (other.outcome !== 'created') throw new Error('expected a company');
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'member', 'active', 3_000)`,
    ).run(other.company.companyId, candidateId);
    const minted = await mintInvite(db, {
      companyId,
      role: 'member',
      createdBy: ownerId,
      now: 10_000,
    });
    if (minted.outcome !== 'minted') throw new Error('expected a minted invite');

    expect(
      await redeemInvite(db, {
        token: minted.invite.token,
        accountId: candidateId,
        now: 11_000,
      }),
    ).toEqual({ outcome: 'already_member' });
    expect(readInviteConsumed(db, minted.invite.inviteHash)).toBe(false);

    db.prepare(
      `UPDATE company_members SET state = 'revoked', revoked_at = 11_500
       WHERE company_id = ? AND account_id = ?`,
    ).run(other.company.companyId, candidateId);
    expect(
      await redeemInvite(db, {
        token: minted.invite.token,
        accountId: candidateId,
        now: 12_000,
      }),
    ).toEqual({ outcome: 'redeemed', companyId, role: 'member' });
    expect(readMember(db, companyId, candidateId)).toMatchObject({
      role: 'member',
      state: 'active',
    });
  });

  it('refuses a redemption above the target of a pending seat decrease', async () => {
    const { companyId, ownerId } = await companyWithOwner('redeem-pending-owner');
    insertSubscription(db, { companyId, quantity: 5, pendingQuantity: 2 });
    const memberId = accessAccount(db, 'redeem-pending-member');
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'member', 'active', 1_500)`,
    ).run(companyId, memberId);
    const candidateId = accessAccount(db, 'redeem-pending-candidate');
    const minted = await mintInvite(db, {
      companyId,
      role: 'member',
      createdBy: ownerId,
      now: 10_000,
    });
    if (minted.outcome !== 'minted') throw new Error('expected a minted invite');

    expect(
      await redeemInvite(db, {
        token: minted.invite.token,
        accountId: candidateId,
        now: 11_000,
      }),
    ).toEqual({ outcome: 'no_capacity' });
    expect(readMember(db, companyId, candidateId)).toBeNull();
    expect(readInviteConsumed(db, minted.invite.inviteHash)).toBe(false);
  });

  it('creates the redeemer entitlement only once the company has paid', async () => {
    const { companyId, ownerId } = await companyWithOwner('redeem-entitle-owner');
    insertSubscription(db, { companyId, quantity: 2, firstPaidAt: 4_000 });
    const candidateId = accessAccount(db, 'redeem-entitle-candidate');
    const minted = await mintInvite(db, {
      companyId,
      role: 'member',
      createdBy: ownerId,
      now: 10_000,
    });
    if (minted.outcome !== 'minted') throw new Error('expected a minted invite');

    expect(
      await redeemInvite(db, {
        token: minted.invite.token,
        accountId: candidateId,
        now: 11_000,
      }),
    ).toEqual({ outcome: 'redeemed', companyId, role: 'member' });
    expect(
      db
        .prepare(
          `SELECT source, plan_id AS planId, status, company_id AS companyId,
                  processor_subscription_id AS processorSubscriptionId
           FROM entitlements WHERE account_id = ?`,
        )
        .get(candidateId),
    ).toEqual({
      source: 'company',
      planId: 'corporate_seat',
      status: 'active',
      companyId,
      processorSubscriptionId: `sub_${companyId}`,
    });

    const unpaid = await companyWithOwner('redeem-entitle-unpaid-owner');
    insertSubscription(db, { companyId: unpaid.companyId, quantity: 2 });
    const unpaidCandidateId = accessAccount(db, 'redeem-entitle-unpaid-candidate');
    const unpaidMinted = await mintInvite(db, {
      companyId: unpaid.companyId,
      role: 'member',
      createdBy: unpaid.ownerId,
      now: 10_000,
    });
    if (unpaidMinted.outcome !== 'minted') {
      throw new Error('expected a minted invite');
    }
    expect(
      await redeemInvite(db, {
        token: unpaidMinted.invite.token,
        accountId: unpaidCandidateId,
        now: 11_000,
      }),
    ).toEqual({
      outcome: 'redeemed',
      companyId: unpaid.companyId,
      role: 'member',
    });
    expect(
      db
        .prepare(`SELECT COUNT(*) AS count FROM entitlements WHERE account_id = ?`)
        .get(unpaidCandidateId),
    ).toEqual({ count: 0 });
  });
});

function readInviteConsumed(db: Database.Database, inviteHash: string): boolean {
  const row = db
    .prepare(
      `SELECT redeemed_at AS redeemedAt FROM company_invites WHERE invite_hash = ?`,
    )
    .get(inviteHash) as { redeemedAt: number | null } | undefined;
  return row?.redeemedAt !== null && row?.redeemedAt !== undefined;
}
