export type PeerCallEntryAction = 'leave-call' | 'stay-out' | 'open-pre-join' | 'none';

export function peerCallEntryAction(input: {
  callActive: boolean;
  avAllowed: boolean;
  answeredPreJoin: boolean;
}): PeerCallEntryAction {
  if (!input.callActive) return 'leave-call';
  if (input.answeredPreJoin) {
    // A peer who declined must not be force-re-opened while the call stays
    // active; the explicit "Rejoin call" button is the way back in.
    return 'stay-out';
  }
  if (input.avAllowed && input.callActive) return 'open-pre-join';
  return 'none';
}

export function shouldResetPreJoinAnswered(
  previousCallActive: boolean,
  currentCallActive: boolean,
): boolean {
  return previousCallActive && !currentCallActive;
}
