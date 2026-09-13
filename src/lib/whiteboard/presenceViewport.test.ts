import { describe, expect, it } from 'vitest';

import { shouldCollapsePresenceForViewport } from './presenceViewport';

describe('shouldCollapsePresenceForViewport', () => {
  it('stays expanded on a desktop-sized board so Let in stays visible', () => {
    expect(shouldCollapsePresenceForViewport(1280)).toBe(false);
  });

  it('collapses only on a real phone-width viewport', () => {
    expect(shouldCollapsePresenceForViewport(390)).toBe(true);
  });

  it('does not collapse when width is not yet known', () => {
    expect(shouldCollapsePresenceForViewport(0)).toBe(false);
    expect(shouldCollapsePresenceForViewport(-1)).toBe(false);
  });

  it('stays expanded at the phone-width boundary', () => {
    expect(shouldCollapsePresenceForViewport(640)).toBe(false);
    expect(shouldCollapsePresenceForViewport(639)).toBe(true);
  });
});
