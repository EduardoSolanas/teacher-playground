import { describe, it, expect } from 'vitest';
import { shouldStoreViewport } from './viewportPersist';

const view = { x: 10, y: 20, zoom: 1.5 };

describe('shouldStoreViewport', () => {
  it('stores the host view', () => {
    expect(shouldStoreViewport({ isHost: true, next: view, lastStored: null })).toBe(true);
  });

  it('does not store a view that is not the host view', () => {
    expect(shouldStoreViewport({ isHost: false, next: view, lastStored: null })).toBe(false);
  });

  it('does not repeat a view it already stored', () => {
    expect(shouldStoreViewport({ isHost: true, next: view, lastStored: { ...view } })).toBe(false);
  });

  it('stores a moved view', () => {
    expect(shouldStoreViewport({
      isHost: true,
      next: view,
      lastStored: { ...view, x: 11 },
    })).toBe(true);
  });

  it('stores a zoomed view', () => {
    expect(shouldStoreViewport({
      isHost: true,
      next: view,
      lastStored: { ...view, zoom: 2 },
    })).toBe(true);
  });
});
