import type { GrantedPublicRole } from './collaborationGate';

export function isLocalRoomHost(
  grantRole: GrantedPublicRole | null,
  users: Array<{ peerId: string; isHost?: boolean }>,
  localPeerId: string,
): boolean {
  if (grantRole === 'creator') return true;
  return users.some((user) => user.peerId === localPeerId && Boolean(user.isHost));
}
