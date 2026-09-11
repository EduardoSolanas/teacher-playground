import { describe, expect, it } from 'vitest';
import { PLAN_CATALOG } from './catalog';
import { isEntitlingEntitlement, resolveEffectivePlan } from './effectivePlan';
import type { EntitlementRow } from './effectivePlan';

function row(overrides: Partial<EntitlementRow> = {}): EntitlementRow {
  return {
    accountId: 'acc-1',
    source: 'personal',
    planId: 'tutor_pro_monthly',
    status: 'active',
    graceUntil: null,
    collectionPaused: false,
    companyId: null,
    currentPeriodEnd: null,
    processorCustomerId: 'cus_1',
    processorSubscriptionId: 'sub_1',
    updatedAt: 500,
    ...overrides,
  };
}

describe('isEntitlingEntitlement', () => {
  it('entitles active and trialing rows', () => {
    expect(isEntitlingEntitlement(row({ status: 'active' }), 1_000)).toBe(true);
    expect(isEntitlingEntitlement(row({ status: 'trialing' }), 1_000)).toBe(true);
  });

  it('never entitles canceled or free rows', () => {
    expect(isEntitlingEntitlement(row({ status: 'canceled' }), 1_000)).toBe(false);
    expect(isEntitlingEntitlement(row({ status: 'free', planId: 'free' }), 1_000)).toBe(false);
  });

  it('entitles past_due strictly before grace_until and not at it or after', () => {
    const graceUntil = 10_000;
    const pastDue = row({ status: 'past_due', graceUntil });

    expect(isEntitlingEntitlement(pastDue, graceUntil - 1)).toBe(true);
    expect(isEntitlingEntitlement(pastDue, graceUntil)).toBe(false);
    expect(isEntitlingEntitlement(pastDue, graceUntil + 1)).toBe(false);

    expect(resolveEffectivePlan([pastDue], graceUntil - 1).planId).toBe('tutor_pro_monthly');
    expect(resolveEffectivePlan([pastDue], graceUntil).planId).toBe('free');
  });

  it('never entitles past_due without a grace deadline', () => {
    expect(isEntitlingEntitlement(row({ status: 'past_due', graceUntil: null }), 1_000)).toBe(false);
  });

  it('never entitles a paused row even while active or trialing', () => {
    expect(isEntitlingEntitlement(row({ status: 'active', collectionPaused: true }), 1_000)).toBe(false);
    expect(isEntitlingEntitlement(row({ status: 'trialing', collectionPaused: true }), 1_000)).toBe(false);
    expect(
      isEntitlingEntitlement(row({ status: 'past_due', graceUntil: 5_000, collectionPaused: true }), 1_000),
    ).toBe(false);

    expect(resolveEffectivePlan([row({ collectionPaused: true })], 1_000).planId).toBe('free');
  });
});

describe('resolveEffectivePlan', () => {
  it('returns Free with no source when the account has no entitlement rows', () => {
    const plan = resolveEffectivePlan([], 1_000);

    expect(plan.planId).toBe('free');
    expect(plan.source).toBeNull();
    expect(plan.companyId).toBeNull();
    expect(plan.status).toBe('free');
    expect(plan.limits).toBe(PLAN_CATALOG.free.limits);
  });

  it('returns an entitling row with its own status and catalog limits', () => {
    const plan = resolveEffectivePlan(
      [row({ planId: 'tutor_pro_annual', status: 'active', companyId: null })],
      1_000,
    );

    expect(plan.planId).toBe('tutor_pro_annual');
    expect(plan.source).toBe('personal');
    expect(plan.status).toBe('active');
    expect(plan.companyId).toBeNull();
    expect(plan.limits).toBe(PLAN_CATALOG.tutor_pro_annual.limits);
  });

  it('prefers an entitling company row over an entitling personal row', () => {
    const personal = row({ planId: 'tutor_pro_monthly', source: 'personal', companyId: null });
    const company = row({ planId: 'corporate_seat', source: 'company', companyId: 'co-1' });

    const plan = resolveEffectivePlan([personal, company], 1_000);

    expect(plan.planId).toBe('corporate_seat');
    expect(plan.source).toBe('company');
    expect(plan.companyId).toBe('co-1');
    expect(plan.limits).toBe(PLAN_CATALOG.corporate_seat.limits);
  });

  it('does not let a non-entitling company row block an entitling personal row', () => {
    const personal = row({ planId: 'tutor_pro_annual', source: 'personal' });
    const pausedCompany = row({ source: 'company', companyId: 'co-1', collectionPaused: true });

    const plan = resolveEffectivePlan([pausedCompany, personal], 1_000);

    expect(plan.planId).toBe('tutor_pro_annual');
    expect(plan.source).toBe('personal');
    expect(plan.companyId).toBeNull();
  });
});
