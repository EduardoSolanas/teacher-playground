import type { RoomDatabase } from '../whiteboard/db';
import { validateAuditContext } from './identityStore';
import type { EntitlementRow, EntitlementSource, EntitlementStatus } from '../plan/effectivePlan';
import { PAST_DUE_GRACE_MS, type PlanId } from '../plan/catalog';

export type EntitlementCauseKind =
  | 'processor_event'
  | 'membership'
  | 'seat_operation'
  | 'reconcile'
  | 'grace_expiry'
  | 'operator'
  | 'erasure';

export interface EntitlementCause {
  kind: EntitlementCauseKind;
  id: string;
  actor: string;
  reason: string;
}

export interface EntitlementState {
  planId: PlanId;
  status: EntitlementStatus;
  graceUntil: number | null;
  collectionPaused: boolean;
  companyId: string | null;
  currentPeriodEnd: number | null;
  processorCustomerId: string | null;
  processorSubscriptionId: string | null;
}

export interface EntitlementWrite {
  accountId: string;
  source: EntitlementSource;
  state: EntitlementState;
  now: number;
}

interface EntitlementDbRow {
  plan_id: string;
  status: string;
  grace_until: number | null;
  collection_paused: number;
  company_id: string | null;
  current_period_end: number | null;
  processor_customer_id: string | null;
  processor_subscription_id: string | null;
}

function stateMatches(row: EntitlementDbRow, state: EntitlementState): boolean {
  return (
    row.plan_id === state.planId &&
    row.status === state.status &&
    row.grace_until === state.graceUntil &&
    row.collection_paused === (state.collectionPaused ? 1 : 0) &&
    row.company_id === state.companyId &&
    row.current_period_end === state.currentPeriodEnd &&
    row.processor_customer_id === state.processorCustomerId &&
    row.processor_subscription_id === state.processorSubscriptionId
  );
}

/**
 * Writes one entitlement row and its audit trail. MUST run inside the
 * caller's transaction: it neither opens one nor calls the network, so the
 * entitlement change commits or rolls back with the change that caused it.
 * A cause whose state already matches writes nothing; the unique audit-cause
 * index makes replays exactly-once.
 */
export function writeEntitlement(
  db: RoomDatabase,
  write: EntitlementWrite,
  cause: EntitlementCause,
): { changed: boolean } {
  const { actor, reason } = validateAuditContext(cause);
  const existing = db
    .prepare(
      `SELECT plan_id, status, grace_until, collection_paused, company_id,
              current_period_end, processor_customer_id, processor_subscription_id
       FROM entitlements WHERE account_id = ? AND source = ?`,
    )
    .get(write.accountId, write.source) as EntitlementDbRow | undefined;

  if (existing && stateMatches(existing, write.state)) {
    return { changed: false };
  }

  const { state } = write;
  if (existing) {
    db.prepare(
      `UPDATE entitlements
       SET plan_id = ?, status = ?, grace_until = ?, collection_paused = ?,
           company_id = ?, current_period_end = ?, processor_customer_id = ?,
           processor_subscription_id = ?, updated_at = ?
       WHERE account_id = ? AND source = ?`,
    ).run(
      state.planId,
      state.status,
      state.graceUntil,
      state.collectionPaused ? 1 : 0,
      state.companyId,
      state.currentPeriodEnd,
      state.processorCustomerId,
      state.processorSubscriptionId,
      write.now,
      write.accountId,
      write.source,
    );
  } else {
    db.prepare(
      `INSERT INTO entitlements (
         account_id, source, plan_id, status, grace_until, collection_paused,
         company_id, current_period_end, processor_customer_id,
         processor_subscription_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      write.accountId,
      write.source,
      state.planId,
      state.status,
      state.graceUntil,
      state.collectionPaused ? 1 : 0,
      state.companyId,
      state.currentPeriodEnd,
      state.processorCustomerId,
      state.processorSubscriptionId,
      write.now,
    );
  }

  db.prepare(
    `INSERT INTO entitlement_audit (
       audit_id, subject_kind, subject_id, action, cause_kind, cause_id,
       actor, reason, previous_plan, next_plan, previous_status, next_status,
       processor_event_id, created_at
     ) VALUES (?, 'account', ?, 'entitlement_change', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    write.accountId,
    cause.kind,
    cause.id,
    actor,
    reason,
    existing?.plan_id ?? null,
    state.planId,
    existing?.status ?? null,
    state.status,
    cause.kind === 'processor_event' ? cause.id : null,
    write.now,
  );

  return { changed: true };
}

export function readEntitlementsForAccount(
  db: RoomDatabase,
  accountId: string,
): EntitlementRow[] {
  const rows = db
    .prepare(
      `SELECT account_id, source, plan_id, status, grace_until,
              collection_paused, company_id, current_period_end,
              processor_customer_id, processor_subscription_id, updated_at
       FROM entitlements WHERE account_id = ? ORDER BY source`,
    )
    .all(accountId) as Array<{
    account_id: string;
    source: string;
    plan_id: string;
    status: string;
    grace_until: number | null;
    collection_paused: number;
    company_id: string | null;
    current_period_end: number | null;
    processor_customer_id: string | null;
    processor_subscription_id: string | null;
    updated_at: number;
  }>;

  return rows.map((row) => ({
    accountId: row.account_id,
    source: row.source as EntitlementSource,
    planId: row.plan_id as PlanId,
    status: row.status as EntitlementStatus,
    graceUntil: row.grace_until,
    collectionPaused: row.collection_paused === 1,
    companyId: row.company_id,
    currentPeriodEnd: row.current_period_end,
    processorCustomerId: row.processor_customer_id,
    processorSubscriptionId: row.processor_subscription_id,
    updatedAt: row.updated_at,
  }));
}

/**
 * Billing ordering / collection writers (spec §3.3, §3.6, §7). These own the
 * billing_subscriptions, billing_dispute_holds and company_subscriptions rows
 * and the entitlements they drive; callers (apply/operations) never touch
 * those tables directly. All run under the caller's transaction.
 */

export type BillingSubjectKind = 'account' | 'company';
export type DesiredCollection = 'active' | 'paused' | 'canceled';
export type DisputeHoldState = 'open' | 'review' | 'won' | 'lost';

interface SubscriptionOrderingRow {
  subject_kind: BillingSubjectKind;
  subject_id: string;
  last_state_event_created: number;
  processor_canceled_at: number | null;
  desired_collection: DesiredCollection;
  desired_version: number;
  applied_version: number;
  in_flight_version: number | null;
  in_flight_state: DesiredCollection | null;
  in_flight_since: number | null;
}

function readSubscriptionOrdering(
  db: RoomDatabase,
  processorSubscriptionId: string,
): SubscriptionOrderingRow | undefined {
  return db
    .prepare(
      `SELECT subject_kind, subject_id, last_state_event_created, processor_canceled_at,
              desired_collection, desired_version, applied_version,
              in_flight_version, in_flight_state, in_flight_since
       FROM billing_subscriptions WHERE processor_subscription_id = ?`,
    )
    .get(processorSubscriptionId) as SubscriptionOrderingRow | undefined;
}

/** Creates the ordering row on first sight of a subscription. */
export function ensureBillingSubscription(
  db: RoomDatabase,
  args: {
    processorSubscriptionId: string;
    subjectKind: BillingSubjectKind;
    subjectId: string;
    now: number;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO billing_subscriptions (
       processor_subscription_id, subject_kind, subject_id, updated_at
     ) VALUES (?, ?, ?, ?)`,
  ).run(args.processorSubscriptionId, args.subjectKind, args.subjectId, args.now);
}

/**
 * Class-1 subscription state write: the entitlement and the ordering
 * watermark/cancel tombstone are one unit. Skips when the processor already
 * reported a cancel (absorbing) or the event is older than the applied state.
 */
export function applySubscriptionState(
  db: RoomDatabase,
  write: {
    processorSubscriptionId: string;
    accountId: string;
    planId: PlanId;
    processorCustomerId: string | null;
    eventCreated: number;
    now: number;
    fetched: {
      status: EntitlementStatus;
      currentPeriodEnd: number | null;
      canceledAt: number | null;
      pauseCollection: boolean;
    };
  },
  cause: EntitlementCause,
): { applied: boolean; canceledNow: boolean } {
  ensureBillingSubscription(db, {
    processorSubscriptionId: write.processorSubscriptionId,
    subjectKind: 'account',
    subjectId: write.accountId,
    now: write.now,
  });
  const row = readSubscriptionOrdering(db, write.processorSubscriptionId);
  if (!row) return { applied: false, canceledNow: false };
  if (row.processor_canceled_at !== null) {
    return { applied: false, canceledNow: false };
  }
  if (write.eventCreated < row.last_state_event_created) {
    return { applied: false, canceledNow: false };
  }

  const canceledNow = write.fetched.status === 'canceled';
  const existing = db
    .prepare(
      `SELECT plan_id, status, grace_until, company_id, current_period_end
       FROM entitlements WHERE account_id = ? AND source = 'personal'`,
    )
    .get(write.accountId) as
    | { plan_id: string; status: string; grace_until: number | null; company_id: string | null; current_period_end: number | null }
    | undefined;

  let graceUntil: number | null = null;
  if (write.fetched.status === 'past_due') {
    const alreadyOpen =
      existing !== undefined &&
      existing.status === 'past_due' &&
      existing.grace_until !== null;
    graceUntil = alreadyOpen
      ? existing!.grace_until
      : write.eventCreated + PAST_DUE_GRACE_MS;
  }

  writeEntitlement(
    db,
    {
      accountId: write.accountId,
      source: 'personal',
      state: {
        planId: write.planId,
        status: write.fetched.status,
        graceUntil,
        collectionPaused: write.fetched.pauseCollection,
        companyId: existing?.company_id ?? null,
        currentPeriodEnd: write.fetched.currentPeriodEnd,
        processorCustomerId: write.processorCustomerId,
        processorSubscriptionId: write.processorSubscriptionId,
      },
      now: write.now,
    },
    cause,
  );

  db.prepare(
    `UPDATE billing_subscriptions
     SET last_state_event_created = ?, processor_canceled_at = ?, updated_at = ?
     WHERE processor_subscription_id = ?`,
  ).run(
    write.eventCreated,
    canceledNow ? (write.fetched.canceledAt ?? write.now) : row.processor_canceled_at,
    write.now,
    write.processorSubscriptionId,
  );

  return { applied: true, canceledNow };
}

/**
 * P-9 absorbing cancel: collection is canceled, nothing is left in flight, and
 * applied advances to the cancel so reconciliation never repairs it.
 */
export function cancelCollection(
  db: RoomDatabase,
  args: { processorSubscriptionId: string; now: number },
): { changed: boolean; desiredVersion: number } {
  const row = readSubscriptionOrdering(db, args.processorSubscriptionId);
  if (!row) return { changed: false, desiredVersion: 0 };
  if (row.desired_collection === 'canceled' && row.in_flight_version === null) {
    return { changed: false, desiredVersion: row.desired_version };
  }
  const desiredVersion = row.desired_version + 1;
  db.prepare(
    `UPDATE billing_subscriptions
     SET desired_collection = 'canceled', desired_version = ?, applied_version = ?,
         in_flight_version = NULL, in_flight_state = NULL, in_flight_since = NULL,
         updated_at = ?
     WHERE processor_subscription_id = ?`,
  ).run(desiredVersion, desiredVersion, args.now, args.processorSubscriptionId);
  return { changed: true, desiredVersion };
}

/**
 * Forward-only dispute hold: a dispute only moves open -> review -> won -> lost
 * and never regresses, so a stale "created" cannot unpause a won/lost row.
 */
export function upsertDisputeHold(
  db: RoomDatabase,
  args: {
    disputeId: string;
    processorSubscriptionId: string;
    state: DisputeHoldState;
    now: number;
  },
): { stateChanged: boolean; state: DisputeHoldState } {
  const existing = db
    .prepare(`SELECT state FROM billing_dispute_holds WHERE dispute_id = ?`)
    .get(args.disputeId) as { state: DisputeHoldState } | undefined;

  if (existing) {
    const rank: Record<DisputeHoldState, number> = { open: 0, review: 1, won: 2, lost: 3 };
    if (rank[args.state] <= rank[existing.state]) {
      return { stateChanged: false, state: existing.state };
    }
    db.prepare(
      `UPDATE billing_dispute_holds SET state = ?, closed_at = ?, updated_at = ?
       WHERE dispute_id = ?`,
    ).run(args.state, args.state === 'open' ? null : args.now, args.now, args.disputeId);
    return { stateChanged: true, state: args.state };
  }

  db.prepare(
    `INSERT INTO billing_dispute_holds (
       dispute_id, processor_subscription_id, state, first_seen_at, closed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    args.disputeId,
    args.processorSubscriptionId,
    args.state,
    args.now,
    args.state === 'open' ? null : args.now,
    args.now,
  );
  return { stateChanged: true, state: args.state };
}

/**
 * Recomputes desired_collection from the open holds: any lost dispute cancels
 * (absorbing), any open/review dispute pauses, otherwise active. A version is
 * bumped only when the desire actually changes. Canceled is never regressed.
 */
export function recomputeDesiredCollection(
  db: RoomDatabase,
  args: { processorSubscriptionId: string; cause: EntitlementCause; now: number },
): { changed: boolean; desired: DesiredCollection } {
  const row = readSubscriptionOrdering(db, args.processorSubscriptionId);
  if (!row) return { changed: false, desired: 'active' };
  if (row.desired_collection === 'canceled') {
    return { changed: false, desired: 'canceled' };
  }

  const holds = db
    .prepare(`SELECT state FROM billing_dispute_holds WHERE processor_subscription_id = ?`)
    .all(args.processorSubscriptionId) as Array<{ state: DisputeHoldState }>;
  const hasLost = holds.some((hold) => hold.state === 'lost');
  const hasActive = holds.some((hold) => hold.state === 'open' || hold.state === 'review');
  const desired: DesiredCollection = hasLost
    ? 'canceled'
    : hasActive
      ? 'paused'
      : 'active';
  if (desired === row.desired_collection) {
    return { changed: false, desired };
  }

  db.prepare(
    `UPDATE billing_subscriptions
     SET desired_collection = ?, desired_version = desired_version + 1, updated_at = ?
     WHERE processor_subscription_id = ?`,
  ).run(desired, args.now, args.processorSubscriptionId);

  if (row.subject_kind === 'account') {
    const current = db
      .prepare(
        `SELECT plan_id, status, grace_until, company_id, current_period_end,
                processor_customer_id, processor_subscription_id
         FROM entitlements WHERE account_id = ? AND source = 'personal'`,
      )
      .get(row.subject_id) as
      | {
          plan_id: string;
          status: string;
          grace_until: number | null;
          company_id: string | null;
          current_period_end: number | null;
          processor_customer_id: string | null;
          processor_subscription_id: string | null;
        }
      | undefined;
    if (current) {
      writeEntitlement(
        db,
        {
          accountId: row.subject_id,
          source: 'personal',
          state: {
            planId: current.plan_id as PlanId,
            status: current.status as EntitlementStatus,
            graceUntil: current.grace_until,
            collectionPaused: desired !== 'active',
            companyId: current.company_id,
            currentPeriodEnd: current.current_period_end,
            processorCustomerId: current.processor_customer_id,
            processorSubscriptionId: current.processor_subscription_id,
          },
          now: args.now,
        },
        args.cause,
      );
    }
  }

  return { changed: true, desired };
}

/** Acquires the collection in-flight marker when nothing else holds it. */
export function claimCollection(
  db: RoomDatabase,
  args: { processorSubscriptionId: string; now: number },
): {
  claimed: boolean;
  inFlightVersion: number | null;
  inFlightState: DesiredCollection | null;
} {
  const row = readSubscriptionOrdering(db, args.processorSubscriptionId);
  if (!row) {
    return { claimed: false, inFlightVersion: null, inFlightState: null };
  }
  if (row.in_flight_version !== null) {
    return {
      claimed: false,
      inFlightVersion: row.in_flight_version,
      inFlightState: row.in_flight_state,
    };
  }
  if (row.applied_version >= row.desired_version) {
    return { claimed: false, inFlightVersion: null, inFlightState: null };
  }
  db.prepare(
    `UPDATE billing_subscriptions
     SET in_flight_version = ?, in_flight_state = ?, in_flight_since = ?, updated_at = ?
     WHERE processor_subscription_id = ?`,
  ).run(row.desired_version, row.desired_collection, args.now, args.now, args.processorSubscriptionId);
  return {
    claimed: true,
    inFlightVersion: row.desired_version,
    inFlightState: row.desired_collection,
  };
}

/**
 * H4 settle success: the claimed version becomes applied and the marker
 * clears; if a newer desire exists, it is claimed immediately.
 */
export function settleCollectionSuccess(
  db: RoomDatabase,
  args: { processorSubscriptionId: string; expectedVersion: number | undefined; now: number },
): { settled: boolean; reason: 'ok' | 'stale' | 'already_applied' | 'not_claimed' | 'missing' } {
  const row = readSubscriptionOrdering(db, args.processorSubscriptionId);
  if (!row) return { settled: false, reason: 'missing' };
  if (row.in_flight_version === null) {
    return {
      settled: row.applied_version >= row.desired_version,
      reason: row.applied_version >= row.desired_version ? 'already_applied' : 'not_claimed',
    };
  }
  if (args.expectedVersion !== undefined && args.expectedVersion !== row.in_flight_version) {
    return { settled: false, reason: 'stale' };
  }
  db.prepare(
    `UPDATE billing_subscriptions
     SET applied_version = ?, in_flight_version = NULL, in_flight_state = NULL,
         in_flight_since = NULL, updated_at = ?
     WHERE processor_subscription_id = ?`,
  ).run(row.in_flight_version, args.now, args.processorSubscriptionId);
  if (row.in_flight_version < row.desired_version) {
    claimCollection(db, { processorSubscriptionId: args.processorSubscriptionId, now: args.now });
  }
  return { settled: true, reason: 'ok' };
}

/**
 * H4 settle failure: the marker clears and the desire is left pending for the
 * user to retry; applied never moves.
 */
export function settleCollectionFailure(
  db: RoomDatabase,
  args: { processorSubscriptionId: string; expectedVersion: number | undefined; now: number },
): { cleared: boolean; reason: 'ok' | 'stale' | 'not_claimed' | 'missing' } {
  const row = readSubscriptionOrdering(db, args.processorSubscriptionId);
  if (!row) return { cleared: false, reason: 'missing' };
  if (row.in_flight_version === null) return { cleared: false, reason: 'not_claimed' };
  if (args.expectedVersion !== undefined && args.expectedVersion !== row.in_flight_version) {
    return { cleared: false, reason: 'stale' };
  }
  db.prepare(
    `UPDATE billing_subscriptions
     SET in_flight_version = NULL, in_flight_state = NULL, in_flight_since = NULL,
         updated_at = ?
     WHERE processor_subscription_id = ?`,
  ).run(args.now, args.processorSubscriptionId);
  return { cleared: true, reason: 'ok' };
}

/**
 * H1 repair: when the applied_collection is stale with no claim in flight, the
 * desired version is invalidated (desired_collection unchanged) and the next
 * claim is acquired. Canceled subscriptions are never repaired.
 */
export function repairCollectionVersion(
  db: RoomDatabase,
  args: { processorSubscriptionId: string; now: number },
): { repaired: boolean; desiredVersion: number; inFlightState: DesiredCollection | null } {
  const row = readSubscriptionOrdering(db, args.processorSubscriptionId);
  if (!row) return { repaired: false, desiredVersion: 0, inFlightState: null };
  if (row.desired_collection === 'canceled') {
    return { repaired: false, desiredVersion: row.desired_version, inFlightState: null };
  }
  if (row.applied_version >= row.desired_version || row.in_flight_version !== null) {
    return {
      repaired: false,
      desiredVersion: row.desired_version,
      inFlightState: row.in_flight_state,
    };
  }
  db.prepare(
    `UPDATE billing_subscriptions
     SET desired_version = ?, updated_at = ?
     WHERE processor_subscription_id = ?`,
  ).run(row.desired_version + 1, args.now, args.processorSubscriptionId);
  claimCollection(db, { processorSubscriptionId: args.processorSubscriptionId, now: args.now });
  return {
    repaired: true,
    desiredVersion: row.desired_version + 1,
    inFlightState: row.desired_collection,
  };
}

/** First paid timestamp on a company subscription, set exactly once. */
export function setCompanyFirstPaidAt(
  db: RoomDatabase,
  args: { processorSubscriptionId: string; occurredAt: number },
): { updated: boolean } {
  const result = db
    .prepare(
      `UPDATE company_subscriptions SET first_paid_at = ?
       WHERE processor_subscription_id = ? AND first_paid_at IS NULL`,
    )
    .run(args.occurredAt, args.processorSubscriptionId);
  return { updated: result.changes === 1 };
}

export function reserveCompanySeatChange(
  db: RoomDatabase,
  args: { companyId: string; operationId: string; targetQuantity: number; now: number },
): { updated: boolean } {
  const result = db
    .prepare(
      `UPDATE company_subscriptions
       SET pending_quantity = ?, pending_operation_id = ?, updated_at = ?
       WHERE company_id = ?`,
    )
    .run(args.targetQuantity, args.operationId, args.now, args.companyId);
  return { updated: result.changes === 1 };
}

export function settleCompanySeatChange(
  db: RoomDatabase,
  args: { companyId: string; operationId: string; now: number },
): { updated: boolean } {
  const result = db
    .prepare(
      `UPDATE company_subscriptions
       SET quantity = pending_quantity, pending_quantity = NULL,
           pending_operation_id = NULL, updated_at = ?
       WHERE company_id = ? AND pending_operation_id = ?`,
    )
    .run(args.now, args.companyId, args.operationId);
  return { updated: result.changes === 1 };
}

export function releaseCompanySeatChange(
  db: RoomDatabase,
  args: { companyId: string; operationId: string; now: number },
): { updated: boolean } {
  const result = db
    .prepare(
      `UPDATE company_subscriptions
       SET pending_quantity = NULL, pending_operation_id = NULL, updated_at = ?
       WHERE company_id = ? AND pending_operation_id = ?`,
    )
    .run(args.now, args.companyId, args.operationId);
  return { updated: result.changes === 1 };
}
