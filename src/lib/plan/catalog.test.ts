import { describe, expect, it } from 'vitest';
import { FREE_MAX_ROOMS, FREE_MAX_USERS } from './limits';
import {
  CORPORATE_SEAT_BANDS,
  PAST_DUE_GRACE_MS,
  PLAN_CATALOG,
} from './catalog';

describe('plan catalog', () => {
  it('imports the free limits instead of retyping them', () => {
    expect(PLAN_CATALOG.free.limits.maxOwnedRooms).toBe(FREE_MAX_ROOMS);
    expect(PLAN_CATALOG.free.limits.maxUsersPerRoom).toBe(FREE_MAX_USERS);
    expect(PLAN_CATALOG.free.limits.retentionDays).toBe(90);
  });

  it('defines the four plans with their billing intervals and price env names', () => {
    expect(PLAN_CATALOG.free).toEqual({
      limits: { maxOwnedRooms: FREE_MAX_ROOMS, maxUsersPerRoom: FREE_MAX_USERS, retentionDays: 90 },
      interval: null,
      priceEnv: null,
    });

    expect(PLAN_CATALOG.tutor_pro_monthly.interval).toBe('month');
    expect(PLAN_CATALOG.tutor_pro_monthly.priceEnv).toBe('STRIPE_PRICE_TUTOR_PRO_MONTHLY');
    expect(PLAN_CATALOG.tutor_pro_annual.interval).toBe('year');
    expect(PLAN_CATALOG.tutor_pro_annual.priceEnv).toBe('STRIPE_PRICE_TUTOR_PRO_ANNUAL');
    expect(PLAN_CATALOG.corporate_seat.interval).toBe('year');
    expect(PLAN_CATALOG.corporate_seat.priceEnv).toBe('STRIPE_PRICE_CORPORATE_SEAT');
  });

  it('gives paid plans the tutor-pro limits and corporate a three-seat minimum', () => {
    for (const planId of ['tutor_pro_monthly', 'tutor_pro_annual', 'corporate_seat'] as const) {
      expect(PLAN_CATALOG[planId].limits).toEqual({
        maxOwnedRooms: 20,
        maxUsersPerRoom: 10,
        retentionDays: 90,
      });
    }
    expect(PLAN_CATALOG.corporate_seat.minSeats).toBe(3);
    expect(PLAN_CATALOG.tutor_pro_monthly.minSeats).toBeUndefined();
  });

  it('documents the corporate graduated price bands', () => {
    expect(CORPORATE_SEAT_BANDS).toEqual([
      { min: 3, max: 9, gbpPerSeatMonth: 7.5 },
      { min: 10, max: 24, gbpPerSeatMonth: 6.5 },
      { min: 25, max: 99, gbpPerSeatMonth: 5.5 },
    ]);
  });

  it('grants a seven-day past-due grace window', () => {
    expect(PAST_DUE_GRACE_MS).toBe(7 * 24 * 60 * 60 * 1_000);
  });
});
