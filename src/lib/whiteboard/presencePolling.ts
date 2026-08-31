/**
 * Whether a peer still needs the presence poll.
 *
 * The poll is not a fallback for receiving the roster. It is the heartbeat
 * that puts the peer *in* it: `POST /presence` is the only writer of
 * `last_seen`, and the roster every peer sees is built from rows inside the
 * active window. Nothing on the socket path touches that column.
 *
 * This once stopped on a live socket, on the reasoning that the room pushes
 * presence over the wire so the poll was redundant. That reasoning covered
 * only the receiving half. A peer that stops posting stops being present:
 * within the window it is filtered out of the payload, and the next time
 * anybody joins or leaves -- which is what triggers a broadcast -- every
 * roster in the room collapses to whoever posted last. The mistake stayed
 * hidden because the connectivity test beside it never returned true.
 *
 * So a socket earns no rest here. Only two things do:
 *
 * - A backgrounded tab with no call in it. Nobody is watching the roster and
 *   nobody is in the lesson, so the heartbeat buys an accurate answer for an
 *   empty chair. Dropping out of the roster is the intended outcome.
 * - Nothing else.
 *
 * A tab holding a live call keeps beating however hidden it is: somebody
 * hidden is still in the room and is being spoken to. A peer still waiting to
 * be admitted keeps beating too -- /signaling does not open until they are in,
 * so this poll is the only way they hear about it.
 */
export function shouldPollPresence(input: {
  isWaiting: boolean;
  hidden: boolean;
  callLive: boolean;
}): boolean {
  if (input.isWaiting) return true;
  if (input.hidden && !input.callLive) return false;
  return true;
}
