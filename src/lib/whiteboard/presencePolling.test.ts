import { describe, expect, it } from 'vitest';

import { shouldPollPresence } from './presencePolling';

describe('shouldPollPresence', () => {
  it('keeps beating even with a live socket', () => {
    /*
     * The poll is the heartbeat, not a fallback: `POST /presence` is the only
     * writer of `last_seen`, and the roster is built from rows inside the
     * active window. A connected peer that stops posting stops being present,
     * and the next join or leave collapses every roster in the room.
     */
    expect(shouldPollPresence({ isWaiting: false, hidden: false, callLive: false })).toBe(true);
    expect(shouldPollPresence({ isWaiting: false, hidden: false, callLive: true })).toBe(true);
  });

  it('goes quiet only in a backgrounded tab with no call in it', () => {
    // Nobody watching the roster, nobody in the lesson. Dropping out of the
    // roster is the point, not a side effect.
    expect(shouldPollPresence({ isWaiting: false, hidden: true, callLive: false })).toBe(false);
  });

  it('keeps beating in a hidden tab that is on a call', () => {
    // Somebody hidden is still in the room, and is being spoken to. Dropping
    // them mid-sentence is the wrong kind of thrift.
    expect(shouldPollPresence({ isWaiting: false, hidden: true, callLive: true })).toBe(true);
  });

  it('still hears about admission in a hidden tab', () => {
    // /signaling only opens once admitted, so nothing else can tell them.
    expect(shouldPollPresence({ isWaiting: true, hidden: true, callLive: false })).toBe(true);
  });

  it('never leaves a peer present in the roster but silent', () => {
    // The property that matters, stated directly: any peer that is not polling
    // must be one that is meant to fall out of the roster.
    for (const isWaiting of [true, false]) {
      for (const hidden of [true, false]) {
        for (const callLive of [true, false]) {
          const polling = shouldPollPresence({ isWaiting, hidden, callLive });
          const meantToDropOut = hidden && !callLive && !isWaiting;
          expect(polling || meantToDropOut).toBe(true);
        }
      }
    }
  });
});
