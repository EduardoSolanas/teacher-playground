/**
 * Where the call panel is allowed to sit.
 *
 * Dragging is the easy half; keeping the thing reachable afterwards is the
 * half worth writing down. A panel dropped past the edge of the screen cannot
 * be dragged back, because the handle you would grab went with it -- so every
 * move is clamped, and the clamp is here rather than in the component so it
 * can be reasoned about without a browser.
 */

export interface PanelPoint {
  readonly x: number;
  readonly y: number;
}

export interface ClampPanelInput {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** Breathing room kept between the panel and each edge. */
  readonly margin?: number;
}

export const PANEL_EDGE_MARGIN = 8;

function clampAxis(value: number, size: number, viewport: number, margin: number): number {
  const max = viewport - size - margin;
  // A panel taller or wider than the screen has no valid range: pin it to the
  // near edge, which is the one with the handle on it.
  if (max <= margin) return margin;
  return Math.min(Math.max(value, margin), max);
}

/** Nearest position to the one asked for that keeps the whole panel on screen. */
export function clampPanelPosition(input: ClampPanelInput): PanelPoint {
  const margin = input.margin ?? PANEL_EDGE_MARGIN;
  return {
    x: clampAxis(input.x, input.width, input.viewportWidth, margin),
    y: clampAxis(input.y, input.height, input.viewportHeight, margin),
  };
}
