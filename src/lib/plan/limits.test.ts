import { describe, expect, it } from 'vitest';
import { PLAN_CATALOG } from './catalog';
import {
  FREE_PLAN_LIMITS,
  FREE_MAX_ROOMS,
  FREE_MAX_USERS,
  DEFAULT_MAX_USERS,
  PLAN_LIMIT_ERROR,
  PLAN_LIMIT_STATUS,
  canAddOwnedRoom,
  maxUsersAllowedOnFreePlan,
  maxUsersAllowedOnPlan,
  planLimitJsonResponse,
} from './limits';

describe('free plan limits', () => {
  it('shares one free-limits object with the plan catalog', () => {
    expect(PLAN_CATALOG.free.limits).toBe(FREE_PLAN_LIMITS);
    expect(FREE_MAX_ROOMS).toBe(FREE_PLAN_LIMITS.maxOwnedRooms);
    expect(FREE_MAX_USERS).toBe(FREE_PLAN_LIMITS.maxUsersPerRoom);
    expect(DEFAULT_MAX_USERS).toBe(FREE_PLAN_LIMITS.maxUsersPerRoom);
  });

  it('defaults a new room to host plus one student', () => {
    expect(FREE_MAX_USERS).toBe(2);
    expect(DEFAULT_MAX_USERS).toBe(2);
    expect(FREE_MAX_ROOMS).toBe(1);
  });

  it('allows the first owned room and upserts of that same room', () => {
    expect(canAddOwnedRoom(0, false)).toBe(true);
    expect(canAddOwnedRoom(1, true)).toBe(true);
  });

  it('rejects a second distinct owned room', () => {
    expect(canAddOwnedRoom(1, false)).toBe(false);
    expect(canAddOwnedRoom(2, false)).toBe(false);
  });

  it('allows host-only and host-plus-one occupancy, not a second student', () => {
    expect(maxUsersAllowedOnFreePlan(1)).toBe(true);
    expect(maxUsersAllowedOnFreePlan(2)).toBe(true);
    expect(maxUsersAllowedOnFreePlan(3)).toBe(false);
    expect(maxUsersAllowedOnFreePlan(10)).toBe(false);
  });

  it('rejects a fractional, zero, or negative user cap', () => {
    expect(maxUsersAllowedOnPlan(1.5, 2)).toBe(false);
    expect(maxUsersAllowedOnPlan(0, 2)).toBe(false);
    expect(maxUsersAllowedOnPlan(-1, 2)).toBe(false);
    expect(maxUsersAllowedOnPlan(2, 2)).toBe(true);
  });

  it('uses a distinct over-plan status that does not name the tier', () => {
    expect(PLAN_LIMIT_STATUS).toBe(402);
    expect(PLAN_LIMIT_ERROR).toBe('Plan limit reached');
    expect(PLAN_LIMIT_ERROR.toLowerCase()).not.toContain('free');
  });

  it('answers an over-plan request with a non-cacheable 402 body', async () => {
    const response = planLimitJsonResponse();

    expect(response.status).toBe(PLAN_LIMIT_STATUS);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: PLAN_LIMIT_ERROR });
  });
});
