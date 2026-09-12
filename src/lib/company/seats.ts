import type { RoomDatabase } from '../whiteboard/db';
import {
  releaseCompanySeatChange,
  reserveCompanySeatChange,
  settleCompanySeatChange,
} from '../identity/entitlementWriter';
import { readMember } from './membership';

export type CompanySubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused'
  | 'incomplete'
  | 'incomplete_expired';

export type CollectionMethod = 'charge_automatically' | 'send_invoice';

export interface CompanySubscriptionRecord {
  companyId: string;
  processorSubscriptionId: string;
  quantity: number;
  pendingQuantity: number | null;
  pendingOperationId: string | null;
  status: CompanySubscriptionStatus;
  graceUntil: number | null;
  collectionPaused: boolean;
  collectionMethod: CollectionMethod;
  currentPeriodEnd: number | null;
  firstPaidAt: number | null;
  updatedAt: number;
}

interface CompanySubscriptionDbRow {
  company_id: string;
  processor_subscription_id: string;
  quantity: number;
  pending_quantity: number | null;
  pending_operation_id: string | null;
  status: CompanySubscriptionStatus;
  grace_until: number | null;
  collection_paused: number;
  collection_method: CollectionMethod;
  current_period_end: number | null;
  first_paid_at: number | null;
  updated_at: number;
}

export function readCompanySubscription(
  db: RoomDatabase,
  companyId: string,
): CompanySubscriptionRecord | null {
  const row = db
    .prepare(
      `SELECT company_id, processor_subscription_id, quantity, pending_quantity,
              pending_operation_id, status, grace_until, collection_paused,
              collection_method, current_period_end, first_paid_at, updated_at
       FROM company_subscriptions WHERE company_id = ?`,
    )
    .get(companyId) as CompanySubscriptionDbRow | undefined;
  if (!row) return null;
  return {
    companyId: row.company_id,
    processorSubscriptionId: row.processor_subscription_id,
    quantity: Number(row.quantity),
    pendingQuantity:
      row.pending_quantity === null ? null : Number(row.pending_quantity),
    pendingOperationId: row.pending_operation_id,
    status: row.status,
    graceUntil: row.grace_until,
    collectionPaused: row.collection_paused === 1,
    collectionMethod: row.collection_method,
    currentPeriodEnd: row.current_period_end,
    firstPaidAt: row.first_paid_at,
    updatedAt: row.updated_at,
  };
}

export function seatCapacity(db: RoomDatabase, companyId: string): number {
  const subscription = readCompanySubscription(db, companyId);
  if (!subscription) return 1;
  return Math.min(
    subscription.quantity,
    subscription.pendingQuantity ?? subscription.quantity,
  );
}

export function activeMemberCount(db: RoomDatabase, companyId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM company_members
       WHERE company_id = ? AND state = 'active'`,
    )
    .get(companyId) as { count: number };
  return Number(row.count);
}

export interface SeatChangeOperationRecord {
  operationId: string;
  requestHash: string;
  status: 'pending' | 'succeeded' | 'failed';
  stripeObjectId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SeatChangeOperationDbRow {
  operation_id: string;
  request_hash: string;
  status: 'pending' | 'succeeded' | 'failed';
  stripe_object_id: string | null;
  created_at: number;
  updated_at: number;
}

function toSeatChangeOperation(
  row: SeatChangeOperationDbRow,
): SeatChangeOperationRecord {
  return {
    operationId: row.operation_id,
    requestHash: row.request_hash,
    status: row.status,
    stripeObjectId: row.stripe_object_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readSeatChangeOperation(
  db: RoomDatabase,
  companyId: string,
  operationId: string,
): SeatChangeOperationRecord | null {
  const row = db
    .prepare(
      `SELECT operation_id, request_hash, status, stripe_object_id,
              created_at, updated_at
       FROM billing_operations
       WHERE subject_kind = 'company' AND subject_id = ?
         AND operation_id = ? AND kind = 'seat-change'`,
    )
    .get(companyId, operationId) as SeatChangeOperationDbRow | undefined;
  return row ? toSeatChangeOperation(row) : null;
}

export function readPendingSeatChange(
  db: RoomDatabase,
  companyId: string,
): SeatChangeOperationRecord | null {
  const row = db
    .prepare(
      `SELECT operation_id, request_hash, status, stripe_object_id,
              created_at, updated_at
       FROM billing_operations
       WHERE subject_kind = 'company' AND subject_id = ?
         AND kind = 'seat-change' AND status = 'pending'
       ORDER BY created_at DESC, operation_id DESC
       LIMIT 1`,
    )
    .get(companyId) as SeatChangeOperationDbRow | undefined;
  return row ? toSeatChangeOperation(row) : null;
}

export type SeatChangeDirection = 'increase' | 'decrease';
export type SeatChangeProration = 'create_prorations' | 'none';

export type ReserveSeatChangeOutcome =
  | {
      outcome: 'reserved';
      operationId: string;
      targetQuantity: number;
      direction: SeatChangeDirection;
      prorationBehavior: SeatChangeProration;
    }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'change_pending' }
  | { outcome: 'below_active_members' }
  | { outcome: 'no_change' };

export function reserveSeatChange(
  db: RoomDatabase,
  input: {
    companyId: string;
    actorAccountId: string;
    targetQuantity: number;
    operationId: string;
    requestHash: string;
    now: number;
  },
): ReserveSeatChangeOutcome {
  return db.transaction((): ReserveSeatChangeOutcome => {
    const subscription = readCompanySubscription(db, input.companyId);
    if (!subscription) return { outcome: 'not_found' };

    const actor = readMember(db, input.companyId, input.actorAccountId);
    if (!actor || actor.state !== 'active' || actor.role !== 'owner') {
      return { outcome: 'forbidden' };
    }
    if (
      subscription.pendingOperationId !== null ||
      readPendingSeatChange(db, input.companyId)
    ) {
      return { outcome: 'change_pending' };
    }
    if (input.targetQuantity === subscription.quantity) {
      return { outcome: 'no_change' };
    }

    const direction: SeatChangeDirection =
      input.targetQuantity > subscription.quantity ? 'increase' : 'decrease';
    if (
      direction === 'decrease' &&
      input.targetQuantity < activeMemberCount(db, input.companyId)
    ) {
      return { outcome: 'below_active_members' };
    }

    db.prepare(
      `INSERT INTO billing_operations (
         subject_kind, subject_id, operation_id, kind, request_hash,
         status, created_at, updated_at
       ) VALUES ('company', ?, ?, 'seat-change', ?, 'pending', ?, ?)`,
    ).run(
      input.companyId,
      input.operationId,
      input.requestHash,
      input.now,
      input.now,
    );

    reserveCompanySeatChange(db, {
      companyId: input.companyId,
      operationId: input.operationId,
      targetQuantity: input.targetQuantity,
      now: input.now,
    });

    return {
      outcome: 'reserved',
      operationId: input.operationId,
      targetQuantity: input.targetQuantity,
      direction,
      prorationBehavior:
        direction === 'increase' ? 'create_prorations' : 'none',
    };
  })();
}

function transitionSeatChange(
  db: RoomDatabase,
  input: { companyId: string; operationId: string; now: number },
  next: 'succeeded' | 'failed',
): boolean {
  return db.transaction(() => {
    const transitioned =
      db
        .prepare(
          `UPDATE billing_operations SET status = ?, updated_at = ?
           WHERE subject_kind = 'company' AND subject_id = ?
             AND operation_id = ? AND kind = 'seat-change' AND status = 'pending'`,
        )
        .run(next, input.now, input.companyId, input.operationId).changes === 1;
    if (!transitioned) return false;

    if (next === 'succeeded') {
      settleCompanySeatChange(db, {
        companyId: input.companyId,
        operationId: input.operationId,
        now: input.now,
      });
    } else {
      releaseCompanySeatChange(db, {
        companyId: input.companyId,
        operationId: input.operationId,
        now: input.now,
      });
    }

    return true;
  })();
}

export function settleSeatChange(
  db: RoomDatabase,
  input: { companyId: string; operationId: string; now: number },
): { settled: boolean } {
  return { settled: transitionSeatChange(db, input, 'succeeded') };
}

export function releaseSeatChange(
  db: RoomDatabase,
  input: { companyId: string; operationId: string; now: number },
): { released: boolean } {
  return { released: transitionSeatChange(db, input, 'failed') };
}
