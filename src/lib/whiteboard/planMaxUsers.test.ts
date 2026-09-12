import { describe, expect, it } from 'vitest';

import { PLAN_MAX_USERS_PARAM, applyPlanMaxUsersParam } from './planMaxUsers';

function targetWithPlanParam(value?: string): URL {
  const target = new URL('https://room/room');
  if (value !== undefined) target.searchParams.set(PLAN_MAX_USERS_PARAM, value);
  return target;
}

describe('applyPlanMaxUsersParam', () => {
  it('removes a forged plan param when the server could not resolve a plan', () => {
    const target = targetWithPlanParam('999');

    applyPlanMaxUsersParam(target, null);

    expect(target.searchParams.get(PLAN_MAX_USERS_PARAM)).toBeNull();
  });

  it('replaces a forged plan param with the server-resolved value', () => {
    const target = targetWithPlanParam('999');

    applyPlanMaxUsersParam(target, 10);

    expect(target.searchParams.get(PLAN_MAX_USERS_PARAM)).toBe('10');
  });

  it('keeps the param absent when neither side supplied one', () => {
    const target = targetWithPlanParam();

    applyPlanMaxUsersParam(target, null);

    expect(target.searchParams.get(PLAN_MAX_USERS_PARAM)).toBeNull();
  });

  it('sets the server-resolved value when the client sent nothing', () => {
    const target = targetWithPlanParam();

    applyPlanMaxUsersParam(target, 5);

    expect(target.searchParams.get(PLAN_MAX_USERS_PARAM)).toBe('5');
  });

  it('removes an empty forged plan param when the server could not resolve a plan', () => {
    const target = targetWithPlanParam('');

    applyPlanMaxUsersParam(target, null);

    expect(target.searchParams.get(PLAN_MAX_USERS_PARAM)).toBeNull();
  });

  it('removes a non-numeric forged plan param when the server could not resolve a plan', () => {
    const target = targetWithPlanParam('not-a-number');

    applyPlanMaxUsersParam(target, null);

    expect(target.searchParams.get(PLAN_MAX_USERS_PARAM)).toBeNull();
  });
});
