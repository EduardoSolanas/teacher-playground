import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyIdentitySchema,
  resolveAccountForSubject,
} from '../identity/identityStore';
import {
  ensureBillingSubscription,
  readEntitlementsForAccount,
  recomputeDesiredCollection,
  upsertDisputeHold,
  writeEntitlement,
} from '../identity/entitlementWriter';
import { createCompany } from './membership';
import { readCompanySubscription, seatCapacity } from './seats';
import {
  approveCompanyInvoice,
  normalizeOperatorEmail,
  operatorEmailFor,
  parseOperatorEmails,
  reviewDisputeHold,
  settleCompanyInvoice,
} from './operator';

describe('company operator allowlist', () => {
  it('splits, trims, and lowercases a comma-separated allowlist', () => {
    expect([...parseOperatorEmails(' ops@example.test ,Ada@Example.Test ,, ')]).toEqual([
      'ops@example.test',
      'ada@example.test',
    ]);
  });

  it('treats an unset, empty, or all-blank allowlist as disabled', () => {
    expect(parseOperatorEmails(undefined).size).toBe(0);
    expect(parseOperatorEmails(null).size).toBe(0);
    expect(parseOperatorEmails('').size).toBe(0);
    expect(parseOperatorEmails(' , , ').size).toBe(0);
  });

  it('ignores allowlist entries that are not usable emails', () => {
    expect(
      parseOperatorEmails('not-an-email, ,missing@,ops@example.test,@example.test'),
    ).toEqual(new Set(['ops@example.test']));
  });

  it('returns the normalized caller email only when the allowlist contains it', () => {
    expect(operatorEmailFor('ops@example.test', 'OPS@Example.Test')).toBe('ops@example.test');
    expect(operatorEmailFor('ops@example.test,ada@example.test', 'ada@example.test')).toBe(
      'ada@example.test',
    );
    expect(operatorEmailFor('ops@example.test', 'outsider@example.test')).toBeNull();
    expect(operatorEmailFor(undefined, 'ops@example.test')).toBeNull();
    expect(operatorEmailFor('ops@example.test', undefined)).toBeNull();
    expect(operatorEmailFor('ops@example.test', '')).toBeNull();
  });

  it('normalizes only strings that look like a single bounded email', () => {
    expect(normalizeOperatorEmail(' Ops@Example.Test ')).toBe('ops@example.test');
    expect(normalizeOperatorEmail('')).toBeNull();
    expect(normalizeOperatorEmail('two words@example.test')).toBeNull();
    expect(normalizeOperatorEmail('a@b@c')).toBeNull();
    expect(normalizeOperatorEmail('ops@example.test,ada@example.test')).toBeNull();
    expect(normalizeOperatorEmail(`${'a'.repeat(250)}@example.test`)).toBeNull();
    expect(normalizeOperatorEmail('not-an-email')).toBeNull();
  });
});

describe('company operator invoice approval (O-1)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  function accessAccount(subject: string): string {
    const outcome = resolveAccountForSubject(db, {
      issuer: 'https://issuer',
      subject,
    });
    if ('tutorCapReached' in outcome) throw new Error('unexpected tutor cap');
    return outcome.account.accountId;
  }

  function operatorCompany(
    subject: string,
    options: { customer?: string | null } = {},
  ): { companyId: string; ownerId: string } {
    const ownerId = accessAccount(subject);
    const created = createCompany(db, {
      name: `Operator Co ${subject}`,
      ownerAccountId: ownerId,
      now: 1_000,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    const customer = options.customer === undefined ? 'cus_operator' : options.customer;
    if (customer !== null) {
      db.prepare(
        `UPDATE companies SET processor_customer_id = ? WHERE company_id = ?`,
      ).run(customer, created.company.companyId);
    }
    return { companyId: created.company.companyId, ownerId };
  }

  function approveInput(
    companyId: string,
    overrides: Partial<Parameters<typeof approveCompanyInvoice>[1]> = {},
  ): Parameters<typeof approveCompanyInvoice>[1] {
    return {
      companyId,
      quantity: 12,
      operationId: 'op_approve_1',
      operatorEmail: 'ops@example.test',
      requestHash: 'hash-approve-1',
      now: 5_000,
      ...overrides,
    };
  }

  function auditRows(): Array<Record<string, unknown>> {
    return db
      .prepare(
        `SELECT subject_kind AS subjectKind, subject_id AS subjectId, action,
                cause_kind AS causeKind, cause_id AS causeId, actor, reason
         FROM entitlement_audit ORDER BY created_at, audit_id`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  it('approves a ten-plus seat company, records the operation, and audits the operator', () => {
    const { companyId } = operatorCompany('approve-owner');
    const result = approveCompanyInvoice(db, approveInput(companyId));

    expect(result).toEqual({
      outcome: 'approved',
      replay: false,
      companyId,
      operationId: 'op_approve_1',
      quantity: 12,
      processorCustomerId: 'cus_operator',
      operationStatus: 'pending',
    });
    expect(
      db
        .prepare(
          `SELECT invoice_approved AS invoiceApproved FROM companies
           WHERE company_id = ?`,
        )
        .get(companyId),
    ).toEqual({ invoiceApproved: 1 });
    expect(
      db
        .prepare(
          `SELECT kind, status FROM billing_operations
           WHERE subject_kind = 'company' AND subject_id = ?`,
        )
        .get(companyId),
    ).toEqual({ kind: 'invoice-approve', status: 'pending' });
    expect(auditRows()).toEqual([
      {
        subjectKind: 'company',
        subjectId: companyId,
        action: 'operator_action',
        causeKind: 'operator',
        causeId: 'op_approve_1',
        actor: 'operator:ops@example.test',
        reason: 'invoice approval',
      },
    ]);
    expect(readCompanySubscription(db, companyId)).toBeNull();
    expect(seatCapacity(db, companyId)).toBe(1);
    expect(readEntitlementsForAccount(db, accessAccount('approve-owner'))).toEqual([]);
  });

  it('refuses fewer than ten seats and writes nothing', () => {
    const { companyId } = operatorCompany('approve-below-owner');
    const result = approveCompanyInvoice(db, approveInput(companyId, { quantity: 9 }));

    expect(result).toEqual({ outcome: 'below_minimum' });
    expect(
      db
        .prepare(`SELECT invoice_approved AS invoiceApproved FROM companies WHERE company_id = ?`)
        .get(companyId),
    ).toEqual({ invoiceApproved: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM billing_operations`).get()).toEqual({
      count: 0,
    });
    expect(auditRows()).toEqual([]);
  });

  it('refuses a company that already has a subscription', () => {
    const { companyId } = operatorCompany('approve-subscribed-owner');
    db.prepare(
      `INSERT INTO company_subscriptions (
         company_id, processor_subscription_id, quantity, status, collection_method, updated_at
       ) VALUES (?, ?, 3, 'active', 'charge_automatically', 2_000)`,
    ).run(companyId, `sub_${companyId}`);

    expect(approveCompanyInvoice(db, approveInput(companyId))).toEqual({
      outcome: 'already_subscribed',
    });
    expect(
      db
        .prepare(`SELECT invoice_approved AS invoiceApproved FROM companies WHERE company_id = ?`)
        .get(companyId),
    ).toEqual({ invoiceApproved: 0 });
  });

  it('refuses a company without a Stripe customer', () => {
    const { companyId } = operatorCompany('approve-no-customer', { customer: null });

    expect(approveCompanyInvoice(db, approveInput(companyId))).toEqual({
      outcome: 'customer_missing',
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM billing_operations`).get()).toEqual({
      count: 0,
    });
  });

  it('replays the same operation id and conflicts on a changed quantity', () => {
    const { companyId } = operatorCompany('approve-replay-owner');
    expect(approveCompanyInvoice(db, approveInput(companyId))).toMatchObject({
      outcome: 'approved',
      replay: false,
    });

    const replay = approveCompanyInvoice(db, approveInput(companyId));
    expect(replay).toMatchObject({ outcome: 'approved', replay: true });
    expect(auditRows()).toHaveLength(1);

    const conflict = approveCompanyInvoice(
      db,
      approveInput(companyId, { quantity: 15, requestHash: 'hash-approve-2' }),
    );
    expect(conflict).toEqual({ outcome: 'operation_conflict' });
  });

  function settleInput(
    companyId: string,
    overrides: Partial<Parameters<typeof settleCompanyInvoice>[1]> = {},
  ): Parameters<typeof settleCompanyInvoice>[1] {
    return {
      companyId,
      operationId: 'op_approve_1',
      quantity: 12,
      outcome: 'success',
      processorSubscriptionId: 'sub_invoice_1',
      status: 'active',
      currentPeriodEnd: 9_000,
      hostedInvoiceUrl: 'https://invoice.stripe.test/in_1',
      now: 6_000,
      ...overrides,
    };
  }

  it('settles a successful creation into a send_invoice subscription awaiting payment', () => {
    const { companyId } = operatorCompany('approve-settle-owner');
    approveCompanyInvoice(db, approveInput(companyId));

    expect(settleCompanyInvoice(db, settleInput(companyId))).toEqual({
      outcome: 'settled',
      replay: false,
    });

    expect(readCompanySubscription(db, companyId)).toMatchObject({
      processorSubscriptionId: 'sub_invoice_1',
      quantity: 12,
      status: 'active',
      collectionMethod: 'send_invoice',
      currentPeriodEnd: 9_000,
      firstPaidAt: null,
    });
    const row = db
      .prepare(
        `SELECT hosted_invoice_url AS hostedInvoiceUrl FROM company_subscriptions
         WHERE company_id = ?`,
      )
      .get(companyId);
    expect(row).toEqual({ hostedInvoiceUrl: 'https://invoice.stripe.test/in_1' });
    expect(
      db
        .prepare(
          `SELECT status, stripe_object_id AS stripeObjectId FROM billing_operations
           WHERE subject_kind = 'company' AND subject_id = ?`,
        )
        .get(companyId),
    ).toEqual({ status: 'succeeded', stripeObjectId: 'sub_invoice_1' });
    expect(
      db
        .prepare(
          `SELECT subject_kind AS subjectKind, subject_id AS subjectId
           FROM billing_subscriptions WHERE processor_subscription_id = 'sub_invoice_1'`,
        )
        .get(),
    ).toEqual({ subjectKind: 'company', subjectId: companyId });

    expect(settleCompanyInvoice(db, settleInput(companyId))).toEqual({
      outcome: 'settled',
      replay: true,
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM company_subscriptions WHERE company_id = ?`).get(companyId),
    ).toEqual({ count: 1 });
  });

  it('keeps the operation pending on an unknown outcome and fails it on a definitive failure', () => {
    const { companyId } = operatorCompany('approve-failure-owner');
    approveCompanyInvoice(db, approveInput(companyId));

    expect(
      settleCompanyInvoice(db, settleInput(companyId, { outcome: 'unknown' })),
    ).toEqual({ outcome: 'pending' });
    expect(readCompanySubscription(db, companyId)).toBeNull();
    expect(
      db
        .prepare(`SELECT status FROM billing_operations WHERE subject_id = ?`)
        .get(companyId),
    ).toEqual({ status: 'pending' });

    expect(
      settleCompanyInvoice(db, settleInput(companyId, { outcome: 'failure' })),
    ).toEqual({ outcome: 'failed' });
    expect(readCompanySubscription(db, companyId)).toBeNull();
    expect(
      db
        .prepare(`SELECT status FROM billing_operations WHERE subject_id = ?`)
        .get(companyId),
    ).toEqual({ status: 'failed' });
  });

  it('never settles an approval that was never reserved', () => {
    const { companyId } = operatorCompany('approve-unreserved-owner');
    expect(settleCompanyInvoice(db, settleInput(companyId))).toEqual({
      outcome: 'not_found',
    });
    expect(readCompanySubscription(db, companyId)).toBeNull();
  });

  it('never attaches an invoice subscription below the invoice minimum', () => {
    const { companyId } = operatorCompany('approve-settle-small-owner');
    approveCompanyInvoice(db, approveInput(companyId));

    expect(
      settleCompanyInvoice(db, settleInput(companyId, { quantity: 3 })),
    ).toEqual({ outcome: 'not_found' });
    expect(readCompanySubscription(db, companyId)).toBeNull();
    expect(
      db
        .prepare(`SELECT status FROM billing_operations WHERE subject_id = ?`)
        .get(companyId),
    ).toEqual({ status: 'pending' });
  });
});

describe('company operator dispute review (O-2)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  function accessAccount(subject: string): string {
    const outcome = resolveAccountForSubject(db, {
      issuer: 'https://issuer',
      subject,
    });
    if ('tutorCapReached' in outcome) throw new Error('unexpected tutor cap');
    return outcome.account.accountId;
  }

  function companySubscription(companyId: string, subscriptionId: string): void {
    db.prepare(
      `INSERT INTO company_subscriptions (
         company_id, processor_subscription_id, quantity, status, collection_method, updated_at
       ) VALUES (?, ?, 3, 'active', 'charge_automatically', 1_000)`,
    ).run(companyId, subscriptionId);
    ensureBillingSubscription(db, {
      processorSubscriptionId: subscriptionId,
      subjectKind: 'company',
      subjectId: companyId,
      now: 1_000,
    });
  }

  function companyWithOwner(subject: string): string {
    const ownerId = accessAccount(subject);
    const created = createCompany(db, {
      name: `Dispute Co ${subject}`,
      ownerAccountId: ownerId,
      now: 1_000,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    return created.company.companyId;
  }

  function operatorAuditRows(): Array<Record<string, unknown>> {
    return db
      .prepare(
        `SELECT subject_kind AS subjectKind, subject_id AS subjectId, cause_kind AS causeKind,
                cause_id AS causeId, actor, reason
         FROM entitlement_audit WHERE cause_kind = 'operator'
         ORDER BY created_at, audit_id`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  it('resolves a review hold to won, audits the operator, and grants nothing', () => {
    const companyId = companyWithOwner('dispute-review-owner');
    companySubscription(companyId, 'sub_dispute_review');
    upsertDisputeHold(db, {
      disputeId: 'dp_review_won',
      processorSubscriptionId: 'sub_dispute_review',
      state: 'review',
      now: 2_000,
    });
    recomputeDesiredCollection(db, {
      processorSubscriptionId: 'sub_dispute_review',
      cause: { kind: 'processor_event', id: 'evt_seed', actor: 'stripe', reason: 'seed' },
      now: 2_000,
    });

    const result = reviewDisputeHold(db, {
      disputeId: 'dp_review_won',
      state: 'won',
      operationId: 'op_review_1',
      operatorEmail: 'ops@example.test',
      now: 3_000,
    });

    expect(result).toEqual({
      outcome: 'resolved',
      disputeId: 'dp_review_won',
      state: 'won',
      desiredCollection: 'active',
    });
    expect(
      db
        .prepare(`SELECT state FROM billing_dispute_holds WHERE dispute_id = 'dp_review_won'`)
        .get(),
    ).toEqual({ state: 'won' });
    expect(
      db
        .prepare(
          `SELECT desired_collection AS desiredCollection FROM billing_subscriptions
           WHERE processor_subscription_id = 'sub_dispute_review'`,
        )
        .get(),
    ).toEqual({ desiredCollection: 'active' });
    expect(operatorAuditRows()).toEqual([
      {
        subjectKind: 'company',
        subjectId: companyId,
        causeKind: 'operator',
        causeId: 'op_review_1',
        actor: 'operator:ops@example.test',
        reason: 'dispute review won',
      },
    ]);
    expect(readEntitlementsForAccount(db, accessAccount('dispute-review-owner'))).toEqual([]);
  });

  it('never releases collection while another dispute still holds', () => {
    const ownerId = accessAccount('dispute-holds-owner');
    const subscriptionId = 'sub_dispute_holds';
    writeEntitlement(
      db,
      {
        accountId: ownerId,
        source: 'personal',
        state: {
          planId: 'tutor_pro_monthly',
          status: 'active',
          graceUntil: null,
          collectionPaused: false,
          companyId: null,
          currentPeriodEnd: null,
          processorCustomerId: 'cus_dispute_holds',
          processorSubscriptionId: subscriptionId,
        },
        now: 1_000,
      },
      { kind: 'processor_event', id: 'evt_holds_initial', actor: 'stripe', reason: 'seed' },
    );
    ensureBillingSubscription(db, {
      processorSubscriptionId: subscriptionId,
      subjectKind: 'account',
      subjectId: ownerId,
      now: 1_000,
    });
    upsertDisputeHold(db, {
      disputeId: 'dp_holds_review',
      processorSubscriptionId: subscriptionId,
      state: 'review',
      now: 2_000,
    });
    upsertDisputeHold(db, {
      disputeId: 'dp_holds_open',
      processorSubscriptionId: subscriptionId,
      state: 'open',
      now: 2_000,
    });
    recomputeDesiredCollection(db, {
      processorSubscriptionId: subscriptionId,
      cause: { kind: 'processor_event', id: 'evt_holds_pause', actor: 'stripe', reason: 'seed' },
      now: 2_000,
    });
    expect(readEntitlementsForAccount(db, ownerId)[0]).toMatchObject({
      collectionPaused: true,
    });

    const result = reviewDisputeHold(db, {
      disputeId: 'dp_holds_review',
      state: 'won',
      operationId: 'op_review_holds',
      operatorEmail: 'ops@example.test',
      now: 3_000,
    });

    expect(result).toEqual({
      outcome: 'resolved',
      disputeId: 'dp_holds_review',
      state: 'won',
      desiredCollection: 'paused',
    });
    expect(
      db
        .prepare(
          `SELECT desired_collection AS desiredCollection FROM billing_subscriptions
           WHERE processor_subscription_id = ?`,
        )
        .get(subscriptionId),
    ).toEqual({ desiredCollection: 'paused' });
    expect(readEntitlementsForAccount(db, ownerId)[0]).toMatchObject({
      collectionPaused: true,
    });
    expect(
      db
        .prepare(`SELECT COUNT(*) AS count FROM billing_dispute_holds
                  WHERE processor_subscription_id = ? AND state IN ('open','review')`)
        .get(subscriptionId),
    ).toEqual({ count: 1 });
    expect(operatorAuditRows()).toEqual([
      {
        subjectKind: 'account',
        subjectId: ownerId,
        causeKind: 'operator',
        causeId: 'op_review_holds',
        actor: 'operator:ops@example.test',
        reason: 'dispute review won',
      },
    ]);
  });

  it('resolves a review hold to lost, canceling collection', () => {
    const companyId = companyWithOwner('dispute-lost-owner');
    companySubscription(companyId, 'sub_dispute_lost');
    upsertDisputeHold(db, {
      disputeId: 'dp_review_lost',
      processorSubscriptionId: 'sub_dispute_lost',
      state: 'review',
      now: 2_000,
    });

    expect(
      reviewDisputeHold(db, {
        disputeId: 'dp_review_lost',
        state: 'lost',
        operationId: 'op_review_lost',
        operatorEmail: 'ops@example.test',
        now: 3_000,
      }),
    ).toEqual({
      outcome: 'resolved',
      disputeId: 'dp_review_lost',
      state: 'lost',
      desiredCollection: 'canceled',
    });
    expect(
      db
        .prepare(
          `SELECT desired_collection AS desiredCollection, desired_version AS desiredVersion
           FROM billing_subscriptions WHERE processor_subscription_id = 'sub_dispute_lost'`,
        )
        .get(),
    ).toEqual({ desiredCollection: 'canceled', desiredVersion: 1 });
  });

  it('refuses a hold that is not under review and writes nothing', () => {
    const companyId = companyWithOwner('dispute-open-owner');
    companySubscription(companyId, 'sub_dispute_open');
    upsertDisputeHold(db, {
      disputeId: 'dp_open_only',
      processorSubscriptionId: 'sub_dispute_open',
      state: 'open',
      now: 2_000,
    });

    expect(
      reviewDisputeHold(db, {
        disputeId: 'dp_open_only',
        state: 'won',
        operationId: 'op_review_open',
        operatorEmail: 'ops@example.test',
        now: 3_000,
      }),
    ).toEqual({ outcome: 'not_review' });
    expect(
      db
        .prepare(`SELECT state FROM billing_dispute_holds WHERE dispute_id = 'dp_open_only'`)
        .get(),
    ).toEqual({ state: 'open' });
    expect(operatorAuditRows()).toEqual([]);

    expect(
      reviewDisputeHold(db, {
        disputeId: 'dp_unknown',
        state: 'won',
        operationId: 'op_review_unknown',
        operatorEmail: 'ops@example.test',
        now: 3_000,
      }),
    ).toEqual({ outcome: 'not_found' });
  });
});
