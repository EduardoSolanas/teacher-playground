import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyIdentitySchema,
  resolveAccountForSubject,
} from '../identity/identityStore';
import { createCompany } from './membership';
import {
  activeMemberCount,
  readCompanySubscription,
  readPendingSeatChange,
  readSeatChangeOperation,
  releaseSeatChange,
  reserveSeatChange,
  seatCapacity,
  settleSeatChange,
} from './seats';

function accessAccount(db: Database.Database, subject: string): string {
  const outcome = resolveAccountForSubject(db, {
    issuer: 'https://issuer',
    subject,
  });
  if ('tutorCapReached' in outcome) throw new Error('unexpected tutor cap');
  return outcome.account.accountId;
}

function createSeatedCompany(
  db: Database.Database,
  input: {
    ownerSubject: string;
    quantity?: number;
    pendingQuantity?: number | null;
    pendingOperationId?: string | null;
    status?: string;
    collectionMethod?: string;
    firstPaidAt?: number | null;
    now?: number;
  },
): { companyId: string; ownerId: string } {
  const ownerId = accessAccount(db, input.ownerSubject);
  const created = createCompany(db, {
    name: `Company ${input.ownerSubject}`,
    ownerAccountId: ownerId,
    now: input.now ?? 1_000,
  });
  if (created.outcome !== 'created') throw new Error('expected a company');
  const { companyId } = created.company;
  db.prepare(
    `INSERT INTO company_subscriptions (
       company_id, processor_subscription_id, quantity, pending_quantity,
       pending_operation_id, status, collection_method, first_paid_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    companyId,
    `sub_${input.ownerSubject}`,
    input.quantity ?? 3,
    input.pendingQuantity ?? null,
    input.pendingOperationId ?? null,
    input.status ?? 'active',
    input.collectionMethod ?? 'charge_automatically',
    input.firstPaidAt ?? null,
    input.now ?? 1_000,
  );
  return { companyId, ownerId };
}

describe('company seats', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  it('gives a company without a subscription exactly one seat', () => {
    const ownerId = accessAccount(db, 'no-sub-owner');
    const created = createCompany(db, {
      name: 'No Sub Co',
      ownerAccountId: ownerId,
      now: 1_000,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');

    expect(readCompanySubscription(db, created.company.companyId)).toBeNull();
    expect(seatCapacity(db, created.company.companyId)).toBe(1);
    expect(activeMemberCount(db, created.company.companyId)).toBe(1);
  });

  it('reads capacity from quantity and clamps it to a pending change', () => {
    const settled = createSeatedCompany(db, {
      ownerSubject: 'capacity-settled',
      quantity: 5,
    });
    expect(seatCapacity(db, settled.companyId)).toBe(5);

    const decreasing = createSeatedCompany(db, {
      ownerSubject: 'capacity-decreasing',
      quantity: 5,
      pendingQuantity: 2,
      pendingOperationId: 'op-decrease',
    });
    expect(seatCapacity(db, decreasing.companyId)).toBe(2);

    const increasing = createSeatedCompany(db, {
      ownerSubject: 'capacity-increasing',
      quantity: 5,
      pendingQuantity: 8,
      pendingOperationId: 'op-increase',
    });
    expect(seatCapacity(db, increasing.companyId)).toBe(5);
  });

  it('reserves a seat change as a pending operation with its Stripe parameters', () => {
    const { companyId, ownerId } = createSeatedCompany(db, {
      ownerSubject: 'reserve-happy',
      quantity: 3,
    });

    const increase = reserveSeatChange(db, {
      companyId,
      actorAccountId: ownerId,
      targetQuantity: 5,
      operationId: 'op-reserve-increase',
      requestHash: 'hash-increase',
      now: 2_000,
    });

    expect(increase).toEqual({
      outcome: 'reserved',
      operationId: 'op-reserve-increase',
      targetQuantity: 5,
      direction: 'increase',
      prorationBehavior: 'create_prorations',
    });
    expect(readPendingSeatChange(db, companyId)).toMatchObject({
      operationId: 'op-reserve-increase',
      requestHash: 'hash-increase',
      status: 'pending',
    });
    expect(readCompanySubscription(db, companyId)).toMatchObject({
      quantity: 3,
      pendingQuantity: 5,
      pendingOperationId: 'op-reserve-increase',
    });
    expect(seatCapacity(db, companyId)).toBe(3);

    const decreaseOwner = accessAccount(db, 'reserve-decrease-owner');
    const created = createCompany(db, {
      name: 'Reserve Decrease Co',
      ownerAccountId: decreaseOwner,
      now: 1_000,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    db.prepare(
      `INSERT INTO company_subscriptions (
         company_id, processor_subscription_id, quantity, status,
         collection_method, updated_at
       ) VALUES (?, 'sub_reserve_decrease', 5, 'active', 'charge_automatically', 1_000)`,
    ).run(created.company.companyId);

    const decrease = reserveSeatChange(db, {
      companyId: created.company.companyId,
      actorAccountId: decreaseOwner,
      targetQuantity: 3,
      operationId: 'op-reserve-decrease',
      requestHash: 'hash-decrease',
      now: 2_000,
    });

    expect(decrease).toEqual({
      outcome: 'reserved',
      operationId: 'op-reserve-decrease',
      targetQuantity: 3,
      direction: 'decrease',
      prorationBehavior: 'none',
    });
    expect(readCompanySubscription(db, created.company.companyId)).toMatchObject({
      quantity: 5,
      pendingQuantity: 3,
      pendingOperationId: 'op-reserve-decrease',
    });
    expect(seatCapacity(db, created.company.companyId)).toBe(3);
  });

  it('refuses a seat change while another is pending or below active members', () => {
    const { companyId, ownerId } = createSeatedCompany(db, {
      ownerSubject: 'reserve-guards',
      quantity: 5,
    });
    const memberId = accessAccount(db, 'reserve-guards-member');
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'member', 'active', 1_500)`,
    ).run(companyId, memberId);

    const extraOwnerId = accessAccount(db, 'reserve-guards-extra');
    const extra = createCompany(db, {
      name: 'Second Guard Co',
      ownerAccountId: extraOwnerId,
      now: 1_000,
    });
    if (extra.outcome !== 'created') throw new Error('expected a company');
    db.prepare(
      `INSERT INTO company_subscriptions (
         company_id, processor_subscription_id, quantity, pending_quantity,
         pending_operation_id, status, collection_method, updated_at
       ) VALUES (?, 'sub_reserve_guard_pending', 5, 2, 'op-already-pending',
                 'active', 'charge_automatically', 1_000)`,
    ).run(extra.company.companyId);

    const pending = reserveSeatChange(db, {
      companyId: extra.company.companyId,
      actorAccountId: extraOwnerId,
      targetQuantity: 4,
      operationId: 'op-should-not-reserve',
      requestHash: 'hash-pending',
      now: 2_000,
    });
    expect(pending).toEqual({ outcome: 'change_pending' });

    const below = reserveSeatChange(db, {
      companyId,
      actorAccountId: ownerId,
      targetQuantity: 1,
      operationId: 'op-below-members',
      requestHash: 'hash-below',
      now: 2_000,
    });
    expect(below).toEqual({ outcome: 'below_active_members' });

    const forbidden = reserveSeatChange(db, {
      companyId,
      actorAccountId: accessAccount(db, 'reserve-guards-outsider'),
      targetQuantity: 6,
      operationId: 'op-forbidden',
      requestHash: 'hash-forbidden',
      now: 2_000,
    });
    expect(forbidden).toEqual({ outcome: 'forbidden' });

    const missing = reserveSeatChange(db, {
      companyId: 'no-such-company',
      actorAccountId: ownerId,
      targetQuantity: 6,
      operationId: 'op-missing',
      requestHash: 'hash-missing',
      now: 2_000,
    });
    expect(missing).toEqual({ outcome: 'not_found' });

    expect(readPendingSeatChange(db, companyId)).toBeNull();
  });

  it('releases a definitively failed change, keeps an unknown outcome pending, and settles on success', () => {
    const { companyId, ownerId } = createSeatedCompany(db, {
      ownerSubject: 'seat-outcome',
      quantity: 3,
    });

    const releaseOp = reserveSeatChange(db, {
      companyId,
      actorAccountId: ownerId,
      targetQuantity: 4,
      operationId: 'op-release',
      requestHash: 'hash-release',
      now: 2_000,
    });
    expect(releaseOp.outcome).toBe('reserved');
    expect(
      releaseSeatChange(db, { companyId, operationId: 'op-release', now: 3_000 }),
    ).toEqual({ released: true });
    expect(readSeatChangeOperation(db, companyId, 'op-release')).toMatchObject({
      status: 'failed',
      updatedAt: 3_000,
    });

    const unknownOp = reserveSeatChange(db, {
      companyId,
      actorAccountId: ownerId,
      targetQuantity: 5,
      operationId: 'op-unknown',
      requestHash: 'hash-unknown',
      now: 4_000,
    });
    expect(unknownOp.outcome).toBe('reserved');
    expect(readPendingSeatChange(db, companyId)).toMatchObject({
      operationId: 'op-unknown',
      status: 'pending',
    });
    expect(
      reserveSeatChange(db, {
        companyId,
        actorAccountId: ownerId,
        targetQuantity: 6,
        operationId: 'op-after-unknown',
        requestHash: 'hash-after-unknown',
        now: 5_000,
      }),
    ).toEqual({ outcome: 'change_pending' });

    expect(
      settleSeatChange(db, { companyId, operationId: 'op-unknown', now: 6_000 }),
    ).toEqual({ settled: true });
    expect(readSeatChangeOperation(db, companyId, 'op-unknown')).toMatchObject({
      status: 'succeeded',
      updatedAt: 6_000,
    });

    expect(
      settleSeatChange(db, { companyId, operationId: 'op-release', now: 7_000 }),
    ).toEqual({ settled: false });
    expect(
      releaseSeatChange(db, { companyId, operationId: 'op-unknown', now: 7_000 }),
    ).toEqual({ released: false });
  });

  it('applies the reserved target and clears it when a seat change settles', () => {
    const { companyId, ownerId } = createSeatedCompany(db, {
      ownerSubject: 'settle-applies',
      quantity: 3,
    });

    expect(
      reserveSeatChange(db, {
        companyId,
        actorAccountId: ownerId,
        targetQuantity: 5,
        operationId: 'op-settle-applies',
        requestHash: 'hash-settle-applies',
        now: 2_000,
      }).outcome,
    ).toBe('reserved');
    expect(seatCapacity(db, companyId)).toBe(3);

    expect(
      settleSeatChange(db, {
        companyId,
        operationId: 'op-settle-applies',
        now: 3_000,
      }),
    ).toEqual({ settled: true });
    expect(readCompanySubscription(db, companyId)).toMatchObject({
      quantity: 5,
      pendingQuantity: null,
      pendingOperationId: null,
    });
    expect(seatCapacity(db, companyId)).toBe(5);

    expect(
      reserveSeatChange(db, {
        companyId,
        actorAccountId: ownerId,
        targetQuantity: 4,
        operationId: 'op-after-settle',
        requestHash: 'hash-after-settle',
        now: 4_000,
      }).outcome,
    ).toBe('reserved');
    expect(seatCapacity(db, companyId)).toBe(4);
  });

  it('clears the reservation without applying it when a seat change is released', () => {
    const { companyId, ownerId } = createSeatedCompany(db, {
      ownerSubject: 'release-clears',
      quantity: 5,
    });

    expect(
      reserveSeatChange(db, {
        companyId,
        actorAccountId: ownerId,
        targetQuantity: 2,
        operationId: 'op-release-clears',
        requestHash: 'hash-release-clears',
        now: 2_000,
      }).outcome,
    ).toBe('reserved');
    expect(seatCapacity(db, companyId)).toBe(2);

    expect(
      releaseSeatChange(db, {
        companyId,
        operationId: 'op-release-clears',
        now: 3_000,
      }),
    ).toEqual({ released: true });
    expect(readCompanySubscription(db, companyId)).toMatchObject({
      quantity: 5,
      pendingQuantity: null,
      pendingOperationId: null,
    });
    expect(seatCapacity(db, companyId)).toBe(5);
  });
});
