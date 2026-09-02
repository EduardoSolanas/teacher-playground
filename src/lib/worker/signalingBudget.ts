/**
 * Signaling budget enforcement: decide whether to relay, drop, or close on breach.
 *
 * A teacher drawing quickly can briefly exceed the normal per-account message budget
 * (SIGNALING_BUDGET = 120 per 1000ms). Dropping awareness (cursor) frames is invisible
 * to the person; dropping sync frames (type 0) loses drawing deltas permanently because
 * y-websocket does not retransmit deltas over an open socket.
 *
 * This module implements "shed awareness on breach, close only on sustained abuse":
 * - Under budget: relay the frame
 * - Over budget:
 *   - Awareness frames (messageType === 1) are dropped (shed silently)
 *   - Sync frames (messageType === 0) and other non-awareness frames are NEVER shed: they are relayed
 * - At or above abuse ceiling (360 messages/window):
 *   - Close socket ONLY if abuse persists across consecutive windows (consecutiveCeilingBreaches >= 2)
 *   - A single transient spike over the ceiling still sheds awareness but does not disconnect
 */

/** Normal per-account signaling budget (messages per SIGNALING_RATE_WINDOW_MS). */
export const SIGNALING_BUDGET = 120;

/**
 * Abuse ceiling: 3x the normal budget (360 messages per 1000ms).
 *
 * 3x multiplier chosen as a clear separation from normal burst usage. Closing
 * requires sustained abuse across consecutive rate windows so that transient
 * bursts do not disrupt legitimate users.
 */
export const SIGNALING_ABUSE_CEILING = SIGNALING_BUDGET * 3;

export type SignalingAction = 'relay' | 'drop' | 'close';

export type SignalingActionInput = {
  messagesInWindow: number;
  messageType?: number | null;
  consecutiveCeilingBreaches?: number;
};

/**
 * Decide the action to take on an incoming signaling message.
 *
 * @param input - { messagesInWindow, messageType, consecutiveCeilingBreaches }
 * @returns 'relay' to send to peers, 'drop' to discard silently, 'close' to close the socket
 */
export function decideSignalingAction(input: SignalingActionInput): SignalingAction {
  const { messagesInWindow, messageType, consecutiveCeilingBreaches } = input;

  if (messagesInWindow >= SIGNALING_ABUSE_CEILING && (consecutiveCeilingBreaches ?? 1) >= 2) {
    return 'close';
  }

  if (messagesInWindow > SIGNALING_BUDGET) {
    // Only awareness frames (type 1) are sheddable. Sync frames (type 0)
    // and others must never be dropped to prevent permanent state desync.
    if (messageType === 1) {
      return 'drop';
    }
    return 'relay';
  }

  return 'relay';
}



