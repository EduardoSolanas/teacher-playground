import type { RoomDatabase } from '../whiteboard/db';
import { validateAuditContext } from './identityStore';
import type {
  EntitlementRow,
  EntitlementSource,
  EntitlementStatus,
} from '../plan/effectivePlan';
import type { PlanId } from '../plan/catalog';

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
