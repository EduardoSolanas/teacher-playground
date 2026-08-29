/**
 * How often a stroke in progress is published.
 *
 * Every publish sends the whole point array again, because a point array is
 * one value in the shared document and Yjs replaces it wholesale. So the cost
 * of a stroke is not its length but its length times how many times it was
 * published, and drawing without lifting the pen is quadratic.
 *
 * Measured through the real publish path at the fixed 50ms cadence, points
 * arriving at 60Hz:
 *
 *   1s stroke,  60 points   3.5KB
 *   3s stroke, 180 points  23.5KB
 *   5s stroke, 300 points  62KB
 *  10s stroke, 600 points  238KB
 *
 * Handwriting is short strokes and never reaches the top of that table; a
 * diagram drawn in one movement does, and it lands on the teacher's uplink,
 * which is the slow direction of a home connection and is shared with the
 * cursor and presence traffic that make the board feel live.
 *
 * So the cadence widens once a stroke is long. It leaves the common case
 * exactly as it was -- what a remote peer sees for the first hundred and fifty
 * points is unchanged -- and past that point it trades some smoothness of the
 * live preview for an uplink that is not saturated. The stroke itself is not
 * degraded: pointer-up flushes the complete array either way, so what is
 * finally on the board is identical, and only the animation of it arriving is
 * coarser.
 */

/** The cadence for a stroke that has not got long yet. */
export const STROKE_COMMIT_INTERVAL_MS = 50;

/** Points beyond which a stroke publishes less often. */
export const LONG_STROKE_POINTS = 150;

/** The cadence for a stroke past `LONG_STROKE_POINTS`. */
export const LONG_STROKE_COMMIT_INTERVAL_MS = 200;

/** How long to wait before publishing a stroke that currently holds `points`. */
export function strokeCommitIntervalMs(points: number): number {
  return points > LONG_STROKE_POINTS
    ? LONG_STROKE_COMMIT_INTERVAL_MS
    : STROKE_COMMIT_INTERVAL_MS;
}

/**
 * The number of points in the stroke being drawn, or 0.
 *
 * Excalidraw appends the element under the pointer, so the live stroke is the
 * last one in the scene. Reading only that keeps this O(1) per pointer sample:
 * scanning the scene for the longest array would put back exactly the per-
 * sample walk over the whole board that the throttle exists to avoid.
 */
export function livePointCount(elements: readonly unknown[]): number {
  const last = elements[elements.length - 1] as { points?: unknown } | undefined;
  return Array.isArray(last?.points) ? last.points.length : 0;
}
