import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyIdentitySchema,
  createGuestAccount,
  recordOwnedRoom,
  resolveAccountForSubject,
} from '../identity/identityStore';
import { ensureBillingSubscription } from '../identity/entitlementWriter';
import {
  CompanyOwnerAssertionError,
  assertOneActiveOwner,
  createCompany,
  disableCompany,
  readActiveMembership,
  readCompany,
  readMember,
  revokeMember,
  transferOwnership,
  transferOwnershipForErasure,
} from './membership';

function accessAccount(db: Database.Database, subject: string): string {
  const outcome = resolveAccountForSubject(db, {
    issuer: 'https://issuer',
    subject,
  });
  if ('tutorCapReached' in outcome) throw new Error('unexpected tutor cap');
  return outcome.account.accountId;
}

describe('company membership', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  it('creates the company and its owner membership in one transaction', () => {
    const ownerId = accessAccount(db, 'owner-1');

    const result = createCompany(db, {
      name: 'Ada Tutoring',
      ownerAccountId: ownerId,
      now: 1_000,
    });

    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') throw new Error('expected a created company');
    expect(result.company.name).toBe('Ada Tutoring');
    expect(result.company.state).toBe('active');
    expect(result.company.invoiceApproved).toBe(false);
    expect(result.company.processorCustomerId).toBeNull();
    expect(result.company.createdAt).toBe(1_000);
    expect(readActiveMembership(db, ownerId)).toMatchObject({
      companyId: result.company.companyId,
      accountId: ownerId,
      role: 'owner',
      state: 'active',
    });
  });

  it('refuses a founder who already has an active membership and creates nothing', () => {
    const founderId = accessAccount(db, 'founder-twice');
    const first = createCompany(db, {
      name: 'First',
      ownerAccountId: founderId,
      now: 1_000,
    });
    if (first.outcome !== 'created') throw new Error('expected the first company');

    const second = createCompany(db, {
      name: 'Second',
      ownerAccountId: founderId,
      now: 2_000,
    });

    expect(second).toEqual({ outcome: 'membership_conflict' });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM companies`).get(),
    ).toEqual({ count: 1 });
    expect(readActiveMembership(db, founderId)).toMatchObject({
      companyId: first.company.companyId,
    });
  });

  it('rolls the company insert back when the owner cannot be a member', () => {
    const guestId = createGuestAccount(db, { roomId: 'guest-room', now: 1 }).accountId;

    expect(() =>
      createCompany(db, { name: 'Guest Co', ownerAccountId: guestId, now: 2_000 }),
    ).toThrow(/provenance/);

    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM companies`).get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM company_members`).get(),
    ).toEqual({ count: 0 });
  });

  it('asserts an active company has at least one active owner', () => {
    const ownerId = accessAccount(db, 'assert-owner');
    const created = createCompany(db, {
      name: 'Assert Co',
      ownerAccountId: ownerId,
      now: 1_000,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    const { companyId } = created.company;

    expect(() => assertOneActiveOwner(db, companyId)).not.toThrow();

    db.prepare(
      `UPDATE company_members SET state = 'revoked', revoked_at = 2_000
       WHERE company_id = ? AND account_id = ?`,
    ).run(companyId, ownerId);
    expect(() => assertOneActiveOwner(db, companyId)).toThrow(
      CompanyOwnerAssertionError,
    );

    db.prepare(
      `UPDATE companies SET state = 'disabled', updated_at = 2_000 WHERE company_id = ?`,
    ).run(companyId);
    expect(() => assertOneActiveOwner(db, companyId)).not.toThrow();
  });

  it('refuses to revoke the owner and leaves exactly one active owner', () => {
    const ownerId = accessAccount(db, 'revoke-owner');
    const created = createCompany(db, {
      name: 'Revoke Co',
      ownerAccountId: ownerId,
      now: 1_000,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    const { companyId } = created.company;

    const result = revokeMember(db, {
      companyId,
      accountId: ownerId,
      actorAccountId: ownerId,
      now: 2_000,
    });

    expect(result).toEqual({ outcome: 'owner' });
    expect(readActiveMembership(db, ownerId)).toMatchObject({ role: 'owner' });
    expect(() => assertOneActiveOwner(db, companyId)).not.toThrow();
  });

  it('revokes a non-owner member and leaves exactly one active owner', () => {
    const ownerId = accessAccount(db, 'revoke-target-owner');
    const adminId = accessAccount(db, 'revoke-admin');
    const memberId = accessAccount(db, 'revoke-member');
    const created = createCompany(db, {
      name: 'Revoke Team',
      ownerAccountId: ownerId,
      now: 1_000,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    const { companyId } = created.company;
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'admin', 'active', 2_000), (?, ?, 'member', 'active', 3_000)`,
    ).run(companyId, adminId, companyId, memberId);

    const result = revokeMember(db, {
      companyId,
      accountId: memberId,
      actorAccountId: adminId,
      now: 4_000,
    });

    expect(result).toEqual({ outcome: 'revoked', accountId: memberId });
    expect(readMember(db, companyId, memberId)).toMatchObject({
      state: 'revoked',
      revokedAt: 4_000,
    });
    expect(readActiveMembership(db, ownerId)).toMatchObject({ role: 'owner' });
    expect(() => assertOneActiveOwner(db, companyId)).not.toThrow();
  });

  it('forbids a plain member from revoking another member', () => {
    const ownerId = accessAccount(db, 'revoke-forbid-owner');
    const memberId = accessAccount(db, 'revoke-forbid-member');
    const otherId = accessAccount(db, 'revoke-forbid-other');
    const created = createCompany(db, {
      name: 'Forbid Co',
      ownerAccountId: ownerId,
      now: 1_000,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    const { companyId } = created.company;
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'member', 'active', 2_000), (?, ?, 'member', 'active', 3_000)`,
    ).run(companyId, memberId, companyId, otherId);

    const result = revokeMember(db, {
      companyId,
      accountId: otherId,
      actorAccountId: memberId,
      now: 4_000,
    });

    expect(result).toEqual({ outcome: 'forbidden' });
    expect(readMember(db, companyId, otherId)).toMatchObject({ state: 'active' });
  });

  it('transfers ownership and leaves exactly one active owner', () => {
    const ownerId = accessAccount(db, 'transfer-owner');
    const memberId = accessAccount(db, 'transfer-member');
    const created = createCompany(db, {
      name: 'Transfer Co',
      ownerAccountId: ownerId,
      now: 1_000,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    const { companyId } = created.company;
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'member', 'active', 2_000)`,
    ).run(companyId, memberId);

    const result = transferOwnership(db, {
      companyId,
      actorAccountId: ownerId,
      targetAccountId: memberId,
      now: 3_000,
    });

    expect(result).toEqual({ outcome: 'transferred', accountId: memberId });
    expect(readMember(db, companyId, ownerId)).toMatchObject({ role: 'admin' });
    expect(readMember(db, companyId, memberId)).toMatchObject({ role: 'owner' });
    expect(() => assertOneActiveOwner(db, companyId)).not.toThrow();
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM company_members
           WHERE company_id = ? AND role = 'owner' AND state = 'active'`,
        )
        .get(companyId),
    ).toEqual({ count: 1 });
  });

  it('rolls back a transfer that would leave the company ownerless', () => {
    const ownerId = accessAccount(db, 'transfer-rollback-owner');
    const revokedId = accessAccount(db, 'transfer-rollback-revoked');
    const created = createCompany(db, {
      name: 'Rollback Co',
      ownerAccountId: ownerId,
      now: 1_000,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    const { companyId } = created.company;
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at, revoked_at)
       VALUES (?, ?, 'member', 'revoked', 2_000, 3_000)`,
    ).run(companyId, revokedId);

    expect(() =>
      transferOwnership(db, {
        companyId,
        actorAccountId: ownerId,
        targetAccountId: revokedId,
        now: 4_000,
      }),
    ).toThrow(CompanyOwnerAssertionError);

    expect(readMember(db, companyId, ownerId)).toMatchObject({
      role: 'owner',
      state: 'active',
    });
    expect(() => assertOneActiveOwner(db, companyId)).not.toThrow();
  });

  it('transfers to the earliest active admin for erasure, else the earliest member', () => {
    const ownerId = accessAccount(db, 'erasure-owner');
    const lateAdminId = accessAccount(db, 'erasure-admin-late');
    const earlyAdminId = accessAccount(db, 'erasure-admin-early');
    const withAdmin = createCompany(db, {
      name: 'Erasure Admin Co',
      ownerAccountId: ownerId,
      now: 1_000,
    });
    if (withAdmin.outcome !== 'created') throw new Error('expected a company');
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'admin', 'active', 5_000), (?, ?, 'admin', 'active', 2_000)`,
    ).run(
      withAdmin.company.companyId,
      lateAdminId,
      withAdmin.company.companyId,
      earlyAdminId,
    );

    const adminResult = transferOwnershipForErasure(db, {
      companyId: withAdmin.company.companyId,
      erasingAccountId: ownerId,
      now: 6_000,
    });

    expect(adminResult).toEqual({
      outcome: 'transferred',
      accountId: earlyAdminId,
    });
    expect(readMember(db, withAdmin.company.companyId, earlyAdminId)).toMatchObject({
      role: 'owner',
    });

    const memberOwnerId = accessAccount(db, 'erasure-member-owner');
    const lateMemberId = accessAccount(db, 'erasure-member-late');
    const earlyMemberId = accessAccount(db, 'erasure-member-early');
    const withMember = createCompany(db, {
      name: 'Erasure Member Co',
      ownerAccountId: memberOwnerId,
      now: 1_000,
    });
    if (withMember.outcome !== 'created') throw new Error('expected a company');
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'member', 'active', 5_000), (?, ?, 'member', 'active', 2_000)`,
    ).run(
      withMember.company.companyId,
      lateMemberId,
      withMember.company.companyId,
      earlyMemberId,
    );

    const memberResult = transferOwnershipForErasure(db, {
      companyId: withMember.company.companyId,
      erasingAccountId: memberOwnerId,
      now: 6_000,
    });

    expect(memberResult).toEqual({
      outcome: 'transferred',
      accountId: earlyMemberId,
    });
    expect(readMember(db, withMember.company.companyId, earlyMemberId)).toMatchObject({
      role: 'owner',
    });
  });

  it('reports a sole-member owner for erasure without changing the company', () => {
    const ownerId = accessAccount(db, 'erasure-sole-owner');
    const created = createCompany(db, {
      name: 'Sole Co',
      ownerAccountId: ownerId,
      now: 1_000,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');

    const result = transferOwnershipForErasure(db, {
      companyId: created.company.companyId,
      erasingAccountId: ownerId,
      now: 2_000,
    });

    expect(result).toEqual({ outcome: 'sole_member' });
    expect(readMember(db, created.company.companyId, ownerId)).toMatchObject({
      role: 'owner',
      state: 'active',
    });
    expect(readCompany(db, created.company.companyId)).toMatchObject({
      state: 'active',
    });
  });

  it('disables the company, revokes every seat, stops collection, and leaves rooms untouched', () => {
    const ownerId = accessAccount(db, 'disable-owner');
    const memberId = accessAccount(db, 'disable-member');
    const created = createCompany(db, {
      name: 'Disable Co',
      ownerAccountId: ownerId,
      now: 1_000,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    const { companyId } = created.company;
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'member', 'active', 2_000)`,
    ).run(companyId, memberId);
    db.prepare(
      `INSERT INTO company_subscriptions (
         company_id, processor_subscription_id, quantity, status,
         collection_method, updated_at
       ) VALUES (?, 'sub_disable', 3, 'active', 'charge_automatically', 1_000)`,
    ).run(companyId);
    ensureBillingSubscription(db, {
      processorSubscriptionId: 'sub_disable',
      subjectKind: 'company',
      subjectId: companyId,
      now: 1_000,
    });
    recordOwnedRoom(db, {
      accountId: ownerId,
      roomId: 'disable-room-1',
      name: 'Kept Room',
      now: 1_500,
    });

    const result = disableCompany(db, {
      companyId,
      actorAccountId: ownerId,
      now: 9_000,
    });

    expect(result.outcome).toBe('disabled');
    if (result.outcome !== 'disabled') throw new Error('expected disabled');
    expect([...result.revokedAccountIds].sort()).toEqual(
      [ownerId, memberId].sort(),
    );
    expect(readCompany(db, companyId)).toMatchObject({ state: 'disabled' });
    expect(readMember(db, companyId, ownerId)).toMatchObject({
      role: 'owner',
      state: 'revoked',
      revokedAt: 9_000,
    });
    expect(readMember(db, companyId, memberId)).toMatchObject({
      state: 'revoked',
      revokedAt: 9_000,
    });
    expect(readActiveMembership(db, ownerId)).toBeNull();
    expect(
      db
        .prepare(
          `SELECT desired_collection AS desiredCollection, applied_version AS appliedVersion
           FROM billing_subscriptions WHERE processor_subscription_id = 'sub_disable'`,
        )
        .get(),
    ).toEqual({ desiredCollection: 'canceled', appliedVersion: 1 });
    expect(
      db
        .prepare(
          `SELECT name, updated_at AS updatedAt FROM account_rooms
           WHERE account_id = ? AND room_id = ?`,
        )
        .get(ownerId, 'disable-room-1'),
    ).toEqual({ name: 'Kept Room', updatedAt: 1_500 });
  });

  it('forbids a non-owner from disabling the company', () => {
    const ownerId = accessAccount(db, 'disable-forbid-owner');
    const memberId = accessAccount(db, 'disable-forbid-member');
    const created = createCompany(db, {
      name: 'Forbid Disable Co',
      ownerAccountId: ownerId,
      now: 1_000,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    const { companyId } = created.company;
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'admin', 'active', 2_000)`,
    ).run(companyId, memberId);

    const result = disableCompany(db, {
      companyId,
      actorAccountId: memberId,
      now: 9_000,
    });

    expect(result).toEqual({ outcome: 'forbidden' });
    expect(readCompany(db, companyId)).toMatchObject({ state: 'active' });
    expect(readMember(db, companyId, ownerId)).toMatchObject({ state: 'active' });
  });
});
