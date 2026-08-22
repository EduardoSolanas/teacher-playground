import { describe, expect, it } from 'vitest';

import { IDENTITY_VIEWPORT, sceneToViewport, viewportFromAppState } from './cursorViewport';

describe('sceneToViewport', () => {
  it('is the identity when nothing is scrolled, zoomed or offset', () => {
    expect(sceneToViewport({ x: 120, y: 80 }, IDENTITY_VIEWPORT)).toEqual({ x: 120, y: 80 });
  });

  it('moves a cursor with the board when the receiver scrolls', () => {
    // Panning your own board used to drag everyone else's cursor across your
    // screen, because their point never moved with it.
    const viewport = { ...IDENTITY_VIEWPORT, scrollX: -100, scrollY: -50 };

    expect(sceneToViewport({ x: 300, y: 200 }, viewport)).toEqual({ x: 200, y: 150 });
  });

  it('scales with zoom about the scroll origin', () => {
    expect(sceneToViewport({ x: 50, y: 25 }, { ...IDENTITY_VIEWPORT, zoom: 2 }))
      .toEqual({ x: 100, y: 50 });
  });

  it('adds the canvas offset, so the tool sidebar does not shift every cursor', () => {
    const viewport = { ...IDENTITY_VIEWPORT, offsetLeft: 56, offsetTop: 48 };

    expect(sceneToViewport({ x: 10, y: 10 }, viewport)).toEqual({ x: 66, y: 58 });
  });

  it('composes scroll, zoom and offset in that order', () => {
    const viewport = { scrollX: -20, scrollY: -10, zoom: 1.5, offsetLeft: 56, offsetTop: 48 };

    expect(sceneToViewport({ x: 100, y: 60 }, viewport)).toEqual({
      x: (100 - 20) * 1.5 + 56,
      y: (60 - 10) * 1.5 + 48,
    });
  });

  it('puts two differently sized windows on the same scene point', () => {
    // The whole reason for scene coordinates: one point, two viewports, and
    // each peer sees the pointer over the same part of the drawing.
    const laptop = { ...IDENTITY_VIEWPORT, offsetLeft: 56, zoom: 1 };
    const tablet = { ...IDENTITY_VIEWPORT, offsetLeft: 0, zoom: 0.5 };
    const point = { x: 400, y: 300 };

    expect(sceneToViewport(point, laptop)).toEqual({ x: 456, y: 300 });
    expect(sceneToViewport(point, tablet)).toEqual({ x: 200, y: 150 });
  });
});

describe('viewportFromAppState', () => {
  it('reads a real appState', () => {
    expect(viewportFromAppState({
      scrollX: -10, scrollY: -20, zoom: { value: 1.25 }, offsetLeft: 56, offsetTop: 48,
    })).toEqual({ scrollX: -10, scrollY: -20, zoom: 1.25, offsetLeft: 56, offsetTop: 48 });
  });

  it('never yields a zoom of zero, which would collapse every cursor to the origin', () => {
    expect(viewportFromAppState({ zoom: { value: 0 } }).zoom).toBe(1);
    expect(viewportFromAppState({ zoom: {} }).zoom).toBe(1);
  });

  it('falls back to the identity for a missing or malformed state', () => {
    expect(viewportFromAppState(undefined)).toEqual(IDENTITY_VIEWPORT);
    expect(viewportFromAppState({ scrollX: 'left', zoom: { value: NaN } })).toEqual(IDENTITY_VIEWPORT);
  });
});
