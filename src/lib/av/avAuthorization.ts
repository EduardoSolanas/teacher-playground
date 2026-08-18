/**
 * A/V admission authorization.
 *
 * The video feature must only be available to participants who have been
 * admitted into the room (role `owner` or `member`). Waiting participants
 * (role `waiting` / no row yet) must be denied A/V tokens.
 */

export type RoomRole = 'owner' | 'member' | 'waiting' | 'unknown';

/** True when the account is an admitted (non-waiting) room participant. */
export function isAdmittedRole(role: unknown): boolean {
  return role === 'owner' || role === 'member';
}

export function roleFromValue(value: unknown): RoomRole {
  if (value === 'owner') return 'owner';
  if (value === 'member') return 'member';
  if (value === 'waiting') return 'waiting';
  return 'unknown';
}

export interface AvEligibility {
  readonly eligible: boolean;
  readonly reason: 'admitted' | 'waiting' | 'not-a-member' | 'unconfigured';
}

export function avEligible(role: unknown): AvEligibility {
  if (isAdmittedRole(role)) {
    return { eligible: true, reason: 'admitted' };
  }
  if (role === 'waiting') {
    return { eligible: false, reason: 'waiting' };
  }
  return { eligible: false, reason: 'not-a-member' };
}

/** The HTTP status an ineligible participant should receive. */
export function avEligibilityStatus(eligible: boolean, configured: boolean): number {
  if (!configured) return 503;
  return eligible ? 200 : 403;
}
