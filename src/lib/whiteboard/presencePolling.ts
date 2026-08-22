/**
 * Whether a peer still needs the presence poll.
 *
 * The room pushes presence over the signaling socket, so an admitted peer with
 * a live socket does not need to ask every two seconds. Two cases still do:
 *
 * - A peer in the waiting room has no socket at all. `/signaling` only opens
 *   once they are admitted, so the poll is their only way to learn they were
 *   let in. Take it away and they sit on the waiting screen indefinitely.
 * - Anyone whose socket is not currently connected.
 *
 * Written so the answer is "poll" unless there is positive evidence of a
 * working push channel. The failure that matters is a peer with neither
 * channel, which is silent and looks like a frozen room; an unnecessary poll
 * is merely wasteful.
 */
export function shouldPollPresence(input: {
  isWaiting: boolean;
  socketConnected: boolean;
}): boolean {
  if (input.isWaiting) return true;
  return !input.socketConnected;
}
