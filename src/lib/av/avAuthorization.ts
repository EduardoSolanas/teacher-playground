/**
 * A/V admission authorization.
 *
 * The video feature must only be available to participants who have been
 * admitted into the room (owner / editor / viewer). Pending, banned, and
 * unknown accounts must be denied A/V tokens. `member` is kept as an alias
 * for editor-equivalent admission from older grant rows.
 */

export type RoomRole = 'owner' | 'editor' | 'viewer' | 'member' | 'pending' | 'waiting' | 'unknown';

/** True when the account is an admitted (non-waiting) room participant. */
export function isAdmittedRole(role: unknown): boolean {
  return role === 'owner' || role === 'editor' || role === 'viewer' || role === 'member';
}

export function roleFromValue(value: unknown): RoomRole {
  if (value === 'owner') return 'owner';
  if (value === 'editor' || value === 'member') return value;
  if (value === 'viewer') return 'viewer';
  if (value === 'pending' || value === 'waiting') return value;
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
  if (role === 'waiting' || role === 'pending') {
    return { eligible: false, reason: 'waiting' };
  }
  if (role === 'banned') {
    return { eligible: false, reason: 'not-a-member' };
  }
  return { eligible: false, reason: 'not-a-member' };
}

/** The HTTP status an ineligible participant should receive. */
export function avEligibilityStatus(eligible: boolean, configured: boolean): number {
  if (!configured) return 503;
  return eligible ? 200 : 403;
}
