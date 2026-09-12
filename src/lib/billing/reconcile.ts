/**
 * R-1 daily reconcile core (spec §3.7 R-1, §7.5). The IdentityDO runs this in
 * one transaction: it never calls the network, so every state transition below
 * is provable locally. The Worker fetches what the daily sweep cannot (Stripe
 * subscription reads, disputes, seat retries) and hands the authoritative
 * collection reads back as observations.
 */
import type { RoomDatabase } from '../whiteboard/db';
import {
  claimCollection,
  recordGraceExpiryAudit,
  repairCollectionVersion,
  settleCollectionFailure,
  settleCollectionSuccess,
  type BillingSubjectKind,
  type DesiredCollection,
} from '../identity/entitlementWriter';

export const RECONCILE_IN_FLIGHT_TIMEOUT_MS = 15 * 60 * 1_000;

export interface CollectionObservation {
  processorSubscriptionId: string;
  actualCollection: DesiredCollection;
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
  collections: ReconcileCollection[];
}

export interface ReconcileInput {
  now: number;
  timeoutMs?: number;
  observations?: readonly CollectionObservation[];
}

interface OrderingRow {
  processor_subscription_id: string;
  subject_kind: BillingSubjectKind;
  subject_id: string;
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
       desired_collection, desired_version, applied_version,
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
  if (!isDesiredCollection(observation.actualCollection)) return null;
  return { processorSubscriptionId, actualCollection: observation.actualCollection };
}

export function parseReconcileResult(
  value: unknown,
): { collections: ReconcileCollection[] } | null {
  const result = recordOf(value);
  if (result === null || !Array.isArray(result.collections)) return null;
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
  return { collections };
}

export function reconcileBilling(
  db: RoomDatabase,
  input: ReconcileInput,
): ReconcileResult {
  const { now } = input;
  const timeoutMs = input.timeoutMs ?? RECONCILE_IN_FLIGHT_TIMEOUT_MS;
  const result: ReconcileResult = {
    failedMarkers: 0,
    repaired: 0,
    claimed: 0,
    graceAudits: 0,
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

  for (const observation of input.observations ?? []) {
    const row = readOrdering(db, observation.processorSubscriptionId);
    if (row === null || row === undefined) continue;
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

  return result;
}
