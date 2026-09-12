import { PLAN_CATALOG } from './catalog';
import type { PlanDefinition, PlanId } from './catalog';

export type EntitlementSource = 'personal' | 'company';
export type EntitlementStatus = 'free' | 'trialing' | 'active' | 'past_due' | 'canceled';

export interface EntitlementRow {
  accountId: string;
  source: EntitlementSource;
  planId: PlanId;
  status: EntitlementStatus;
  graceUntil: number | null;
  collectionPaused: boolean;
  companyId: string | null;
  currentPeriodEnd: number | null;
  processorCustomerId: string | null;
  processorSubscriptionId: string | null;
  updatedAt: number;
}

export interface EffectivePlan {
  planId: PlanId;
  source: EntitlementSource | null;
  companyId: string | null;
  status: EntitlementStatus;
  limits: PlanDefinition['limits'];
  graceUntil: number | null;
  collectionPaused: boolean;
}

export function isEntitlingEntitlement(row: EntitlementRow, now: number): boolean {
  if (row.collectionPaused) return false;
  if (row.status === 'past_due') {
    return row.graceUntil !== null && now < row.graceUntil;
  }
  return row.status === 'trialing' || row.status === 'active';
}

export function resolveEffectivePlan(
  rows: readonly EntitlementRow[],
  now: number,
): EffectivePlan {
  let personal: EntitlementRow | null = null;
  let company: EntitlementRow | null = null;
  let collectionPaused = false;

  for (const candidate of rows) {
    if (isEntitlingEntitlement(candidate, now)) {
      if (candidate.source === 'company') {
        company = candidate;
      } else {
        personal = candidate;
      }
    } else if (candidate.collectionPaused) {
      collectionPaused = true;
    }
  }

  const selected = company ?? personal;
  if (selected && Object.hasOwn(PLAN_CATALOG, selected.planId)) {
    return {
      planId: selected.planId,
      source: selected.source,
      companyId: selected.companyId,
      status: selected.status,
      limits: PLAN_CATALOG[selected.planId].limits,
      graceUntil: selected.graceUntil,
      collectionPaused: false,
    };
  }
  if (selected) {
    console.error(
      '[plan]',
      JSON.stringify({ alert: 'unknown_plan_id', planId: selected.planId }),
    );
  }

  return {
    planId: 'free',
    source: null,
    companyId: null,
    status: 'free',
    limits: PLAN_CATALOG.free.limits,
    graceUntil: null,
    collectionPaused,
  };
}
