/**
 * Pure positioning for Excalidraw's bottom toolbar island
 * (globals.css's `.App-toolbar-container` rule, from 90e7a6b).
 *
 * The toolbar is fixed to the bottom of the board and, on a wide enough
 * screen, centred within it. But the board's bottom-left corner is not
 * empty: the room's own footer (zoom, undo, and -- for the owner -- Guide
 * class / Clear board) lives there too, and the right side reserves a
 * strip for the support button. A toolbar simply centred on the board can
 * drift into either one once the board narrows (the people panel docking,
 * a smaller window) while the other stays put.
 *
 * This decides, from measured rectangles alone, where the toolbar's left
 * edge goes: centred when it fits, shifted between the obstacles when
 * centring would not, or left for the caller to fall back to Excalidraw's
 * own native (top-of-board) placement when even a shifted toolbar does not
 * fit on the bottom row at all. Kept apart from the component so the
 * geometry can be tested without a canvas or real layout, the same way
 * `pagerPlacement` is (src/lib/documents/pagerPlacement.ts).
 */

export type ToolbarPlacementInput = {
  /** The board area the toolbar centres within, in viewport coordinates. */
  board: { x: number; width: number };
  /** The toolbar's own measured width. */
  toolbarWidth: number;
  /**
   * Rectangles the toolbar must never overlap -- the room's footer row,
   * the support button's reserved strip, and so on -- as horizontal spans
   * in viewport coordinates. Only x/width matter: every obstacle here
   * shares the toolbar's own bottom row.
   */
  obstacles: readonly { x: number; width: number }[];
  /** Minimum horizontal clearance kept between the toolbar and an obstacle. Defaults to 12. */
  gap?: number;
};

export type ToolbarPlacement = { mode: 'center' | 'shifted' | 'native'; left: number };

const DEFAULT_GAP = 12;

/**
 * Where the toolbar goes: centred on the board, shifted to clear an
 * obstacle, or -- when no position on the bottom row clears every obstacle
 * at once -- `native`, still centred on the board, but left for the
 * caller to anchor at the *top* of the board instead of the bottom, where
 * this geometry does not apply (the room's furniture only ever sits at
 * the bottom).
 *
 * Every obstacle is classified by which side of the board's centre it sits
 * on -- its own centre, not its edge, so an obstacle straddling the centre
 * still constrains the side it mostly occupies -- and narrows the toolbar's
 * allowed span from that side only. An obstacle already past the board's
 * own centre is impossible here in practice (the room's furniture keeps to
 * the edges) but is handled the same way regardless.
 */
export function toolbarPlacement(input: ToolbarPlacementInput): ToolbarPlacement {
  const { board, toolbarWidth, obstacles } = input;
  const gap = input.gap ?? DEFAULT_GAP;
  const boardCenter = board.x + board.width / 2;
  const centeredLeft = boardCenter - toolbarWidth / 2;

  let minLeft = board.x;
  let maxLeft = board.x + board.width - toolbarWidth;

  for (const obstacle of obstacles) {
    const obstacleCenter = obstacle.x + obstacle.width / 2;
    if (obstacleCenter <= boardCenter) {
      minLeft = Math.max(minLeft, obstacle.x + obstacle.width + gap);
    } else {
      maxLeft = Math.min(maxLeft, obstacle.x - gap - toolbarWidth);
    }
  }

  if (minLeft > maxLeft) {
    // No clamp needed here, unlike the shifted case below: `centeredLeft`
    // is exactly the midpoint of `board.x` and `board.x + board.width -
    // toolbarWidth` (boardCenter - toolbarWidth/2 is their average by
    // construction), so it always already lies between them -- inside the
    // board's own bounds -- whichever of the two is smaller.
    return { mode: 'native', left: centeredLeft };
  }

  const left = Math.min(Math.max(centeredLeft, minLeft), maxLeft);
  return { mode: left === centeredLeft ? 'center' : 'shifted', left };
}
