/** Element types whose geometry lives in `points` rather than width/height. */
const POINT_BEARING_TYPES = new Set(['line', 'arrow', 'freedraw']);

/**
 * Line and arrow geometry is read as `points.length` (scene/Shape.ts) and then
 * as `points[0]` while the element's bounds are computed, so for these two an
 * empty list is as fatal as a missing one.
 */
const LINEAR_TYPES = new Set(['line', 'arrow']);

/** Element types Excalidraw fills, which read `backgroundColor` while drawing. */
const BACKGROUND_TYPES = new Set([
  'rectangle',
  'iframe',
  'embeddable',
  'ellipse',
  'diamond',
  'line',
  'freedraw',
]);

/**
 * What a point-bearing element gets when its geometry cannot be read.
 *
 * A linear element needs one point to survive the bounds pass; a freedraw with
 * no points never touches its missing `pressures`, which is what a single
 * fabricated point would do.
 */
export function repairedPointsFor(type: string): number[][] {
  return LINEAR_TYPES.has(type) ? [[0, 0]] : [];
}

/**
 * Whether an element's geometry has to be repaired before Excalidraw sees it.
 */
export function needsPointRepair(element: unknown): boolean {
  if (!element || typeof element !== 'object') return false;
  const candidate = element as { type?: unknown; points?: unknown };
  const type = candidate.type as string;
  if (!POINT_BEARING_TYPES.has(type)) return false;
  if (!Array.isArray(candidate.points)) return true;
  return LINEAR_TYPES.has(type) && candidate.points.length === 0;
}

/**
 * Whether a fillable element arrived without a usable background colour.
 */
export function needsBackgroundRepair(element: unknown): boolean {
  if (!element || typeof element !== 'object') return false;
  const candidate = element as { type?: unknown; backgroundColor?: unknown };
  if (!BACKGROUND_TYPES.has(candidate.type as string)) return false;
  return typeof candidate.backgroundColor !== 'string' || candidate.backgroundColor.length === 0;
}

/**
 * Last guard before a scene reaches Excalidraw.
 *
 * `element.points.length` and `element.points[0]` are read for line and arrow
 * without checking the field is there (`scene/Shape.ts`, bounds), and it is
 * read while walking the whole scene, so a single element without usable
 * geometry throws out of the render and blanks the board for every peer rather
 * than for the one element that is broken.
 *
 * getElementsFromArray already does this for elements coming out of the shared
 * document, and that is the right place for the ones it sees. This exists
 * because it is not the only route: reconciliation, the queued-elements path
 * and the offline cache all reach `updateScene` too, and the cost of missing
 * one of them is the whole board.
 */
export function withRenderableGeometry<T>(elements: readonly T[]): readonly T[] {
  let firstBroken = -1;
  for (let i = 0; i < elements.length; i++) {
    if (needsRepair(elements[i])) {
      firstBroken = i;
      break;
    }
  }

  // A scene that is already fine is returned untouched. This runs on every
  // remote update, and copying the whole board to change nothing is not free.
  if (firstBroken === -1) return elements;

  const repaired = elements.slice();
  for (let i = firstBroken; i < repaired.length; i++) {
    const element = repaired[i] as { type?: unknown } | null;
    if (!needsRepair(element)) continue;
    const next: Record<string, unknown> = { ...(element as object) };
    if (needsPointRepair(element)) next.points = repairedPointsFor(String(element?.type));
    if (needsBackgroundRepair(element)) next.backgroundColor = 'transparent';
    repaired[i] = next as T;
  }
  return repaired;
}

function needsRepair(element: unknown): boolean {
  return needsPointRepair(element) || needsBackgroundRepair(element);
}
