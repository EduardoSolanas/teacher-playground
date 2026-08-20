export const RAISED_HAND_CUE_MS = 2800;

export type RaisedHandPresence = {
  peerId: string;
  userName?: string;
  handRaised?: boolean;
  isWaiting?: boolean;
};

export function raisedPeerIds(
  users: readonly RaisedHandPresence[],
  localPeerId: string,
): Set<string> {
  const raised = new Set<string>();
  for (const user of users) {
    if (user.handRaised && !user.isWaiting && user.peerId !== localPeerId) {
      raised.add(user.peerId);
    }
  }
  return raised;
}

/** Rising-edge peer ids whose hand just went up. */
export function newlyRaisedPeerIds(
  previous: ReadonlySet<string>,
  users: readonly RaisedHandPresence[],
  localPeerId: string,
): string[] {
  const current = raisedPeerIds(users, localPeerId);
  const added: string[] = [];
  for (const peerId of current) {
    if (!previous.has(peerId)) added.push(peerId);
  }
  return added;
}
