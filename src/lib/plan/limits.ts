/**
 * Free-plan caps until paid entitlements exist (SEC-015). Every account is
 * free: one owned room, host plus one student. Do not accept a client-declared
 * plan; callers must enforce these server-side.
 */

export const FREE_MAX_ROOMS = 1;
/** Occupancy including the host. Free allows one student. */
export const FREE_MAX_USERS = 2;
export const DEFAULT_MAX_USERS = FREE_MAX_USERS;
export const MIN_MAX_USERS = 1;

export const PLAN_LIMIT_STATUS = 402;
export const PLAN_LIMIT_ERROR = 'Plan limit reached';

export function canAddOwnedRoom(ownedCount: number, alreadyOwnsThisRoom: boolean): boolean {
  if (alreadyOwnsThisRoom) return true;
  return ownedCount < FREE_MAX_ROOMS;
}

export function maxUsersAllowedOnFreePlan(maxUsers: number): boolean {
  return Number.isInteger(maxUsers) && maxUsers >= MIN_MAX_USERS && maxUsers <= FREE_MAX_USERS;
}

export function planLimitJsonResponse(): Response {
  return Response.json(
    { error: PLAN_LIMIT_ERROR },
    { status: PLAN_LIMIT_STATUS, headers: { 'Cache-Control': 'no-store' } },
  );
}
