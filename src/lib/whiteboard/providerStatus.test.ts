import { describe, expect, it } from 'vitest';
import { isYjsProviderConnected, shouldPollRoomApiFallback } from './providerStatus';

describe('providerStatus', () => {
  it('treats y-websocket wsconnected as the live link', () => {
    expect(isYjsProviderConnected({ wsconnected: true })).toBe(true);
    expect(isYjsProviderConnected({ connected: true })).toBe(true);
    expect(isYjsProviderConnected({ wsconnected: false, connected: false })).toBe(false);
    expect(isYjsProviderConnected(null)).toBe(false);
  });

  it('polls whenever the live document is down or has not synced', () => {
    expect(shouldPollRoomApiFallback({ wsconnected: true, synced: true }, true)).toBe(false);
    expect(shouldPollRoomApiFallback({ wsconnected: true, synced: false }, true)).toBe(true);
    expect(shouldPollRoomApiFallback({ wsconnected: false, synced: true }, true)).toBe(true);
    expect(shouldPollRoomApiFallback({ wsconnected: false }, true)).toBe(true);
    expect(shouldPollRoomApiFallback(undefined, true)).toBe(true);
  });

  it('does not poll a board the room has not granted', () => {
    // 401 before a session exists, 403 while still in the waiting room. Neither
    // is something the catch-up can act on, however broken the live link is.
    expect(shouldPollRoomApiFallback(undefined, false)).toBe(false);
    expect(shouldPollRoomApiFallback({ wsconnected: false }, false)).toBe(false);
    expect(shouldPollRoomApiFallback({ wsconnected: true, synced: false }, false)).toBe(false);
  });
});
