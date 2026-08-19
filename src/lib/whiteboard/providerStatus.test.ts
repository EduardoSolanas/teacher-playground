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
    expect(shouldPollRoomApiFallback({ wsconnected: true, synced: true })).toBe(false);
    expect(shouldPollRoomApiFallback({ wsconnected: true, synced: false })).toBe(true);
    expect(shouldPollRoomApiFallback({ wsconnected: false, synced: true })).toBe(true);
    expect(shouldPollRoomApiFallback({ wsconnected: false })).toBe(true);
    expect(shouldPollRoomApiFallback(undefined)).toBe(true);
  });
});
