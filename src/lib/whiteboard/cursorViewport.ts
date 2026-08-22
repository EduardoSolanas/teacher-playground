/**
 * Where a peer's pointer belongs on this screen.
 *
 * Cursors used to travel as the sender's viewport pixels and were drawn as the
 * receiver's viewport pixels, which is only correct when both people have the
 * same window size, the same scroll and the same zoom. A teacher on a laptop
 * and a child on a tablet saw each other pointing somewhere else entirely, and
 * panning your own board moved everyone else's cursor across your screen.
 *
 * Scene coordinates are the only frame both peers share, so that is what goes
 * over the wire; each receiver converts into its own viewport on the way out.
 */

export type CanvasViewport = {
  /** Excalidraw appState.scrollX / scrollY, in scene units. */
  scrollX: number;
  scrollY: number;
  /** appState.zoom.value. */
  zoom: number;
  /** Where the canvas sits in the page, from appState.offsetLeft / offsetTop. */
  offsetLeft: number;
  offsetTop: number;
};

export type ScenePoint = { x: number; y: number };

export const IDENTITY_VIEWPORT: CanvasViewport = {
  scrollX: 0,
  scrollY: 0,
  zoom: 1,
  offsetLeft: 0,
  offsetTop: 0,
};

function usable(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Read a viewport out of an Excalidraw appState, tolerating a partial one. */
export function viewportFromAppState(appState: unknown): CanvasViewport {
  const state = (appState ?? {}) as Record<string, unknown>;
  const zoom = (state.zoom ?? {}) as { value?: unknown };
  return {
    scrollX: usable(state.scrollX, 0),
    scrollY: usable(state.scrollY, 0),
    // A zoom of 0 would collapse every cursor onto the canvas origin.
    zoom: usable(zoom.value, 1) || 1,
    offsetLeft: usable(state.offsetLeft, 0),
    offsetTop: usable(state.offsetTop, 0),
  };
}

/** Convert a scene point into this viewport's page coordinates. */
export function sceneToViewport(point: ScenePoint, viewport: CanvasViewport): ScenePoint {
  return {
    x: (point.x + viewport.scrollX) * viewport.zoom + viewport.offsetLeft,
    y: (point.y + viewport.scrollY) * viewport.zoom + viewport.offsetTop,
  };
}
