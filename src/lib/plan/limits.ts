/**
 * Free-plan caps until paid entitlements exist (SEC-015). Every account is
 * free: one owned room, host plus one student. Do not accept a client-declared
 * plan; callers must enforce these server-side.
 */

export interface FreePlanLimits {
  maxOwnedRooms: number;
  maxUsersPerRoom: number;
  retentionDays: number;
}

export const FREE_PLAN_LIMITS: FreePlanLimits = {
  maxOwnedRooms: 1,
  maxUsersPerRoom: 2,
  retentionDays: 90,
};

export const FREE_MAX_ROOMS = FREE_PLAN_LIMITS.maxOwnedRooms;
/** Occupancy including the host. Free allows one student. */
export const FREE_MAX_USERS = FREE_PLAN_LIMITS.maxUsersPerRoom;
export const DEFAULT_MAX_USERS = FREE_MAX_USERS;
export const MIN_MAX_USERS = 1;

export const PLAN_LIMIT_STATUS = 402;
export const PLAN_LIMIT_ERROR = 'Plan limit reached';

export function canAddOwnedRoom(
  ownedCount: number,
  alreadyOwnsThisRoom: boolean,
  maxOwnedRooms: number = FREE_MAX_ROOMS,
): boolean {
  if (alreadyOwnsThisRoom) return true;
  return ownedCount < maxOwnedRooms;
}

export function maxUsersAllowedOnPlan(maxUsers: number, planMaxUsers: number): boolean {
  return Number.isInteger(maxUsers) && maxUsers >= MIN_MAX_USERS && maxUsers <= planMaxUsers;
}

export function maxUsersAllowedOnFreePlan(maxUsers: number): boolean {
  return maxUsersAllowedOnPlan(maxUsers, FREE_MAX_USERS);
}

export function planLimitJsonResponse(): Response {
  return Response.json(
    { error: PLAN_LIMIT_ERROR },
    { status: PLAN_LIMIT_STATUS, headers: { 'Cache-Control': 'no-store' } },
  );
}
