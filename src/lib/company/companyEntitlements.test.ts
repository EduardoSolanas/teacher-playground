import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyIdentitySchema,
  resolveAccountForSubject,
} from '../identity/identityStore';
import { setCompanyFirstPaidAt } from '../identity/entitlementWriter';
import type { EntitlementCause } from '../identity/entitlementWriter';
import { createCompany } from './membership';
import {
  materializeCompanyMemberEntitlements,
  materializeCompanyMemberEntitlement,
} from './companyEntitlements';

function accessAccount(db: Database.Database, subject: string): string {
  const outcome = resolveAccountForSubject(db, {
    issuer: 'https://issuer',
    subject,
  });
  if ('tutorCapReached' in outcome) throw new Error('unexpected tutor cap');
  return outcome.account.accountId;
}

function cause(id: string): EntitlementCause {
  return { kind: 'processor_event', id, actor: 'stripe', reason: 'invoice.paid' };
}

describe('company member entitlements', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  function companyWithSubscription(input: {
    ownerSubject: string;
    status?: string;
    collectionMethod?: string;
    collectionPaused?: number;
    graceUntil?: number | null;
    firstPaidAt?: number | null;
    currentPeriodEnd?: number | null;
  }): { companyId: string; ownerId: string } {
    const ownerId = accessAccount(db, input.ownerSubject);
    const created = createCompany(db, {
      name: `Company ${input.ownerSubject}`,
      ownerAccountId: ownerId,
      now: 1_000,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    const { companyId } = created.company;
    db.prepare(
      `UPDATE companies SET processor_customer_id = ? WHERE company_id = ?`,
    ).run(`cus_${input.ownerSubject}`, companyId);
    db.prepare(
      `INSERT INTO company_subscriptions (
         company_id, processor_subscription_id, quantity, status, grace_until,
         collection_paused, collection_method, current_period_end,
         first_paid_at, updated_at
       ) VALUES (?, ?, 3, ?, ?, ?, ?, ?, ?, 1_000)`,
    ).run(
      companyId,
      `sub_${input.ownerSubject}`,
      input.status ?? 'active',
      input.graceUntil ?? null,
      input.collectionPaused ?? 0,
      input.collectionMethod ?? 'charge_automatically',
      input.currentPeriodEnd ?? null,
      input.firstPaidAt ?? null,
    );
    return { companyId, ownerId };
  }

  function addMember(companyId: string, subject: string): string {
    const accountId = accessAccount(db, subject);
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'member', 'active', 2_000)`,
    ).run(companyId, accountId);
    return accountId;
  }

  function entitlementRows(companyId: string) {
    return db
      .prepare(
        `SELECT account_id AS accountId, source, plan_id AS planId, status,
                grace_until AS graceUntil, collection_paused AS collectionPaused,
                company_id AS companyId, current_period_end AS currentPeriodEnd,
                processor_customer_id AS processorCustomerId,
                processor_subscription_id AS processorSubscriptionId
         FROM entitlements WHERE company_id = ? ORDER BY account_id`,
      )
      .all(companyId);
  }

  function auditCount(): number {
    return (
      db.prepare(`SELECT COUNT(*) AS count FROM entitlement_audit`).get() as {
        count: number;
      }
    ).count;
  }

  it('materializes nothing while the company invoice is unpaid', () => {
    const { companyId, ownerId } = companyWithSubscription({
      ownerSubject: 'unpaid-owner',
      status: 'unpaid',
      collectionMethod: 'send_invoice',
      firstPaidAt: null,
    });
    const memberId = addMember(companyId, 'unpaid-member');

    const result = materializeCompanyMemberEntitlements(db, {
      companyId,
      cause: cause('evt_unpaid'),
      now: 5_000,
    });

    expect(result).toEqual({ materialized: 0 });
    expect(entitlementRows(companyId)).toEqual([]);
    expect(auditCount()).toBe(0);
    expect(
      materializeCompanyMemberEntitlement(db, {
        companyId,
        accountId: ownerId,
        cause: cause('evt_unpaid_one'),
        now: 5_000,
      }),
    ).toEqual({ changed: false });
    expect(
      materializeCompanyMemberEntitlement(db, {
        companyId,
        accountId: memberId,
        cause: cause('evt_unpaid_two'),
        now: 5_000,
      }),
    ).toEqual({ changed: false });
  });

  it('materializes every active member once on the first paid invoice', () => {
    const { companyId, ownerId } = companyWithSubscription({
      ownerSubject: 'paid-owner',
      status: 'active',
      firstPaidAt: null,
      currentPeriodEnd: 777_000,
    });
    const memberId = addMember(companyId, 'paid-member');
    setCompanyFirstPaidAt(db, {
      processorSubscriptionId: 'sub_paid-owner',
      occurredAt: 4_000,
    });

    const first = materializeCompanyMemberEntitlements(db, {
      companyId,
      cause: cause('evt_paid_first'),
      now: 5_000,
    });

    expect(first).toEqual({ materialized: 2 });
    expect(entitlementRows(companyId)).toEqual([
      {
        accountId: ownerId,
        source: 'company',
        planId: 'corporate_seat',
        status: 'active',
        graceUntil: null,
        collectionPaused: 0,
        companyId,
        currentPeriodEnd: 777_000,
        processorCustomerId: 'cus_paid-owner',
        processorSubscriptionId: 'sub_paid-owner',
      },
      {
        accountId: memberId,
        source: 'company',
        planId: 'corporate_seat',
        status: 'active',
        graceUntil: null,
        collectionPaused: 0,
        companyId,
        currentPeriodEnd: 777_000,
        processorCustomerId: 'cus_paid-owner',
        processorSubscriptionId: 'sub_paid-owner',
      },
    ].sort((left, right) => left.accountId.localeCompare(right.accountId)));
    expect(auditCount()).toBe(2);

    expect(
      materializeCompanyMemberEntitlements(db, {
        companyId,
        cause: cause('evt_paid_first'),
        now: 6_000,
      }),
    ).toEqual({ materialized: 0 });
    expect(auditCount()).toBe(2);

    expect(
      materializeCompanyMemberEntitlements(db, {
        companyId,
        cause: cause('evt_paid_later'),
        now: 7_000,
      }),
    ).toEqual({ materialized: 0 });
    expect(auditCount()).toBe(2);
  });

  it('copies the company past_due grace and pause to every member row', () => {
    const { companyId, ownerId } = companyWithSubscription({
      ownerSubject: 'grace-owner',
      status: 'past_due',
      graceUntil: 600_000,
      collectionPaused: 1,
      firstPaidAt: 4_000,
      currentPeriodEnd: 500_000,
    });

    const result = materializeCompanyMemberEntitlements(db, {
      companyId,
      cause: cause('evt_grace'),
      now: 5_000,
    });

    expect(result).toEqual({ materialized: 1 });
    expect(entitlementRows(companyId)).toEqual([
      {
        accountId: ownerId,
        source: 'company',
        planId: 'corporate_seat',
        status: 'past_due',
        graceUntil: 600_000,
        collectionPaused: 1,
        companyId,
        currentPeriodEnd: 500_000,
        processorCustomerId: 'cus_grace-owner',
        processorSubscriptionId: 'sub_grace-owner',
      },
    ]);
  });
});
