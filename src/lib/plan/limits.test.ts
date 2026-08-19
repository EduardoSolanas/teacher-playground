import { describe, expect, it } from 'vitest';
import {
  FREE_MAX_ROOMS,
  FREE_MAX_USERS,
  DEFAULT_MAX_USERS,
  PLAN_LIMIT_ERROR,
  PLAN_LIMIT_STATUS,
  canAddOwnedRoom,
  maxUsersAllowedOnFreePlan,
} from './limits';

describe('free plan limits', () => {
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

  it('uses a distinct over-plan status that does not name the tier', () => {
    expect(PLAN_LIMIT_STATUS).toBe(402);
    expect(PLAN_LIMIT_ERROR).toBe('Plan limit reached');
    expect(PLAN_LIMIT_ERROR.toLowerCase()).not.toContain('free');
  });
});
