import type { RoomDatabase } from '../whiteboard/db';
import {
  attachCompanySubscription,
  ensureBillingSubscription,
  recordOperatorAction,
  recomputeDesiredCollection,
  upsertDisputeHold,
  type DesiredCollection,
} from '../identity/entitlementWriter';
import { recordUserOperation } from '../billing/operations';
import { readCompany } from './membership';
import {
  readCompanySubscription,
  type CollectionMethod,
} from './seats';

const MAX_OPERATOR_EMAIL_LENGTH = 254;

export const MIN_INVOICE_SEATS = 10;
export const MAX_INVOICE_SEATS = 10_000;

export type AttachableSubscriptionStatus = 'trialing' | 'active' | 'incomplete';

const ATTACHABLE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'trialing',
  'active',
  'incomplete',
]);

export function isAttachableSubscriptionStatus(
  value: unknown,
): value is AttachableSubscriptionStatus {
  return typeof value === 'string' && ATTACHABLE_SUBSCRIPTION_STATUSES.has(value);
}

export function normalizeOperatorEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > MAX_OPERATOR_EMAIL_LENGTH) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  if (email.includes('@', at + 1)) return null;
  if (/\s/.test(email) || email.includes(',')) return null;
  return email;
}

export function parseOperatorEmails(raw: string | null | undefined): Set<string> {
  const emails = new Set<string>();
  if (typeof raw !== 'string') return emails;
  for (const entry of raw.split(',')) {
    const email = normalizeOperatorEmail(entry);
    if (email !== null) emails.add(email);
  }
  return emails;
}

export function operatorEmailFor(
  raw: string | null | undefined,
  candidate: string | null | undefined,
): string | null {
  const operators = parseOperatorEmails(raw);
  if (operators.size === 0) return null;
  const email = normalizeOperatorEmail(candidate);
  return email !== null && operators.has(email) ? email : null;
}

export type ApproveInvoiceOutcome =
  | {
      outcome: 'approved';
      replay: boolean;
      companyId: string;
      operationId: string;
      quantity: number;
      processorCustomerId: string;
      operationStatus: 'pending' | 'failed' | 'succeeded';
    }
  | { outcome: 'not_found' }
  | { outcome: 'below_minimum' }
  | { outcome: 'customer_missing' }
  | { outcome: 'already_subscribed' }
  | { outcome: 'operation_conflict' };

export function approveCompanyInvoice(
  db: RoomDatabase,
  input: {
    companyId: string;
    quantity: number;
    operationId: string;
    operatorEmail: string;
    requestHash: string;
    now: number;
  },
): ApproveInvoiceOutcome {
  return db.transaction((): ApproveInvoiceOutcome => {
    const company = readCompany(db, input.companyId);
    if (!company || company.state !== 'active') return { outcome: 'not_found' };
    if (readCompanySubscription(db, input.companyId)) {
      return { outcome: 'already_subscribed' };
    }
    if (
      !Number.isInteger(input.quantity) ||
      input.quantity < MIN_INVOICE_SEATS ||
      input.quantity > MAX_INVOICE_SEATS
    ) {
      return { outcome: 'below_minimum' };
    }
    if (company.processorCustomerId === null) {
      return { outcome: 'customer_missing' };
    }

    const recorded = recordUserOperation(
      db,
      {
        subjectKind: 'company',
        subjectId: input.companyId,
        operationId: input.operationId,
        kind: 'invoice-approve',
      },
      { requestHash: input.requestHash, now: input.now },
    );
    if (recorded.status === 'conflict') return { outcome: 'operation_conflict' };

    if (recorded.status === 'created') {
      db.prepare(
        `UPDATE companies SET invoice_approved = 1, updated_at = ?
         WHERE company_id = ?`,
      ).run(input.now, input.companyId);
      recordOperatorAction(db, {
        subjectKind: 'company',
        subjectId: input.companyId,
        cause: {
          kind: 'operator',
          id: input.operationId,
          actor: `operator:${input.operatorEmail}`,
          reason: 'invoice approval',
        },
        now: input.now,
      });
    }

    return {
      outcome: 'approved',
      replay: recorded.status === 'replay',
      companyId: input.companyId,
      operationId: input.operationId,
      quantity: input.quantity,
      processorCustomerId: company.processorCustomerId,
      operationStatus:
        recorded.record?.status === 'succeeded' || recorded.record?.status === 'failed'
          ? recorded.record.status
          : 'pending',
    };
  })();
}

export type SettleInvoiceOutcome =
  | { outcome: 'settled'; replay: boolean }
  | { outcome: 'failed' }
  | { outcome: 'pending' }
  | { outcome: 'not_found' }
  | { outcome: 'operation_conflict' };

export function settleCompanyInvoice(
  db: RoomDatabase,
  input: {
    companyId: string;
    operationId: string;
    quantity: number;
    outcome: 'success' | 'failure' | 'unknown';
    processorSubscriptionId?: string;
    status?: AttachableSubscriptionStatus;
    currentPeriodEnd?: number | null;
    hostedInvoiceUrl?: string | null;
    now: number;
  },
): SettleInvoiceOutcome {
  return db.transaction((): SettleInvoiceOutcome => {
    const operation = db
      .prepare(
        `SELECT status FROM billing_operations
         WHERE subject_kind = 'company' AND subject_id = ?
           AND operation_id = ? AND kind = 'invoice-approve'`,
      )
      .get(input.companyId, input.operationId) as { status: string } | undefined;
    if (!operation) return { outcome: 'not_found' };

    if (input.outcome === 'unknown') return { outcome: 'pending' };

    if (
      !Number.isInteger(input.quantity) ||
      input.quantity < MIN_INVOICE_SEATS ||
      input.quantity > MAX_INVOICE_SEATS
    ) {
      return { outcome: 'not_found' };
    }

    if (input.outcome === 'failure') {
      if (operation.status === 'succeeded') return { outcome: 'operation_conflict' };
      db.prepare(
        `UPDATE billing_operations SET status = 'failed', updated_at = ?
         WHERE subject_kind = 'company' AND subject_id = ?
           AND operation_id = ? AND kind = 'invoice-approve' AND status = 'pending'`,
      ).run(input.now, input.companyId, input.operationId);
      return { outcome: 'failed' };
    }

    const subscriptionId = input.processorSubscriptionId;
    const status = input.status;
    if (
      subscriptionId === undefined ||
      subscriptionId.length === 0 ||
      status === undefined ||
      !isAttachableSubscriptionStatus(status)
    ) {
      return { outcome: 'not_found' };
    }

    if (operation.status === 'succeeded') {
      const existing = readCompanySubscription(db, input.companyId);
      return existing !== null && existing.processorSubscriptionId === subscriptionId
        ? { outcome: 'settled', replay: true }
        : { outcome: 'operation_conflict' };
    }

    ensureBillingSubscription(db, {
      processorSubscriptionId: subscriptionId,
      subjectKind: 'company',
      subjectId: input.companyId,
      now: input.now,
    });
    const attached = attachCompanySubscription(db, {
      companyId: input.companyId,
      processorSubscriptionId: subscriptionId,
      quantity: input.quantity,
      status,
      collectionMethod: 'send_invoice' satisfies CollectionMethod,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      hostedInvoiceUrl: input.hostedInvoiceUrl ?? null,
      now: input.now,
    });
    if (!attached.created) return { outcome: 'operation_conflict' };

    db.prepare(
      `UPDATE billing_operations
       SET status = 'succeeded', stripe_object_id = ?, updated_at = ?
       WHERE subject_kind = 'company' AND subject_id = ?
         AND operation_id = ? AND kind = 'invoice-approve'`,
    ).run(subscriptionId, input.now, input.companyId, input.operationId);
    return { outcome: 'settled', replay: false };
  })();
}

export type ReviewDisputeOutcome =
  | {
      outcome: 'resolved';
      disputeId: string;
      state: 'won' | 'lost';
      desiredCollection: DesiredCollection;
    }
  | { outcome: 'not_found' }
  | { outcome: 'not_review' };

export function reviewDisputeHold(
  db: RoomDatabase,
  input: {
    disputeId: string;
    state: 'won' | 'lost';
    operationId: string;
    operatorEmail: string;
    now: number;
  },
): ReviewDisputeOutcome {
  return db.transaction((): ReviewDisputeOutcome => {
    const hold = db
      .prepare(
        `SELECT state, processor_subscription_id AS processorSubscriptionId
         FROM billing_dispute_holds WHERE dispute_id = ?`,
      )
      .get(input.disputeId) as
      | { state: string; processorSubscriptionId: string }
      | undefined;
    if (!hold) return { outcome: 'not_found' };
    if (hold.state !== 'review') return { outcome: 'not_review' };

    const ordering = db
      .prepare(
        `SELECT subject_kind AS subjectKind, subject_id AS subjectId
         FROM billing_subscriptions WHERE processor_subscription_id = ?`,
      )
      .get(hold.processorSubscriptionId) as
      | { subjectKind: 'account' | 'company'; subjectId: string }
      | undefined;
    if (!ordering) return { outcome: 'not_found' };

    upsertDisputeHold(db, {
      disputeId: input.disputeId,
      processorSubscriptionId: hold.processorSubscriptionId,
      state: input.state,
      now: input.now,
    });
    const cause = {
      kind: 'operator' as const,
      id: input.operationId,
      actor: `operator:${input.operatorEmail}`,
      reason: `dispute review ${input.state}`,
    };
    const recomputed = recomputeDesiredCollection(db, {
      processorSubscriptionId: hold.processorSubscriptionId,
      cause,
      now: input.now,
    });
    recordOperatorAction(db, {
      subjectKind: ordering.subjectKind,
      subjectId: ordering.subjectId,
      cause,
      now: input.now,
    });

    return {
      outcome: 'resolved',
      disputeId: input.disputeId,
      state: input.state,
      desiredCollection: recomputed.desired,
    };
  })();
}
