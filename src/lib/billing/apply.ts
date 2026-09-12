import type { RoomDatabase } from '../whiteboard/db';
import type { EntitlementStatus } from '../plan/effectivePlan';
import type { PlanId } from '../plan/catalog';
import {
  applyCompanySubscriptionState,
  applySubscriptionState,
  cancelCollection,
  ensureBillingSubscription,
  recomputeDesiredCollection,
  setCompanyFirstPaidAt,
  upsertDisputeHold,
  type BillingSubjectKind,
  type DisputeHoldState,
  type EntitlementCause,
} from '../identity/entitlementWriter';
import type { CompanySubscriptionStatus } from '../company/seats';
import {
  confirmReferralRedemption,
  recordReferralRedemption,
  recordReferralReversal,
} from '../referrals/ledger';
import { materializeCompanyMemberEntitlements } from '../company/companyEntitlements';

/**
 * Stripe webhook apply pipeline (spec §7). One event becomes a billing_events
 * row plus class-1 subscription state, class-2 effects, dispute holds, and
 * collection desires. The route runs the whole apply inside one transaction:
 * any throw rolls the billing_events row back so Stripe's retry stays
 * idempotent, and the writer-owned tables (billing_subscriptions,
 * billing_dispute_holds, company_subscriptions, entitlements) are only ever
 * mutated through entitlementWriter.
 */

export class UnrepresentableSubscriptionStatusError extends Error {
  constructor(readonly status: string) {
    super(`no entitlement mapping for subscription status '${status}'`);
  }
}

export interface BillingEventReceipt {
  id: string;
  type: string;
  livemode: boolean;
  created: number;
}

export interface BillingApplyInput {
  event: BillingEventReceipt;
  objects?: Record<string, unknown> | null;
  payloadHash: string;
  signatureVerified: true;
}

export type ApplyVerdict =
  | { outcome: 'applied'; outcomeDetail?: undefined; replayed?: boolean }
  | { outcome: 'ignored'; outcomeDetail: string; replayed?: boolean };

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Lowercase hex SHA-256, the payload fingerprint stored on every event row. */
export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

// Normalized fetched-object shapes (the webhook agent maps Stripe's JSON into
// these before posting; event.created and all timestamps are milliseconds).
export interface FetchedSubscription {
  id: string;
  customer: string | null;
  status: string;
  canceledAt: number | null;
  currentPeriodEnd: number | null;
  pauseCollection: { behavior?: string } | null;
}
export interface FetchedInvoice {
  id: string;
  customer: string | null;
  status?: string;
  amountPaid?: number;
  currency?: string;
  paymentIntent?: string | null;
  subscription?: string | null;
  payments?: Array<{ id: string; amount: number }>;
}
export interface FetchedDispute {
  id: string;
  status?: string;
  charge?: { id?: string; customer?: string | null };
}
export interface FetchedCharge {
  id: string | null;
  customer: string | null;
}
export interface FetchedCheckoutSession {
  id: string;
  clientReferenceId: string | null;
  customer: string | null;
  referrerCode: string | null;
}

const SUBSCRIPTION_STATUS_TO_ENTITLEMENT: Record<string, EntitlementStatus> = {
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
};

function mapSubscriptionStatus(status: string): EntitlementStatus {
  const mapped = SUBSCRIPTION_STATUS_TO_ENTITLEMENT[status];
  if (mapped === undefined) {
    throw new UnrepresentableSubscriptionStatusError(status);
  }
  return mapped;
}

/** Dispute states collapse to open/review/won/lost; anything else is review. */
function toHoldState(status: string): DisputeHoldState {
  if (status === 'needs_response' || status === 'warning_needs_response') return 'open';
  if (status === 'won') return 'won';
  if (status === 'lost') return 'lost';
  return 'review';
}

function asSubscription(value: unknown): FetchedSubscription | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) return null;
  return {
    id: record.id,
    customer: typeof record.customer === 'string' ? record.customer : null,
    status: typeof record.status === 'string' ? record.status : 'unknown',
    canceledAt:
      typeof record.canceledAt === 'number' ? record.canceledAt : null,
    currentPeriodEnd:
      typeof record.currentPeriodEnd === 'number' ? record.currentPeriodEnd : null,
    pauseCollection:
      typeof record.pauseCollection === 'object' &&
      record.pauseCollection !== null &&
      !Array.isArray(record.pauseCollection)
        ? { behavior: 'void' }
        : null,
  };
}

function asInvoice(value: unknown): FetchedInvoice | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) return null;
  return {
    id: record.id,
    customer: typeof record.customer === 'string' ? record.customer : null,
    status: typeof record.status === 'string' ? record.status : undefined,
    amountPaid: typeof record.amountPaid === 'number' ? record.amountPaid : 0,
    currency: typeof record.currency === 'string' ? record.currency : 'gbp',
    paymentIntent:
      typeof record.paymentIntent === 'string' ? record.paymentIntent : null,
    subscription:
      typeof record.subscription === 'string' ? record.subscription : null,
    payments: Array.isArray(record.payments) ? record.payments : [],
  };
}

function asCheckoutSession(value: unknown): FetchedCheckoutSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) return null;
  return {
    id: record.id,
    clientReferenceId:
      typeof record.clientReferenceId === 'string' ? record.clientReferenceId : null,
    customer: typeof record.customer === 'string' ? record.customer : null,
    referrerCode:
      typeof record.referrerCode === 'string' ? record.referrerCode : null,
  };
}

function asDispute(value: unknown): FetchedDispute | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) return null;
  const charge =
    typeof record.charge === 'object' && record.charge !== null
      ? (record.charge as Record<string, unknown>)
      : undefined;
  return {
    id: record.id,
    status: typeof record.status === 'string' ? record.status : undefined,
    charge: charge
      ? {
          id: typeof charge.id === 'string' ? charge.id : undefined,
          customer: typeof charge.customer === 'string' ? charge.customer : null,
        }
      : undefined,
  };
}

interface ResolvedSubject {
  subjectKind: BillingSubjectKind;
  subjectId: string;
  orderSubscriptionId: string | null;
}

/** Subscriptions attach to an account (entitlements) or a company seat row. */
function resolveSubject(
  db: RoomDatabase,
  refs: { subscriptionId?: string | null; customerId?: string | null },
): ResolvedSubject | null {
  if (refs.subscriptionId) {
    const ordering = db
      .prepare(
        `SELECT subject_kind, subject_id
         FROM billing_subscriptions WHERE processor_subscription_id = ?`,
      )
      .get(refs.subscriptionId) as { subject_kind: string; subject_id: string } | undefined;
    if (ordering) {
      return {
        subjectKind: ordering.subject_kind as BillingSubjectKind,
        subjectId: ordering.subject_id,
        orderSubscriptionId: refs.subscriptionId,
      };
    }
    const company = db
      .prepare(
        `SELECT company_id
         FROM company_subscriptions WHERE processor_subscription_id = ?`,
      )
      .get(refs.subscriptionId) as { company_id: string } | undefined;
    if (company) {
      return {
        subjectKind: 'company',
        subjectId: company.company_id,
        orderSubscriptionId: refs.subscriptionId,
      };
    }
    const entitlement = db
      .prepare(
        `SELECT account_id, processor_subscription_id
         FROM entitlements WHERE processor_subscription_id = ?`,
      )
      .get(refs.subscriptionId) as { account_id: string; processor_subscription_id: string } | undefined;
    if (entitlement) {
      return {
        subjectKind: 'account',
        subjectId: entitlement.account_id,
        orderSubscriptionId: entitlement.processor_subscription_id,
      };
    }
  }
  if (refs.customerId) {
    const entitlement = db
      .prepare(
        `SELECT account_id, processor_subscription_id
         FROM entitlements WHERE processor_customer_id = ?`,
      )
      .get(refs.customerId) as { account_id: string; processor_subscription_id: string | null } | undefined;
    if (entitlement) {
      return {
        subjectKind: 'account',
        subjectId: entitlement.account_id,
        orderSubscriptionId: entitlement.processor_subscription_id,
      };
    }
  }
  return null;
}

const CLASS_1_TYPES = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'checkout.session.completed',
]);

const PAID_EFFECT = 'invoice_paid';
const PAYMENT_FAILED_EFFECT = 'invoice_payment_failed';
const REFUND_EFFECT = 'refund';

function recordEffect(
  db: RoomDatabase,
  event: BillingEventReceipt,
  kind: 'checkout_completed' | 'invoice_paid' | 'invoice_payment_failed' | 'refund',
  objectId: string,
  now: number,
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO billing_effects (effect_kind, object_id, processor_event_id, applied_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(kind, objectId, event.id, now);
  return result.changes === 1;
}

interface NormalizedObjects {
  subscription: FetchedSubscription | null;
  invoice: FetchedInvoice | null;
  dispute: FetchedDispute | null;
  checkout: FetchedCheckoutSession | null;
  charge: FetchedCharge | null;
}

function normalizeObjects(objects: unknown): NormalizedObjects {
  if (typeof objects !== 'object' || objects === null) {
    return { subscription: null, invoice: null, dispute: null, checkout: null, charge: null };
  }
  const record = objects as Record<string, unknown>;
  const charge =
    typeof record.charge === 'object' && record.charge !== null
      ? (record.charge as Record<string, unknown>)
      : null;
  return {
    subscription: asSubscription(record.subscription),
    invoice: asInvoice(record.invoice),
    dispute: asDispute(record.dispute),
    checkout: asCheckoutSession(record.checkout),
    charge: charge
      ? {
          id: typeof charge.id === 'string' ? charge.id : null,
          customer: typeof charge.customer === 'string' ? charge.customer : null,
        }
      : null,
  };
}

const COMPANY_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
  'incomplete',
  'incomplete_expired',
]);

function mapCompanySubscriptionStatus(status: string): CompanySubscriptionStatus {
  if (!COMPANY_SUBSCRIPTION_STATUSES.has(status)) {
    throw new UnrepresentableSubscriptionStatusError(status);
  }
  return status as CompanySubscriptionStatus;
}

function applyClass1(
  db: RoomDatabase,
  event: BillingEventReceipt,
  sub: FetchedSubscription,
  now: number,
): { skipped: boolean } {
  const resolved = resolveSubject(db, { subscriptionId: sub.id, customerId: sub.customer });
  if (!resolved) {
    return { skipped: true };
  }
  const cause: EntitlementCause = {
    kind: 'processor_event',
    id: event.id,
    actor: 'stripe',
    reason: event.type,
  };
  if (resolved.subjectKind === 'company') {
    const result = applyCompanySubscriptionState(db, {
      processorSubscriptionId: sub.id,
      companyId: resolved.subjectId,
      eventCreated: event.created,
      now,
      fetched: {
        status: mapCompanySubscriptionStatus(sub.status),
        currentPeriodEnd: sub.currentPeriodEnd,
        canceledAt: sub.canceledAt,
        pauseCollection: sub.pauseCollection !== null || sub.status === 'canceled',
      },
    });
    if (result.canceledNow) {
      cancelCollection(db, { processorSubscriptionId: sub.id, now });
    }
    if (!result.applied) {
      return { skipped: true };
    }
    materializeCompanyMemberEntitlements(db, {
      companyId: resolved.subjectId,
      cause,
      now,
    });
    return { skipped: false };
  }
  const status = mapSubscriptionStatus(sub.status);
  const entitlement = db
    .prepare(`SELECT plan_id FROM entitlements WHERE account_id = ? AND source = 'personal'`)
    .get(resolved.subjectId) as { plan_id: string } | undefined;
  if (!entitlement) {
    return { skipped: true };
  }
  const result = applySubscriptionState(
    db,
    {
      processorSubscriptionId: sub.id,
      accountId: resolved.subjectId,
      planId: entitlement.plan_id as PlanId,
      processorCustomerId: sub.customer,
      eventCreated: event.created,
      now,
      fetched: {
        status,
        currentPeriodEnd: sub.currentPeriodEnd,
        canceledAt: sub.canceledAt,
        pauseCollection: sub.pauseCollection !== null || status === 'canceled',
      },
    },
    cause,
  );
  if (result.canceledNow) {
    cancelCollection(db, { processorSubscriptionId: sub.id, now });
  }
  return { skipped: !result.applied };
}

function applyPaidEffects(
  db: RoomDatabase,
  event: BillingEventReceipt,
  objects: NormalizedObjects,
  now: number,
): ApplyVerdict {
  const invoice = objects.invoice;
  if (!invoice) return { outcome: 'applied' };
  const inserted = recordEffect(db, event, PAID_EFFECT, invoice.id, now);
  if (!inserted) return { outcome: 'applied' };

  const amountPaid = invoice.amountPaid ?? 0;
  if (amountPaid > 0) {
    const resolved = resolveSubject(db, {
      subscriptionId: objects.subscription?.id ?? invoice.subscription,
      customerId: invoice.customer,
    });
    if (resolved) {
      db.prepare(
        `INSERT OR IGNORE INTO billing_payments (
           payment_intent_id, charge_id, invoice_id, subject_kind, subject_id,
           amount_cents, currency, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        invoice.paymentIntent ?? null,
        invoice.payments?.[0]?.id ?? null,
        invoice.id,
        resolved.subjectKind,
        resolved.subjectId,
        amountPaid,
        invoice.currency ?? 'gbp',
        event.created,
      );
    }
    const companySubId = objects.subscription?.id ?? invoice.subscription;
    if (companySubId) {
      const firstPaid = setCompanyFirstPaidAt(db, {
        processorSubscriptionId: companySubId,
        occurredAt: event.created,
      });
      if (firstPaid.updated && resolved?.subjectKind === 'company') {
        materializeCompanyMemberEntitlements(db, {
          companyId: resolved.subjectId,
          cause: {
            kind: 'processor_event',
            id: event.id,
            actor: 'stripe',
            reason: event.type,
          },
          now,
        });
      }
    }
  }
  if (invoice.customer) {
    confirmReferralRedemption(db, {
      referredCustomerId: invoice.customer,
      amountPaidCents: amountPaid,
      occurredAt: event.created,
    });
  }
  return { outcome: 'applied' };
}

function applyCheckoutEffect(
  db: RoomDatabase,
  event: BillingEventReceipt,
  checkout: FetchedCheckoutSession | null,
  now: number,
): void {
  if (!checkout) return;
  const inserted = recordEffect(db, event, 'checkout_completed', checkout.id, now);
  if (!inserted) return;
  if (checkout.clientReferenceId && checkout.referrerCode) {
    recordReferralRedemption(db, {
      code: checkout.referrerCode,
      referredAccountId: checkout.clientReferenceId,
      referredCustomerId: checkout.customer,
      objectId: checkout.id,
      occurredAt: event.created,
      recordedAt: now,
      processorEventId: event.id,
    });
  }
}

function applyDispute(
  db: RoomDatabase,
  event: BillingEventReceipt,
  dispute: FetchedDispute,
  now: number,
): ApplyVerdict {
  const customer = dispute.charge?.customer ?? null;
  if (!customer) return { outcome: 'ignored', outcomeDetail: 'unmapped_dispute' };

  const resolved = resolveSubject(db, { customerId: customer });
  if (!resolved || !resolved.orderSubscriptionId) {
    console.error(
      '[billing]',
      JSON.stringify({
        alert: 'unmapped_dispute',
        eventId: event.id,
        disputeId: dispute.id,
        customer,
      }),
    );
    return { outcome: 'ignored', outcomeDetail: 'unmapped_dispute' };
  }

  const state = toHoldState(dispute.status ?? 'unknown');
  ensureBillingSubscription(db, {
    processorSubscriptionId: resolved.orderSubscriptionId,
    subjectKind: resolved.subjectKind,
    subjectId: resolved.subjectId,
    now,
  });
  const { stateChanged } = upsertDisputeHold(db, {
    disputeId: dispute.id,
    processorSubscriptionId: resolved.orderSubscriptionId,
    state,
    now,
  });
  if (stateChanged) {
    recomputeDesiredCollection(db, {
      processorSubscriptionId: resolved.orderSubscriptionId,
      cause: { kind: 'processor_event', id: event.id, actor: 'stripe', reason: event.type },
      now,
    });
  }
  return { outcome: 'applied' };
}

function processEvent(db: RoomDatabase, input: BillingApplyInput, now: number): ApplyVerdict {
  const { event } = input;
  const objects = normalizeObjects(input.objects);

  if (event.type === 'invoice.paid') {
    if (objects.subscription) applyClass1(db, event, objects.subscription, now);
    return applyPaidEffects(db, event, objects, now);
  }
  if (event.type === 'invoice.payment_failed') {
    if (objects.subscription) applyClass1(db, event, objects.subscription, now);
    if (objects.invoice) {
      recordEffect(db, event, PAYMENT_FAILED_EFFECT, objects.invoice.id, now);
    }
    return { outcome: 'applied' };
  }
  if (CLASS_1_TYPES.has(event.type)) {
    if (objects.subscription) applyClass1(db, event, objects.subscription, now);
    if (event.type === 'checkout.session.completed') {
      applyCheckoutEffect(db, event, objects.checkout, now);
    }
    return { outcome: 'applied' };
  }
  if (event.type === 'charge.refunded') {
    const charge = objects.charge;
    if (charge?.id) {
      const inserted = recordEffect(db, event, REFUND_EFFECT, charge.id, now);
      if (inserted && charge.customer) {
        recordReferralReversal(db, {
          objectId: charge.id,
          referredCustomerId: charge.customer,
          occurredAt: event.created,
          recordedAt: now,
          processorEventId: event.id,
        });
      }
    }
    return { outcome: 'applied' };
  }
  if (event.type.startsWith('charge.dispute.')) {
    return objects.dispute
      ? applyDispute(db, event, objects.dispute, now)
      : { outcome: 'ignored', outcomeDetail: 'unmapped_dispute' };
  }
  return { outcome: 'ignored', outcomeDetail: 'unknown_type' };
}

/**
 * Applies one webhook event. MUST run inside the caller's transaction so the
 * billing_events row and every side effect commit or roll back together. A
 * repeated event id short-circuits to the stored outcome.
 */
export function applyEvent(db: RoomDatabase, input: BillingApplyInput): ApplyVerdict {
  const now = Date.now();
  const prior = db
    .prepare(`SELECT outcome, outcome_detail FROM billing_events WHERE event_id = ?`)
    .get(input.event.id) as { outcome: string; outcome_detail: string | null } | undefined;

  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO billing_events (
         event_id, type, livemode, event_created, payload_hash,
         outcome, outcome_detail, applied_at
       ) VALUES (?, ?, ?, ?, ?, 'applied', NULL, ?)`,
    )
    .run(
      input.event.id,
      input.event.type,
      input.event.livemode ? 1 : 0,
      input.event.created,
      input.payloadHash,
      now,
    ).changes;

  if (inserted === 0 && prior) {
    return prior.outcome === 'ignored'
      ? { outcome: 'ignored', outcomeDetail: prior.outcome_detail ?? 'ignored', replayed: true }
      : { outcome: 'applied', replayed: true };
  }

  const verdict: ApplyVerdict = input.event.livemode
    ? processEvent(db, input, now)
    : { outcome: 'ignored', outcomeDetail: 'livemode_mismatch' };

  if (verdict.outcome === 'ignored') {
    db.prepare(
      `UPDATE billing_events SET outcome = 'ignored', outcome_detail = ? WHERE event_id = ?`,
    ).run(verdict.outcomeDetail, input.event.id);
  }
  return verdict;
}