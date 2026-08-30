import { describe, expect, it } from 'vitest';

import { PANEL_EDGE_MARGIN, clampPanelPosition } from './panelPosition';

const viewport = { viewportWidth: 1000, viewportHeight: 800 };
const panel = { width: 400, height: 300 };

describe('clampPanelPosition', () => {
  it('leaves a position that is already on screen alone', () => {
    expect(clampPanelPosition({ x: 120, y: 90, ...panel, ...viewport })).toEqual({ x: 120, y: 90 });
  });

  it('pulls a panel back from the left and top edges', () => {
    expect(clampPanelPosition({ x: -500, y: -40, ...panel, ...viewport })).toEqual({
      x: PANEL_EDGE_MARGIN,
      y: PANEL_EDGE_MARGIN,
    });
  });

  it('pulls a panel back from the right and bottom edges', () => {
    // Dropped past the corner, the whole panel must still be on screen --
    // otherwise the handle goes with it and there is no dragging it back.
    expect(clampPanelPosition({ x: 5000, y: 5000, ...panel, ...viewport })).toEqual({
      x: 1000 - 400 - PANEL_EDGE_MARGIN,
      y: 800 - 300 - PANEL_EDGE_MARGIN,
    });
  });

  it('pins a panel bigger than the screen to the near edge', () => {
    // The far edge cannot be honoured and the near one carries the handle.
    expect(
      clampPanelPosition({ x: 300, y: 300, width: 2000, height: 2000, ...viewport }),
    ).toEqual({ x: PANEL_EDGE_MARGIN, y: PANEL_EDGE_MARGIN });
  });

  it('honours a margin of its own', () => {
    expect(clampPanelPosition({ x: -50, y: -50, ...panel, ...viewport, margin: 24 })).toEqual({
      x: 24,
      y: 24,
    });
  });
});
