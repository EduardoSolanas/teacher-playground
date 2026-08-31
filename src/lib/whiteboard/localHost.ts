import type { GrantedPublicRole } from './collaborationGate';

export function isLocalRoomHost(
  grantRole: GrantedPublicRole | null,
  users: Array<{ peerId: string; isHost?: boolean }>,
  localPeerId: string,
): boolean {
  if (grantRole === 'creator') return true;
  return users.some((user) => user.peerId === localPeerId && Boolean(user.isHost));
}

/**
 * Whether this peer is the account the room belongs to.
 *
 * Not the same question as `isLocalRoomHost`, and the difference matters for
 * anything the server checks. With `allow_first_user_host` on and the owner
 * away, the first peer in the roster is flagged host -- deliberately, so a
 * lesson is not stuck without one -- but the server grants nothing on that
 * basis. A control gated on being host that is refused for not being owner is
 * a button that appears only in order to fail.
 */
export function isRoomOwner(grantRole: GrantedPublicRole | null): boolean {
  return grantRole === 'creator';
}
