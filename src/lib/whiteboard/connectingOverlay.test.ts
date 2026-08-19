import { describe, expect, it } from 'vitest';

import { shouldOverlayConnectingScreen } from './connectingOverlay';

describe('shouldOverlayConnectingScreen', () => {
  it('does not cover Let in / presence once the board chrome is on screen', () => {
    expect(shouldOverlayConnectingScreen({ boardEverShown: true, isSynced: false })).toBe(false);
  });

  it('covers the page before the board has appeared and sync is still down', () => {
    expect(shouldOverlayConnectingScreen({ boardEverShown: false, isSynced: false })).toBe(true);
  });
});
