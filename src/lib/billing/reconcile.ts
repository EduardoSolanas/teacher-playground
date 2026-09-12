/**
 * R-1 daily reconcile core (spec §3.7 R-1, §7.5). The IdentityDO runs this in
 * one transaction: it never calls the network, so every state transition below
 * is provable locally. The Worker fetches what the daily sweep cannot (Stripe
 * subscription reads, disputes, seat retries) and hands the authoritative
 * collection reads back as observations.
 */
import type { RoomDatabase } from '../whiteboard/db';
import {
  applyCompanySubscriptionState,
  applySubscriptionState,
  cancelCollection,
  claimCollection,
  readBillingSweep,
  recordBillingSweep,
  recordGraceExpiryAudit,
  repairCollectionVersion,
  settleCollectionFailure,
  settleCollectionSuccess,
  type BillingSubjectKind,
  type DesiredCollection,
  type EntitlementCause,
} from '../identity/entitlementWriter';
import { applyEvent } from './apply';
import type { EntitlementStatus } from '../plan/effectivePlan';
import type { PlanId } from '../plan/catalog';
import type { CompanySubscriptionStatus } from '../company/seats';
import { materializeCompanyMemberEntitlements } from '../company/companyEntitlements';

export const RECONCILE_IN_FLIGHT_TIMEOUT_MS = 15 * 60 * 1_000;

export const RECONCILE_RUN_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

export interface FetchedReconcileSubscription {
  status: string;
  customer: string | null;
  currentPeriodEnd: number | null;
  canceledAt: number | null;
  pauseCollection: boolean;
}

export interface CollectionObservation {
  processorSubscriptionId: string;
  actualCollection: DesiredCollection;
  subscription?: FetchedReconcileSubscription;
}

export interface ReconcileDispute {
  id: string;
  status: string;
  created: number;
  customer: string | null;
}

export interface ReconcileCollection {
  subjectKind: BillingSubjectKind;
  subjectId: string;
  processorSubscriptionId: string;
  version: number;
  state: DesiredCollection;
}

export interface ReconcileResult {
  failedMarkers: number;
  repaired: number;
  claimed: number;
  graceAudits: number;
  appliedSubscriptions: number;
  disputesApplied: number;
  disputesSweptAt: number;
  subscriptions: Array<{ processorSubscriptionId: string }>;
  collections: ReconcileCollection[];
}

export interface ReconcileInput {
  now: number;
  timeoutMs?: number;
  runId?: string;
  observations?: readonly CollectionObservation[];
  disputes?: readonly ReconcileDispute[];
}

interface OrderingRow {
  processor_subscription_id: string;
  subject_kind: BillingSubjectKind;
  subject_id: string;
  processor_canceled_at: number | null;
  desired_collection: DesiredCollection;
  desired_version: number;
  applied_version: number;
  in_flight_version: number | null;
  in_flight_state: DesiredCollection | null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isDesiredCollection(value: unknown): value is DesiredCollection {
  return value === 'active' || value === 'paused' || value === 'canceled';
}

const ORDERING_COLUMNS = `processor_subscription_id, subject_kind, subject_id,
       processor_canceled_at, desired_collection, desired_version, applied_version,
       in_flight_version, in_flight_state`;

function readOrdering(
  db: RoomDatabase,
  processorSubscriptionId: string,
): OrderingRow | undefined {
  return db
    .prepare(
      `SELECT ${ORDERING_COLUMNS} FROM billing_subscriptions
       WHERE processor_subscription_id = ?`,
    )
    .get(processorSubscriptionId) as OrderingRow | undefined;
}

function hasOpenDisputeHold(
  db: RoomDatabase,
  processorSubscriptionId: string,
): boolean {
  return (
    db
      .prepare(
        `SELECT 1 AS held FROM billing_dispute_holds
         WHERE processor_subscription_id = ?
           AND state IN ('open', 'review')
         LIMIT 1`,
      )
      .get(processorSubscriptionId) !== undefined
  );
}

const PERSONAL_FETCHED_STATUS: Readonly<Record<string, EntitlementStatus>> = {
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
};

const COMPANY_FETCHED_STATUS: Readonly<Record<string, CompanySubscriptionStatus>> = {
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'unpaid',
  paused: 'paused',
  incomplete: 'incomplete',
  incomplete_expired: 'incomplete_expired',
};

function reconcileCauseApplied(db: RoomDatabase, row: OrderingRow, runId: string): boolean {
  if (row.subject_kind === 'account') {
    return (
      db
        .prepare(
          `SELECT 1 FROM entitlement_audit
           WHERE subject_kind = 'account' AND subject_id = ?
             AND cause_kind = 'reconcile' AND cause_id = ?
           LIMIT 1`,
        )
        .get(row.subject_id, runId) !== undefined
    );
  }
  return (
    db
      .prepare(
        `SELECT 1 FROM entitlement_audit
         WHERE subject_kind = 'account' AND cause_kind = 'reconcile' AND cause_id = ?
           AND subject_id IN (
             SELECT account_id FROM company_members
             WHERE company_id = ? AND state = 'active'
           )
         LIMIT 1`,
      )
      .get(runId, row.subject_id) !== undefined
  );
}

const RECONCILE_DISPUTE_PAYLOAD_HASH = '0'.repeat(64);

function disputeEventType(status: string): string {
  return status === 'needs_response' || status === 'warning_needs_response'
    ? 'charge.dispute.created'
    : 'charge.dispute.closed';
}

function applySweptDispute(
  db: RoomDatabase,
  dispute: ReconcileDispute,
): 'applied' | 'replayed' | 'ignored' {
  const verdict = applyEvent(db, {
    signatureVerified: true,
    payloadHash: RECONCILE_DISPUTE_PAYLOAD_HASH,
    event: {
      id: `reconcile:dispute:${dispute.id}:${dispute.status}`,
      type: disputeEventType(dispute.status),
      livemode: true,
      created: dispute.created,
    },
    objects: {
      dispute: {
        id: dispute.id,
        status: dispute.status,
        charge: { customer: dispute.customer },
      },
    },
  });
  if (verdict.outcome === 'ignored') return 'ignored';
  return verdict.replayed ? 'replayed' : 'applied';
}

function alertSubscriptionSkipped(
  row: OrderingRow,
  detail: string,
  status: string,
): void {
  console.error('[billing]', JSON.stringify({
    alert: 'reconcile_subscription_skipped',
    processorSubscriptionId: row.processor_subscription_id,
    status,
    detail,
    outcome: 'skipped',
  }));
}

function applyFetchedSubscription(
  db: RoomDatabase,
  row: OrderingRow,
  runId: string,
  fetched: FetchedReconcileSubscription,
  now: number,
): boolean {
  if (row.processor_canceled_at !== null) return false;
  if (reconcileCauseApplied(db, row, runId)) return false;
  const cause: EntitlementCause = {
    kind: 'reconcile',
    id: runId,
    actor: 'system:reconcile',
    reason: 'daily reconcile',
  };

  if (row.subject_kind === 'company') {
    const status = COMPANY_FETCHED_STATUS[fetched.status];
    if (status === undefined) {
      alertSubscriptionSkipped(row, 'unrepresentable_company_status', fetched.status);
      return false;
    }
    const result = applyCompanySubscriptionState(db, {
      processorSubscriptionId: row.processor_subscription_id,
      companyId: row.subject_id,
      eventCreated: now,
      now,
      fetched: {
        status,
        currentPeriodEnd: fetched.currentPeriodEnd,
        canceledAt: fetched.canceledAt,
        pauseCollection: fetched.pauseCollection || fetched.status === 'canceled',
      },
    });
    if (!result.applied) return false;
    if (result.canceledNow) {
      cancelCollection(db, {
        processorSubscriptionId: row.processor_subscription_id,
        now,
      });
    }
    materializeCompanyMemberEntitlements(db, {
      companyId: row.subject_id,
      cause,
      now,
    });
    return true;
  }

  const status = PERSONAL_FETCHED_STATUS[fetched.status];
  if (status === undefined) {
    alertSubscriptionSkipped(row, 'unrepresentable_personal_status', fetched.status);
    return false;
  }
  const entitlement = db
    .prepare(`SELECT plan_id FROM entitlements WHERE account_id = ? AND source = 'personal'`)
    .get(row.subject_id) as { plan_id: string } | undefined;
  if (!entitlement) return false;
  const result = applySubscriptionState(
    db,
    {
      processorSubscriptionId: row.processor_subscription_id,
      accountId: row.subject_id,
      planId: entitlement.plan_id as PlanId,
      processorCustomerId: fetched.customer,
      eventCreated: now,
      now,
      fetched: {
        status,
        currentPeriodEnd: fetched.currentPeriodEnd,
        canceledAt: fetched.canceledAt,
        pauseCollection: fetched.pauseCollection || status === 'canceled',
      },
    },
    cause,
  );
  if (result.canceledNow) {
    cancelCollection(db, {
      processorSubscriptionId: row.processor_subscription_id,
      now,
    });
  }
  return result.applied;
}

function parseFetchedSubscription(value: unknown): FetchedReconcileSubscription | null {
  const subscription = recordOf(value);
  if (subscription === null) return null;
  const status = subscription.status;
  if (typeof status !== 'string' || status.length < 1 || status.length > 64) return null;
  const customer = subscription.customer ?? null;
  const currentPeriodEnd = subscription.currentPeriodEnd ?? null;
  const canceledAt = subscription.canceledAt ?? null;
  const pauseCollection = subscription.pauseCollection ?? false;
  if (customer !== null && typeof customer !== 'string') return null;
  if (currentPeriodEnd !== null && typeof currentPeriodEnd !== 'number') return null;
  if (canceledAt !== null && typeof canceledAt !== 'number') return null;
  if (typeof pauseCollection !== 'boolean') return null;
  return { status, customer, currentPeriodEnd, canceledAt, pauseCollection };
}

export function actualCollectionOf(fetched: FetchedReconcileSubscription): DesiredCollection {
  if (fetched.status === 'canceled') return 'canceled';
  return fetched.pauseCollection ? 'paused' : 'active';
}

export function parseCollectionObservation(
  value: unknown,
): CollectionObservation | null {
  const observation = recordOf(value);
  if (observation === null) return null;
  const processorSubscriptionId = observation.processorSubscriptionId;
  if (
    typeof processorSubscriptionId !== 'string' ||
    processorSubscriptionId.length < 1 ||
    processorSubscriptionId.length > 256
  ) {
    return null;
  }
  if (observation.subscription !== undefined) {
    const subscription = parseFetchedSubscription(observation.subscription);
    if (subscription === null) return null;
    if (
      observation.actualCollection !== undefined &&
      observation.actualCollection !== actualCollectionOf(subscription)
    ) {
      return null;
    }
    return {
      processorSubscriptionId,
      actualCollection: actualCollectionOf(subscription),
      subscription,
    };
  }
  if (!isDesiredCollection(observation.actualCollection)) return null;
  return { processorSubscriptionId, actualCollection: observation.actualCollection };
}

export function parseReconcileDispute(value: unknown): ReconcileDispute | null {
  const dispute = recordOf(value);
  if (dispute === null) return null;
  const id = dispute.id;
  const status = dispute.status;
  const created = dispute.created;
  const customer = dispute.customer ?? null;
  if (typeof id !== 'string' || id.length < 1 || id.length > 160) return null;
  if (typeof status !== 'string' || status.length < 1 || status.length > 40) return null;
  if (typeof created !== 'number' || !Number.isFinite(created) || created < 0) return null;
  if (customer !== null && typeof customer !== 'string') return null;
  return { id, status, created, customer };
}

export interface ParsedReconcileResult {
  collections: ReconcileCollection[];
  subscriptions: Array<{ processorSubscriptionId: string }>;
  disputesSweptAt: number;
  appliedSubscriptions: number;
  disputesApplied: number;
}

export function parseReconcileResult(
  value: unknown,
): ParsedReconcileResult | null {
  const result = recordOf(value);
  if (result === null || !Array.isArray(result.collections)) return null;
  if (!Array.isArray(result.subscriptions)) return null;
  const subscriptions: Array<{ processorSubscriptionId: string }> = [];
  for (const entry of result.subscriptions) {
    const subscription = recordOf(entry);
    const processorSubscriptionId = subscription?.processorSubscriptionId;
    if (typeof processorSubscriptionId !== 'string' || processorSubscriptionId.length < 1) {
      return null;
    }
    subscriptions.push({ processorSubscriptionId });
  }
  const disputesSweptAt =
    typeof result.disputesSweptAt === 'number' && Number.isFinite(result.disputesSweptAt)
      ? result.disputesSweptAt
      : 0;
  const appliedSubscriptions =
    typeof result.appliedSubscriptions === 'number' &&
    Number.isInteger(result.appliedSubscriptions) &&
    result.appliedSubscriptions >= 0
      ? result.appliedSubscriptions
      : 0;
  const disputesApplied =
    typeof result.disputesApplied === 'number' &&
    Number.isInteger(result.disputesApplied) &&
    result.disputesApplied >= 0
      ? result.disputesApplied
      : 0;
  const collections: ReconcileCollection[] = [];
  for (const entry of result.collections) {
    const collection = recordOf(entry);
    if (collection === null) return null;
    const subjectKind = collection.subjectKind;
    const subjectId = collection.subjectId;
    const processorSubscriptionId = collection.processorSubscriptionId;
    const version = collection.version;
    const state = collection.state;
    if (subjectKind !== 'account' && subjectKind !== 'company') return null;
    if (typeof subjectId !== 'string' || subjectId.length < 1) return null;
    if (
      typeof processorSubscriptionId !== 'string' ||
      processorSubscriptionId.length < 1
    ) {
      return null;
    }
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      return null;
    }
    if (!isDesiredCollection(state)) return null;
    collections.push({
      subjectKind,
      subjectId,
      processorSubscriptionId,
      version,
      state,
    });
  }
  return { collections, subscriptions, disputesSweptAt, appliedSubscriptions, disputesApplied };
}

export function reconcileBilling(
  db: RoomDatabase,
  input: ReconcileInput,
): ReconcileResult {
  const { now } = input;
  const timeoutMs = input.timeoutMs ?? RECONCILE_IN_FLIGHT_TIMEOUT_MS;
  const runId = input.runId ?? `reconcile:${now}`;
  const result: ReconcileResult = {
    failedMarkers: 0,
    repaired: 0,
    claimed: 0,
    graceAudits: 0,
    appliedSubscriptions: 0,
    disputesApplied: 0,
    disputesSweptAt: readBillingSweep(db, 'disputes')?.lastSweptAt ?? 0,
    subscriptions: [],
    collections: [],
  };
  const recorded = new Set<string>();

  const addCollection = (
    row: OrderingRow,
    claim: { inFlightVersion: number | null; inFlightState: DesiredCollection | null },
  ): void => {
    if (claim.inFlightVersion === null || claim.inFlightState === null) return;
    if (recorded.has(row.processor_subscription_id)) return;
    recorded.add(row.processor_subscription_id);
    result.collections.push({
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      processorSubscriptionId: row.processor_subscription_id,
      version: claim.inFlightVersion,
      state: claim.inFlightState,
    });
  };

  const disputes = input.disputes ?? [];
  let unmappedDispute = false;
  for (const dispute of disputes) {
    const outcome = applySweptDispute(db, dispute);
    if (outcome === 'applied') result.disputesApplied += 1;
    if (outcome === 'ignored') unmappedDispute = true;
  }
  if (disputes.length > 0 && !unmappedDispute) {
    const lastSweptAt = Math.max(...disputes.map((dispute) => dispute.created));
    recordBillingSweep(db, { kind: 'disputes', lastSweptAt, now });
    result.disputesSweptAt = readBillingSweep(db, 'disputes')?.lastSweptAt ?? 0;
  }

  for (const observation of input.observations ?? []) {
    const row = readOrdering(db, observation.processorSubscriptionId);
    if (row === null || row === undefined) continue;
    if (observation.subscription !== undefined) {
      if (applyFetchedSubscription(db, row, runId, observation.subscription, now)) {
        result.appliedSubscriptions += 1;
      }
    }
    if (row.in_flight_version !== null) {
      if (row.in_flight_state === observation.actualCollection) {
        settleCollectionSuccess(db, {
          processorSubscriptionId: observation.processorSubscriptionId,
          expectedVersion: row.in_flight_version,
          now,
        });
      }
      continue;
    }
    if (
      row.desired_collection === 'canceled' ||
      row.desired_collection === observation.actualCollection
    ) {
      continue;
    }
    const repair = repairCollectionVersion(db, {
      processorSubscriptionId: observation.processorSubscriptionId,
      now,
    });
    if (!repair.repaired) continue;
    result.repaired += 1;
    if (!hasOpenDisputeHold(db, observation.processorSubscriptionId)) {
      console.error('[billing]', JSON.stringify({
        alert: 'collection_drift',
        processorSubscriptionId: observation.processorSubscriptionId,
        version: repair.desiredVersion,
        outcome: 'repaired',
      }));
    }
    addCollection(row, {
      inFlightVersion: repair.desiredVersion,
      inFlightState: repair.inFlightState,
    });
  }

  const staleMarkers = db
    .prepare(
      `SELECT ${ORDERING_COLUMNS} FROM billing_subscriptions
       WHERE in_flight_version IS NOT NULL AND in_flight_since <= ?
       ORDER BY processor_subscription_id`,
    )
    .all(now - timeoutMs) as OrderingRow[];
  for (const row of staleMarkers) {
    const failure = settleCollectionFailure(db, {
      processorSubscriptionId: row.processor_subscription_id,
      expectedVersion: row.in_flight_version ?? undefined,
      now,
    });
    if (failure.cleared) result.failedMarkers += 1;
    console.error('[billing]', JSON.stringify({
      alert: 'collection_marker_timeout',
      processorSubscriptionId: row.processor_subscription_id,
      version: row.in_flight_version,
      outcome: 'failed',
    }));
    const repair = repairCollectionVersion(db, {
      processorSubscriptionId: row.processor_subscription_id,
      now,
    });
    if (!repair.repaired) continue;
    result.repaired += 1;
    addCollection(row, {
      inFlightVersion: repair.desiredVersion,
      inFlightState: repair.inFlightState,
    });
  }

  const pendingClaims = db
    .prepare(
      `SELECT ${ORDERING_COLUMNS} FROM billing_subscriptions
       WHERE in_flight_version IS NULL AND applied_version < desired_version
       ORDER BY processor_subscription_id`,
    )
    .all() as OrderingRow[];
  for (const row of pendingClaims) {
    const claim = claimCollection(db, {
      processorSubscriptionId: row.processor_subscription_id,
      now,
    });
    if (!claim.claimed) continue;
    result.claimed += 1;
    addCollection(row, {
      inFlightVersion: claim.inFlightVersion,
      inFlightState: claim.inFlightState,
    });
  }

  const expiredGrace = db
    .prepare(
      `SELECT account_id, processor_subscription_id, grace_until
       FROM entitlements
       WHERE status = 'past_due' AND grace_until IS NOT NULL AND grace_until <= ?
       ORDER BY account_id, source`,
    )
    .all(now) as Array<{
    account_id: string;
    processor_subscription_id: string | null;
    grace_until: number;
  }>;
  for (const row of expiredGrace) {
    const audit = recordGraceExpiryAudit(db, {
      accountId: row.account_id,
      processorSubscriptionId: row.processor_subscription_id ?? row.account_id,
      graceUntil: row.grace_until,
      now,
    });
    if (audit.recorded) result.graceAudits += 1;
  }

  result.subscriptions = (
    db
      .prepare(
        `SELECT processor_subscription_id FROM billing_subscriptions
         WHERE processor_canceled_at IS NULL
         ORDER BY processor_subscription_id`,
      )
      .all() as Array<{ processor_subscription_id: string }>
  ).map((row) => ({ processorSubscriptionId: row.processor_subscription_id }));

  return result;
}
