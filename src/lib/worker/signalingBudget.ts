/**
 * Signaling budget enforcement: decide whether to relay, drop, or close on breach.
 *
 * A teacher drawing quickly can briefly exceed the per-account message budget
 * (SIGNALING_MAX_MESSAGES_PER_WINDOW, 60 per 1000ms). Dropping a frame is invisible
 * to the person; closing the socket interrupts the lesson mid-draw.
 *
 * This module implements "shed on breach, close only on sustained abuse":
 * - Under budget: relay the frame
 * - Over budget but under the abuse ceiling: drop the frame silently (shed)
 * - At or above the abuse ceiling: close the socket (sustained abuse)
 */

/** Normal per-account signaling budget (messages per SIGNALING_RATE_WINDOW_MS). */
export const SIGNALING_BUDGET = 60;

/**
 * Abuse ceiling: 3x the normal budget.
 *
 * A person drawing continuously (not possible) would send ~1 frame per keystroke
 * or pointer event, roughly 10-20 per second. At 60 per second budget, a teacher
 * drawing quickly (60-100 strokes/sec) would briefly exceed the budget but stay
 * well under 180. A client genuinely sending 180+ messages/sec in a 1s window is
 * not a person drawing; it is either a bug or an automated attack. Closing is
 * the right response at that point.
 *
 * 3x multiplier chosen as a clear separation from normal usage (it is 3x, not
 * some arbitrary number) and as a proven safe margin in interactive applications
 * where periodic bursts are normal.
 */
export const SIGNALING_ABUSE_CEILING = SIGNALING_BUDGET * 3;

export type SignalingAction = 'relay' | 'drop' | 'close';

/**
 * Decide the action to take on an incoming signaling message.
 *
 * @param input - { messagesInWindow: number of messages in the current rate window }
 * @returns 'relay' to send to peers, 'drop' to discard silently, 'close' to close the socket
 */
export function decideSignalingAction(input: { messagesInWindow: number }): SignalingAction {
  const { messagesInWindow } = input;

  if (messagesInWindow <= SIGNALING_BUDGET) {
    return 'relay';
  }

  if (messagesInWindow < SIGNALING_ABUSE_CEILING) {
    return 'drop';
  }

  return 'close';
}
