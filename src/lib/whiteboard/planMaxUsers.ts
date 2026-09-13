export const PLAN_MAX_USERS_PARAM = 'planMaxUsers';

export function applyPlanMaxUsersParam(target: URL, planMaxUsers: number | null): void {
  target.searchParams.delete(PLAN_MAX_USERS_PARAM);
  if (planMaxUsers !== null) {
    target.searchParams.set(PLAN_MAX_USERS_PARAM, String(planMaxUsers));
  }
}
