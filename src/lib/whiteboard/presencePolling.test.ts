import { describe, expect, it } from 'vitest';

import { shouldPollPresence } from './presencePolling';

describe('shouldPollPresence', () => {
  it('stops polling once an admitted peer has a live socket', () => {
    expect(shouldPollPresence({ isWaiting: false, socketConnected: true })).toBe(false);
  });

  it('keeps polling while the socket is down', () => {
    expect(shouldPollPresence({ isWaiting: false, socketConnected: false })).toBe(true);
  });

  it('keeps polling for a waiting peer even if a socket somehow reports connected', () => {
    // /signaling only opens once admitted, so a waiting peer has no push
    // channel. The poll is the only way they learn they were let in.
    expect(shouldPollPresence({ isWaiting: true, socketConnected: true })).toBe(true);
  });

  it('keeps polling for a waiting peer with no socket', () => {
    expect(shouldPollPresence({ isWaiting: true, socketConnected: false })).toBe(true);
  });

  it('never leaves a peer with neither channel', () => {
    // The property that matters, stated directly: for every combination, the
    // peer either has a connected socket or is polling.
    for (const isWaiting of [true, false]) {
      for (const socketConnected of [true, false]) {
        const polling = shouldPollPresence({ isWaiting, socketConnected });
        const pushed = socketConnected && !isWaiting;
        expect(polling || pushed).toBe(true);
      }
    }
  });
});
