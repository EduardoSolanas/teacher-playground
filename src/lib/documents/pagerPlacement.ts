/**
 * Pure positioning for the paged-document pager
 * (spec/PAGED_DOCUMENTS_SPEC.md §6.3, the "Responsive" paragraph).
 *
 * Given the document's rectangle in viewport coordinates (from Excalidraw's
 * `sceneCoordsToViewportCoords`, using the current `appState` scroll and
 * zoom), the viewport size, the pager's own measured size and the
 * rectangles to keep clear of (the toolbar, the bottom bar, the tabs, the
 * board notices), this decides where the pager goes -- kept apart from the
 * component so the geometry can be tested without a canvas or real layout.
 */
import type { Rect } from './pagedDocuments';

export type { Rect };

export type PagerPlacementInput = {
  /** The stacked document's shared rectangle, already converted to viewport coordinates. */
  documentRect: Rect;
  /** The visible viewport, top-left at (0, 0). */
  viewport: { width: number; height: number };
  /** The pager's own measured size. */
  pagerSize: { width: number; height: number };
  /** Rectangles the pager must never overlap (toolbar, bottom bar, tabs, notices), in viewport coordinates. */
  obstacles: readonly Rect[];
  /** Minimum distance from either side of the viewport. Defaults to 16. */
  gutter?: number;
  /** Gap between the pager and the document edge or an obstacle it pins above. Defaults to 8. */
  gap?: number;
};

const DEFAULT_GUTTER = 16;
const DEFAULT_GAP = 8;

/** Whether two rectangles share any area. Touching edges do not count. */
function overlaps(left: Rect, right: Rect): boolean {
  return left.x < right.x + right.width
    && right.x < left.x + left.width
    && left.y < right.y + right.height
    && right.y < left.y + left.height;
}

/** Whether two horizontal spans share any width. Touching edges do not count. */
function horizontallyOverlaps(left: { x: number; width: number }, right: { x: number; width: number }): boolean {
  return left.x < right.x + right.width && right.x < left.x + left.width;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Where the pager goes, or null when the document it belongs to is entirely
 * off screen.
 *
 * - Centred under the document's bottom edge when that edge is on screen.
 * - Pinned above the nearest obstacle that horizontally overlaps it -- or
 *   above the viewport's own bottom edge, when none do -- when the
 *   document's bottom edge is off screen.
 * - Always clamped inside the viewport with the given side gutter, both
 *   horizontally and vertically, as a last safety net.
 */
export function pagerPlacement(input: PagerPlacementInput): Rect | null {
  const { documentRect: doc, viewport, pagerSize, obstacles } = input;
  const gutter = input.gutter ?? DEFAULT_GUTTER;
  const gap = input.gap ?? DEFAULT_GAP;

  const viewportRect: Rect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  if (!overlaps(doc, viewportRect)) return null;

  const minX = gutter;
  const maxX = Math.max(gutter, viewport.width - gutter - pagerSize.width);
  const x = clamp(doc.x + doc.width / 2 - pagerSize.width / 2, minX, maxX);

  const documentBottomOnScreen = doc.y + doc.height <= viewport.height;

  let y: number;
  if (documentBottomOnScreen) {
    y = doc.y + doc.height + gap;
  } else {
    const pagerSpan = { x, width: pagerSize.width };
    let ceiling = viewport.height;
    for (const obstacle of obstacles) {
      // A "bottom" obstacle, for this document, never sits above its own
      // top edge -- a tab strip above the canvas is not a floor to pin
      // above, however wide it runs.
      if (obstacle.y < doc.y) continue;
      if (!horizontallyOverlaps(pagerSpan, obstacle)) continue;
      ceiling = Math.min(ceiling, obstacle.y);
    }
    y = ceiling - gap - pagerSize.height;
  }

  // The 16px gutter spec'd for the pager is explicitly a *side* gutter; this
  // vertical clamp is only the last-resort safety net that keeps the pager
  // from being pushed fully off the top or bottom of the viewport.
  const minY = 0;
  const maxY = Math.max(0, viewport.height - pagerSize.height);
  y = clamp(y, minY, maxY);

  return { x, y, width: pagerSize.width, height: pagerSize.height };
}
