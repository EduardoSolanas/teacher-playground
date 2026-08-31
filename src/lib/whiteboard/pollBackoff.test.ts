import { describe, expect, it } from 'vitest';

import { ACTIVE_WINDOW_MS } from './presence';
import {
  POLL_BASE_MS,
  POLL_GIVE_UP_MS,
  PRESENCE_POLL_MAX_MS,
  ROOM_POLL_MAX_MS,
  hasGivenUp,
  nextPollDelay,
} from './pollBackoff';

const quiet = (current: number, maxMs = ROOM_POLL_MAX_MS) =>
  nextPollDelay({ current, changed: false, hidden: false, maxMs });

describe('nextPollDelay', () => {
  it('doubles while the room stays quiet, up to the cap', () => {
    expect(quiet(POLL_BASE_MS)).toBe(4_000);
    expect(quiet(4_000)).toBe(8_000);
    expect(quiet(8_000)).toBe(16_000);
    expect(quiet(16_000)).toBe(ROOM_POLL_MAX_MS);
    expect(quiet(ROOM_POLL_MAX_MS)).toBe(ROOM_POLL_MAX_MS);
  });

  it('drops straight back to base the moment something happens', () => {
    // Backing off gradually after a change would make the second edit of a
    // lesson slower to arrive than the first, which is the wrong way round.
    expect(
      nextPollDelay({ current: ROOM_POLL_MAX_MS, changed: true, hidden: false, maxMs: ROOM_POLL_MAX_MS }),
    ).toBe(POLL_BASE_MS);
  });

  it('asks as rarely as it may in a tab nobody is looking at', () => {
    // Even a busy room: there is nobody there to see the answer. Browsers
    // throttle background timers themselves, but a tab holding a live call is
    // exempt from that -- which is exactly the tab left open all night.
    expect(
      nextPollDelay({ current: POLL_BASE_MS, changed: true, hidden: true, maxMs: ROOM_POLL_MAX_MS }),
    ).toBe(ROOM_POLL_MAX_MS);
  });

  it('keeps the presence heartbeat inside the window that sweeps it', () => {
    /*
     * A peer reporting less often than ACTIVE_WINDOW_MS sweeps itself out of
     * its own room. Fitting twice over leaves room for one lost request before
     * a present peer is counted as gone -- so these two constants cannot be
     * changed independently, and this is what says so.
     */
    expect(PRESENCE_POLL_MAX_MS * 2).toBeLessThanOrEqual(ACTIVE_WINDOW_MS);
    expect(quiet(PRESENCE_POLL_MAX_MS, PRESENCE_POLL_MAX_MS)).toBe(PRESENCE_POLL_MAX_MS);
  });
});

describe('hasGivenUp', () => {
  const now = 1_000_000;

  it('never gives up while the socket is up', () => {
    expect(hasGivenUp({ disconnectedSince: null, now })).toBe(false);
  });

  it('holds on through the outages that actually happen', () => {
    // y-websocket reconnects on its own; a real drop is seconds, and the
    // fallbacks exist precisely to cover it.
    expect(hasGivenUp({ disconnectedSince: now - 5_000, now })).toBe(false);
    expect(hasGivenUp({ disconnectedSince: now - (POLL_GIVE_UP_MS - 1), now })).toBe(false);
  });

  it('gives up on a socket that has had five minutes to come back', () => {
    // Past here it is not an outage, it is a broken session -- and one that
    // would otherwise poll for as long as the tab stayed open, telling nobody.
    expect(hasGivenUp({ disconnectedSince: now - POLL_GIVE_UP_MS, now })).toBe(true);
    expect(hasGivenUp({ disconnectedSince: now - 60 * 60_000, now })).toBe(true);
  });
});
