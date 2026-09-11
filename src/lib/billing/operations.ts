import type { RoomDatabase } from '../whiteboard/db';
import {
  claimCollection,
  repairCollectionVersion,
  settleCollectionFailure,
  settleCollectionSuccess,
  type BillingSubjectKind,
  type DesiredCollection,
} from '../identity/entitlementWriter';

/**
 * Billing operation ordering (spec §3.5 / §3.6 / §12). A user operation is
 * idempotent per (subject, operationId, requestHash): the same key replayed
 * with the same payload returns the stored status, a changed payload conflicts.
 * The subscription-collection executor reads the current billing_subscriptions
 * desire and only ever mutates ordering rows through entitlementWriter.
 */

export type OperationKind =
  | 'checkout'
  | 'portal'
  | 'company-create'
  | 'seat-change'
  | 'invoice-approve'
  | 'referral-credit'
  | 'subscription-collection';

const OPERATION_KINDS: ReadonlySet<string> = new Set([
  'checkout',
  'portal',
  'company-create',
  'seat-change',
  'invoice-approve',
  'referral-credit',
  'subscription-collection',
]);

export function isValidOperationKind(kind: unknown): kind is OperationKind {
  return typeof kind === 'string' && OPERATION_KINDS.has(kind);
}

export interface UserOperationInput {
  subjectKind: BillingSubjectKind;
  subjectId: string;
  operationId: string;
  kind: OperationKind;
  stripeObjectId?: string;
}

export function recordUserOperation(
  db: RoomDatabase,
  operation: UserOperationInput,
  args: { requestHash: string; now: number },
): { status: 'replay' | 'created' | 'conflict'; record?: { status: string } } {
  const existing = db
    .prepare(
      `SELECT status, request_hash FROM billing_operations
       WHERE subject_kind = ? AND subject_id = ? AND operation_id = ?`,
    )
    .get(
      operation.subjectKind,
      operation.subjectId,
      operation.operationId,
    ) as { status: string; request_hash: string } | undefined;

  if (existing) {
    return existing.request_hash === args.requestHash
      ? { status: 'replay', record: { status: existing.status } }
      : { status: 'conflict' };
  }

  db.prepare(
    `INSERT INTO billing_operations (
       subject_kind, subject_id, operation_id, kind, request_hash, status,
       stripe_object_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    operation.subjectKind,
    operation.subjectId,
    operation.operationId,
    operation.kind,
    args.requestHash,
    operation.stripeObjectId ?? null,
    args.now,
    args.now,
  );
  return { status: 'created', record: { status: 'pending' } };
}

export interface CollectionSettleInput {
  subjectKind: BillingSubjectKind;
  subjectId: string;
  operationId: string;
  success?: boolean;
  actualCollectionState?: DesiredCollection | null;
  expectedVersion?: number;
}

export interface SettlementOutcome {
  status: string;
  reason: string;
  desiredVersion?: number;
  inFlightState?: DesiredCollection | null;
}

/**
 * Executes a collection settle (H1/H2/H4). The caller runs this inside the
 * same transaction as order recording when a claim is made.
 */
export function settleCollectionOperation(
  db: RoomDatabase,
  settle: CollectionSettleInput,
  args: { requestHash: string; now: number },
): SettlementOutcome {
  const subscription = db
    .prepare(
      `SELECT processor_subscription_id, desired_collection, desired_version,
              applied_version, in_flight_version, in_flight_state
       FROM billing_subscriptions
       WHERE subject_kind = ? AND subject_id = ?
       ORDER BY updated_at DESC, processor_subscription_id ASC
       LIMIT 1`,
    )
    .get(settle.subjectKind, settle.subjectId) as
    | {
        processor_subscription_id: string;
        desired_collection: DesiredCollection;
        desired_version: number;
        applied_version: number;
        in_flight_version: number | null;
        in_flight_state: DesiredCollection | null;
      }
    | undefined;

  const mark = (status: string): void => {
    db.prepare(
      `INSERT INTO billing_operations (
         subject_kind, subject_id, operation_id, kind, request_hash, status,
         stripe_object_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'subscription-collection', ?, ?, NULL, ?, ?)
       ON CONFLICT(subject_kind, subject_id, operation_id) DO UPDATE SET
         status = excluded.status,
         request_hash = excluded.request_hash,
         updated_at = excluded.updated_at`,
    ).run(
      settle.subjectKind,
      settle.subjectId,
      settle.operationId,
      args.requestHash,
      status,
      args.now,
      args.now,
    );
  };

  if (!subscription) {
    mark('failed');
    return { status: 'failed', reason: 'no_subscription' };
  }
  const processorSubscriptionId = subscription.processor_subscription_id;

  // Nothing in flight: either fully applied, terminally canceled, or stale and
  // needing an H1 repair (desired_version bumps, desired_collection unchanged).
  if (subscription.in_flight_version === null) {
    if (subscription.applied_version >= subscription.desired_version) {
      mark('succeeded');
      return { status: 'succeeded', reason: 'already_applied' };
    }
    if (subscription.desired_collection === 'canceled') {
      mark('succeeded');
      return { status: 'succeeded', reason: 'canceled' };
    }
    const repaired = repairCollectionVersion(db, {
      processorSubscriptionId,
      now: args.now,
    });
    mark('pending');
    return {
      status: repaired.repaired ? 'pending' : 'failed',
      reason: repaired.repaired ? 'repair' : 'repair_unavailable',
      desiredVersion: repaired.desiredVersion,
      inFlightState: repaired.inFlightState,
    };
  }

  if (
    settle.expectedVersion !== undefined &&
    settle.expectedVersion !== subscription.in_flight_version
  ) {
    return { status: 'stale', reason: 'version_mismatch' };
  }

  // H2: confirm against the actual Stripe collection state.
  if (settle.actualCollectionState !== undefined) {
    if (settle.actualCollectionState === subscription.in_flight_state) {
      settleCollectionSuccess(db, {
        processorSubscriptionId,
        expectedVersion: settle.expectedVersion,
        now: args.now,
      });
      mark('succeeded');
      return { status: 'succeeded', reason: 'confirmed' };
    }
    settleCollectionFailure(db, {
      processorSubscriptionId,
      expectedVersion: settle.expectedVersion,
      now: args.now,
    });
    mark('failed');
    return { status: 'failed', reason: 'mismatch' };
  }

  // H4: async executor reports success or definitive failure on its version.
  if (settle.success === false) {
    settleCollectionFailure(db, {
      processorSubscriptionId,
      expectedVersion: settle.expectedVersion,
      now: args.now,
    });
    mark('failed');
    return { status: 'failed', reason: 'failed' };
  }

  const outcome = settleCollectionSuccess(db, {
    processorSubscriptionId,
    expectedVersion: settle.expectedVersion,
    now: args.now,
  });
  mark(outcome.settled ? 'succeeded' : 'failed');
  return {
    status: outcome.settled ? 'succeeded' : 'failed',
    reason: outcome.settled ? 'ok' : outcome.reason,
  };
}