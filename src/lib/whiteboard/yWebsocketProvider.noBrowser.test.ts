// @vitest-environment node
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { createYWebsocketProvider, destroyProvider } from './yWebsocketProvider';

/*
 * The senders guard on `window` because a WebSocket only exists in a browser.
 * In node the factory hands back the server stand-in, and both senders must
 * refuse rather than reach for a socket that cannot exist. Running that
 * refusal where `window` genuinely is undefined is what makes the guard
 * observable: remove it and these calls throw.
 */
describe('provider senders without a browser environment', () => {
  it('both senders refuse where there is no window', () => {
    const entry = createYWebsocketProvider(new Y.Doc(), 'no-browser-send');
    const follow = { active: true as const, viewport: { x: 1, y: 2, zoom: 3 } };
    const call = { active: true as const, hostAccountId: 'acc-1', startedAt: 1 };
    const page = { importId: '0123456789abcdef', index: 0 };

    expect(entry.sendFollowMessage(follow)).toBe(false);
    expect(entry.sendCallMessage(call)).toBe(false);
    expect(entry.sendPageMessage(page)).toBe(false);

    destroyProvider('no-browser-send');
  });
});
