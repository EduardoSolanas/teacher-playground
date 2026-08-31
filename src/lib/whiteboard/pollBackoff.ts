import { ACTIVE_WINDOW_MS } from './presence';

/**
 * How long to wait before asking the room again.
 *
 * Both of the room's fallback loops ran at a flat two seconds, which is 43,200
 * requests a day each, per tab, whether or not anything was happening. Two
 * tabs left open overnight is the whole of a Workers free day spent on asking
 * an idle room whether it had changed yet.
 *
 * So a quiet room is asked less and less often, and anything actually
 * happening drops it straight back to two seconds. The socket is the real
 * channel; these are only what stands in when it is not there.
 */

export const POLL_BASE_MS = 2_000;

/** Board state has no deadline: nothing expires while nobody asks. */
export const ROOM_POLL_MAX_MS = 30_000;

/**
 * Presence does have one, and it is short.
 *
 * A peer whose last_seen falls outside `ACTIVE_WINDOW_MS` is swept out of the
 * roster, so this heartbeat cannot back off the way the board poll can -- it
 * has to fit twice inside that window, leaving room for one lost request
 * before a present peer is treated as gone.
 */
export const PRESENCE_POLL_MAX_MS = Math.floor(ACTIVE_WINDOW_MS / 2);

export interface NextPollDelayInput {
  readonly current: number;
  /** Whether the last poll found anything worth having asked for. */
  readonly changed: boolean;
  readonly hidden: boolean;
  readonly maxMs: number;
}

export function nextPollDelay(input: NextPollDelayInput): number {
  // A tab nobody is looking at is asked as rarely as its deadline allows,
  // however busy the room is: there is no one there to see the answer.
  if (input.hidden) return input.maxMs;
  if (input.changed) return POLL_BASE_MS;
  return Math.min(input.current * 2, input.maxMs);
}
