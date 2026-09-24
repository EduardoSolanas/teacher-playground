import { describe, expect, it } from 'vitest';
import { toolbarPlacement } from './toolbarPlacement';

/*
 * Pure geometry for the bottom toolbar island (globals.css's
 * `.App-toolbar-container` rule, regression from 90e7a6b): centred on the
 * board when it fits clear of every obstacle, shifted between the
 * obstacles when centring would not, and left for the caller to fall back
 * to Excalidraw's own native placement when nothing on the bottom row
 * clears every obstacle.
 */

const BOARD = { x: 0, width: 1000 };

describe('toolbarPlacement', () => {
  it('centres the toolbar on the board when no obstacle is in the way', () => {
    const placement = toolbarPlacement({ board: BOARD, toolbarWidth: 200, obstacles: [] });
    expect(placement).toEqual({ mode: 'center', left: 400 }); // 500 - 200/2
  });

  it('centres on a board offset from the viewport origin', () => {
    const placement = toolbarPlacement({ board: { x: 100, width: 800 }, toolbarWidth: 200, obstacles: [] });
    // board centre: 100 + 800/2 = 500; left = 500 - 100 = 400.
    expect(placement).toEqual({ mode: 'center', left: 400 });
  });

  it('shifts right, clear of a left obstacle, when centring would overlap it', () => {
    // Centred left would be 400; a left obstacle spanning [0, 450] overlaps that.
    const placement = toolbarPlacement({
      board: BOARD,
      toolbarWidth: 200,
      obstacles: [{ x: 0, width: 450 }],
      gap: 12,
    });
    expect(placement).toEqual({ mode: 'shifted', left: 462 }); // 450 + 12
  });

  it('shifts left, clear of a right obstacle, when centring would overlap it', () => {
    // Centred left would be 400 (right edge 600); a right obstacle starting at 550 overlaps that.
    const placement = toolbarPlacement({
      board: BOARD,
      toolbarWidth: 200,
      obstacles: [{ x: 550, width: 450 }],
      gap: 12,
    });
    expect(placement).toEqual({ mode: 'shifted', left: 338 }); // 550 - 12 - 200
  });

  it('stays centred when an obstacle is close but still clears the gap', () => {
    const placement = toolbarPlacement({
      board: BOARD,
      toolbarWidth: 200,
      obstacles: [{ x: 0, width: 388 }], // right edge 388; minLeft = 388+12 = 400 = centred left exactly
      gap: 12,
    });
    expect(placement).toEqual({ mode: 'center', left: 400 });
  });

  it('falls back to native placement, still centred on the board, when the toolbar cannot sit clear of both obstacles at once', () => {
    const placement = toolbarPlacement({
      board: BOARD,
      toolbarWidth: 700,
      obstacles: [{ x: 0, width: 400 }, { x: 700, width: 300 }],
      gap: 12,
    });
    // minLeft = 400+12 = 412; maxLeft = 700-12-700 = -12; 412 > -12, so native --
    // but still centred on the board itself (500 - 700/2 = 150), clamped to
    // the board's own bounds ([0, 1000-700=300]) the same as any other mode.
    expect(placement).toEqual({ mode: 'native', left: 150 });
  });

  it('classifies an obstacle by its own centre, not its edge, against the board centre', () => {
    // Obstacle spans [400, 700] -- crosses the board centre (500) but its own
    // centre (550) is past it, so it constrains the right side only.
    const placement = toolbarPlacement({
      board: BOARD,
      toolbarWidth: 100,
      obstacles: [{ x: 400, width: 300 }],
      gap: 12,
    });
    // maxLeft = 400 - 12 - 100 = 288; centred left would be 450, clamped down to 288.
    expect(placement).toEqual({ mode: 'shifted', left: 288 });
  });

  it('defaults the gap to 12 when none is given', () => {
    const placement = toolbarPlacement({
      board: BOARD,
      toolbarWidth: 200,
      obstacles: [{ x: 0, width: 450 }],
    });
    expect(placement).toEqual({ mode: 'shifted', left: 462 });
  });

  it('falls back to native when the toolbar alone is wider than the board, even with no obstacles', () => {
    const placement = toolbarPlacement({ board: BOARD, toolbarWidth: 1001, obstacles: [] });
    // Still just the centred position (500 - 1001/2); a toolbar wider than
    // the board has nowhere better to go either.
    expect(placement).toEqual({ mode: 'native', left: -0.5 });
  });

  it('treats an obstacle centred exactly on the board centre as a left obstacle', () => {
    // Obstacle [400, 600], centre 500 == board centre 500.
    const placement = toolbarPlacement({
      board: BOARD,
      toolbarWidth: 100,
      obstacles: [{ x: 400, width: 200 }],
      gap: 12,
    });
    // If it were treated as a right obstacle instead, left would be 288 (400-12-100).
    expect(placement).toEqual({ mode: 'shifted', left: 612 }); // 400+200+12
  });

  it('centres natively on a board offset from the viewport origin too', () => {
    const placement = toolbarPlacement({
      board: { x: 200, width: 500 },
      toolbarWidth: 600,
      obstacles: [],
    });
    // board centre: 200 + 250 = 450; left = 450 - 300 = 150.
    expect(placement).toEqual({ mode: 'native', left: 150 });
  });

  it('does not fall back to native when exactly one position clears both obstacles', () => {
    // Left obstacle forces minLeft to 500; right obstacle forces maxLeft to 500 too.
    const placement = toolbarPlacement({
      board: BOARD,
      toolbarWidth: 100,
      obstacles: [{ x: 0, width: 488 }, { x: 612, width: 300 }],
      gap: 12,
    });
    expect(placement).toEqual({ mode: 'shifted', left: 500 });
  });
});
