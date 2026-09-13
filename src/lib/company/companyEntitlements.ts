import type { RoomDatabase } from '../whiteboard/db';
import type { EntitlementStatus } from '../plan/effectivePlan';
import type { EntitlementCause, EntitlementState } from '../identity/entitlementWriter';
import { writeEntitlement } from '../identity/entitlementWriter';
import { listActiveMembers, readCompany } from './membership';
import {
  readCompanySubscription,
  type CompanySubscriptionRecord,
} from './seats';

function mapCompanyStatus(
  subscription: CompanySubscriptionRecord,
): EntitlementStatus {
  switch (subscription.status) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'paused':
      return 'active';
    default:
      return 'canceled';
  }
}

function companyEntitlementState(
  db: RoomDatabase,
  companyId: string,
  subscription: CompanySubscriptionRecord,
): EntitlementState {
  const status = mapCompanyStatus(subscription);
  return {
    planId: 'corporate_seat',
    status,
    graceUntil: status === 'past_due' ? subscription.graceUntil : null,
    collectionPaused:
      subscription.collectionPaused || subscription.status === 'paused',
    companyId,
    currentPeriodEnd: subscription.currentPeriodEnd,
    processorCustomerId:
      readCompany(db, companyId)?.processorCustomerId ?? null,
    processorSubscriptionId: subscription.processorSubscriptionId,
  };
}

function paidSubscription(
  db: RoomDatabase,
  companyId: string,
): CompanySubscriptionRecord | null {
  const subscription = readCompanySubscription(db, companyId);
  if (!subscription || subscription.firstPaidAt === null) return null;
  return subscription;
}

export function materializeCompanyMemberEntitlement(
  db: RoomDatabase,
  input: {
    companyId: string;
    accountId: string;
    cause: EntitlementCause;
    now: number;
  },
): { changed: boolean } {
  const subscription = paidSubscription(db, input.companyId);
  if (!subscription) return { changed: false };
  return writeEntitlement(
    db,
    {
      accountId: input.accountId,
      source: 'company',
      state: companyEntitlementState(db, input.companyId, subscription),
      now: input.now,
    },
    input.cause,
  );
}

export function materializeCompanyMemberEntitlements(
  db: RoomDatabase,
  input: { companyId: string; cause: EntitlementCause; now: number },
): { materialized: number } {
  const subscription = paidSubscription(db, input.companyId);
  if (!subscription) return { materialized: 0 };

  const state = companyEntitlementState(db, input.companyId, subscription);
  let materialized = 0;
  for (const member of listActiveMembers(db, input.companyId)) {
    const result = writeEntitlement(
      db,
      {
        accountId: member.accountId,
        source: 'company',
        state,
        now: input.now,
      },
      input.cause,
    );
    if (result.changed) materialized += 1;
  }
  return { materialized };
}
