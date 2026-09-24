import { describe, expect, it } from 'vitest';
import { pagerPlacement } from './pagerPlacement';

/*
 * Pure geometry for the pager (spec/PAGED_DOCUMENTS_SPEC.md §6.3, "Responsive"):
 * centred under the document's bottom edge, pinned above the bottom
 * obstacles when that edge is off screen, hidden when the document is
 * entirely off screen, and always clamped inside the viewport with a 16px
 * side gutter.
 */

const VIEWPORT = { width: 1000, height: 800 };
const PAGER = { width: 200, height: 44 };

describe('pagerPlacement', () => {
  it('centres the pager under the document bottom edge when it is on screen', () => {
    const documentRect = { x: 300, y: 100, width: 400, height: 300 };
    const placement = pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles: [] });
    expect(placement).not.toBeNull();
    // centre of the document: 300 + 400/2 = 500; pager centred there.
    expect(placement!.x).toBe(500 - PAGER.width / 2);
    expect(placement!.y).toBe(100 + 300 + 8); // gap below the document's bottom edge.
    expect(placement!.width).toBe(PAGER.width);
    expect(placement!.height).toBe(PAGER.height);
  });

  it('clamps to the left gutter when the centred position would go past it', () => {
    const documentRect = { x: -350, y: 100, width: 400, height: 200 };
    const placement = pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles: [] });
    expect(placement).not.toBeNull();
    expect(placement!.x).toBe(16);
  });

  it('clamps to the right gutter when the centred position would go past it', () => {
    const documentRect = { x: 900, y: 100, width: 400, height: 200 };
    const placement = pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles: [] });
    expect(placement).not.toBeNull();
    expect(placement!.x).toBe(VIEWPORT.width - 16 - PAGER.width);
  });

  it('hides the pager when the document is entirely below the viewport', () => {
    const documentRect = { x: 100, y: 900, width: 200, height: 100 };
    expect(pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles: [] })).toBeNull();
  });

  it('hides the pager when the document is entirely above the viewport', () => {
    const documentRect = { x: 100, y: -300, width: 200, height: 100 };
    expect(pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles: [] })).toBeNull();
  });

  it('hides the pager when the document is entirely to the left of the viewport', () => {
    const documentRect = { x: -300, y: 100, width: 100, height: 100 };
    expect(pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles: [] })).toBeNull();
  });

  it('hides the pager when the document is entirely to the right of the viewport', () => {
    const documentRect = { x: 1100, y: 100, width: 100, height: 100 };
    expect(pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles: [] })).toBeNull();
  });

  it('hides the pager when the document only touches the viewport left edge (no overlap)', () => {
    const documentRect = { x: -100, y: 100, width: 100, height: 100 }; // right edge exactly at x=0
    expect(pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles: [] })).toBeNull();
  });

  it('hides the pager when the document only touches the viewport right edge (no overlap)', () => {
    const documentRect = { x: VIEWPORT.width, y: 100, width: 100, height: 100 }; // left edge exactly at viewport's right edge
    expect(pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles: [] })).toBeNull();
  });

  it('hides the pager when the document only touches the viewport bottom edge (no overlap)', () => {
    const documentRect = { x: 100, y: VIEWPORT.height, width: 100, height: 100 }; // top edge exactly at viewport's bottom edge
    expect(pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles: [] })).toBeNull();
  });

  it('hides the pager when the document only touches the viewport top edge (no overlap)', () => {
    const documentRect = { x: 100, y: -100, width: 100, height: 100 }; // bottom edge exactly at y=0
    expect(pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles: [] })).toBeNull();
  });

  it('pins above the bottom of the viewport when the document bottom edge is off screen and there are no obstacles', () => {
    const documentRect = { x: 300, y: 700, width: 400, height: 500 }; // bottom at 1200, past height 800
    const placement = pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles: [] });
    expect(placement).not.toBeNull();
    expect(placement!.y).toBe(VIEWPORT.height - 8 - PAGER.height);
  });

  it('pins above the nearest bottom obstacle that overlaps the pager horizontally', () => {
    const documentRect = { x: 300, y: 700, width: 400, height: 500 };
    const obstacles = [
      { x: 0, y: 750, width: 1000, height: 50 }, // full-width bottom bar
    ];
    const placement = pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles });
    expect(placement).not.toBeNull();
    expect(placement!.y).toBe(750 - 8 - PAGER.height);
  });

  it('ignores an obstacle that does not horizontally overlap the pager', () => {
    const documentRect = { x: 300, y: 700, width: 400, height: 500 };
    // Document centre is at x=500, so the pager sits around x=400..600.
    const obstacles = [
      { x: 800, y: 750, width: 150, height: 50 }, // off to the right, no horizontal overlap
    ];
    const placement = pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles });
    expect(placement).not.toBeNull();
    expect(placement!.y).toBe(VIEWPORT.height - 8 - PAGER.height);
  });

  it('ignores an obstacle entirely to the left of the pager, not just non-touching to the right', () => {
    const documentRect = { x: 300, y: 700, width: 400, height: 500 }; // pager x-span ends up 400..600
    const obstacles = [{ x: 0, y: 750, width: 200, height: 50 }]; // spans 0..200, well clear of 400..600
    const placement = pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles });
    expect(placement).not.toBeNull();
    expect(placement!.y).toBe(VIEWPORT.height - 8 - PAGER.height);
  });

  it('ignores an obstacle that only touches the pager\'s left edge (no horizontal overlap)', () => {
    const documentRect = { x: 300, y: 700, width: 400, height: 500 }; // pager x-span 400..600
    const obstacles = [{ x: 200, y: 750, width: 200, height: 50 }]; // spans 200..400, touching at x=400
    const placement = pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles });
    expect(placement).not.toBeNull();
    expect(placement!.y).toBe(VIEWPORT.height - 8 - PAGER.height);
  });

  it('ignores an obstacle that only touches the pager\'s right edge (no horizontal overlap)', () => {
    const documentRect = { x: 300, y: 700, width: 400, height: 500 }; // pager x-span 400..600
    const obstacles = [{ x: 600, y: 750, width: 100, height: 50 }]; // spans 600..700, touching at x=600
    const placement = pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles });
    expect(placement).not.toBeNull();
    expect(placement!.y).toBe(VIEWPORT.height - 8 - PAGER.height);
  });

  it('pins above an obstacle that only partially overlaps the pager horizontally', () => {
    const documentRect = { x: 300, y: 700, width: 400, height: 500 }; // pager x-span 400..600
    const obstacles = [{ x: 250, y: 760, width: 200, height: 50 }]; // spans 250..450, overlapping 400..450
    const placement = pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles });
    expect(placement).not.toBeNull();
    expect(placement!.y).toBe(760 - 8 - PAGER.height);
  });

  it('treats the document bottom edge exactly at the viewport bottom as on screen (natural placement, not pinned)', () => {
    const documentRect = { x: 300, y: 500, width: 400, height: 300 }; // bottom exactly at 800
    // High up and irrelevant to the natural (bottom-edge) placement -- but if
    // this edge case were wrongly classified as "off screen" it would pin
    // above this instead, landing far higher than the clamped natural spot.
    const obstacles = [{ x: 0, y: 200, width: 1000, height: 50 }];
    const placement = pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles });
    expect(placement).not.toBeNull();
    // Natural y (808) overflows the 800-tall viewport, so it is clamped to
    // the last position that still fits (800 - pager height).
    expect(placement!.y).toBe(VIEWPORT.height - PAGER.height);
  });

  it('clamps the vertical position inside the viewport when the natural position would overflow', () => {
    // A short document near the very bottom: natural y would be past the viewport.
    const documentRect = { x: 300, y: 780, width: 400, height: 15 };
    const placement = pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles: [] });
    expect(placement).not.toBeNull();
    expect(placement!.y).toBeLessThanOrEqual(VIEWPORT.height - PAGER.height);
    expect(placement!.y).toBeGreaterThanOrEqual(0);
  });

  it('ignores an obstacle that sits above the document itself, even if it horizontally overlaps the pager (a tab strip above the canvas is not a "bottom" obstacle)', () => {
    const documentRect = { x: 300, y: 700, width: 400, height: 500 }; // pager x-span 400..600, doc top at y=700
    const obstacles = [
      { x: 0, y: 60, width: 1000, height: 40 }, // above the document entirely -- e.g. the room's tab strip
    ];
    const placement = pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles });
    expect(placement).not.toBeNull();
    // Falls back to pinning above the viewport's own bottom edge, exactly as
    // if that obstacle were not given at all.
    expect(placement!.y).toBe(VIEWPORT.height - 8 - PAGER.height);
  });

  it('still pins above an obstacle whose top edge exactly matches the document\'s own top edge', () => {
    const documentRect = { x: 300, y: 700, width: 400, height: 500 }; // pager x-span 400..600, doc top at y=700
    const obstacles = [{ x: 0, y: 700, width: 1000, height: 40 }]; // top edge exactly at the document's own top
    const placement = pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles });
    expect(placement).not.toBeNull();
    expect(placement!.y).toBe(700 - 8 - PAGER.height);
  });

  it('pins above the highest (smallest y) of several overlapping obstacles, regardless of order', () => {
    const documentRect = { x: 300, y: 700, width: 400, height: 500 }; // pager x-span 400..600
    const obstacles = [
      { x: 0, y: 770, width: 1000, height: 30 },
      { x: 0, y: 730, width: 1000, height: 20 }, // higher up (smaller y) than the first
    ];
    const placement = pagerPlacement({ documentRect, viewport: VIEWPORT, pagerSize: PAGER, obstacles });
    expect(placement).not.toBeNull();
    expect(placement!.y).toBe(730 - 8 - PAGER.height);
  });

  it('uses a custom gutter and gap when given', () => {
    const documentRect = { x: 900, y: 100, width: 400, height: 200 };
    const placement = pagerPlacement({
      documentRect,
      viewport: VIEWPORT,
      pagerSize: PAGER,
      obstacles: [],
      gutter: 24,
      gap: 12,
    });
    expect(placement).not.toBeNull();
    expect(placement!.x).toBe(VIEWPORT.width - 24 - PAGER.width);
  });
});
