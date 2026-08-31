import { describe, expect, it } from 'vitest';

import { shouldPollPresence } from './presencePolling';

/** A visible tab with no call, which is what the original cases assumed. */
const poll = (input: { isWaiting: boolean; socketConnected: boolean }) =>
  shouldPollPresence({ ...input, hidden: false, callLive: false });

describe('shouldPollPresence', () => {
  it('stops polling once an admitted peer has a live socket', () => {
    expect(poll({ isWaiting: false, socketConnected: true })).toBe(false);
  });

  it('keeps polling while the socket is down', () => {
    expect(poll({ isWaiting: false, socketConnected: false })).toBe(true);
  });

  it('keeps polling for a waiting peer even if a socket somehow reports connected', () => {
    // /signaling only opens once admitted, so a waiting peer has no push
    // channel. The poll is the only way they learn they were let in.
    expect(poll({ isWaiting: true, socketConnected: true })).toBe(true);
  });

  it('keeps polling for a waiting peer with no socket', () => {
    expect(poll({ isWaiting: true, socketConnected: false })).toBe(true);
  });

  it('never leaves a peer with neither channel', () => {
    // The property that matters, stated directly: for every combination, the
    // peer either has a connected socket or is polling.
    for (const isWaiting of [true, false]) {
      for (const socketConnected of [true, false]) {
        const polling = poll({ isWaiting, socketConnected });
        const pushed = socketConnected && !isWaiting;
        expect(polling || pushed).toBe(true);
      }
    }
  });

  it('goes quiet in a backgrounded tab with no call in it', () => {
    // Nobody is watching the roster and nobody is in the lesson, so the
    // heartbeat would be buying an accurate answer for an empty chair.
    expect(
      shouldPollPresence({ isWaiting: false, socketConnected: false, hidden: true, callLive: false }),
    ).toBe(false);
  });

  it('keeps beating in a hidden tab that is on a call', () => {
    // Somebody hidden is still in the room, and is being spoken to. Dropping
    // them from the roster mid-sentence is the wrong kind of thrift.
    expect(
      shouldPollPresence({ isWaiting: false, socketConnected: false, hidden: true, callLive: true }),
    ).toBe(true);
  });

  it('still hears about admission in a hidden tab', () => {
    // A student who backgrounds the waiting screen must still learn they were
    // let in; nothing else can tell them.
    expect(
      shouldPollPresence({ isWaiting: true, socketConnected: false, hidden: true, callLive: false }),
    ).toBe(true);
  });
});
