/** Element types whose geometry lives in `points` rather than width/height. */
const POINT_BEARING_TYPES = new Set(['line', 'arrow', 'freedraw']);

/**
 * Last guard before a scene reaches Excalidraw.
 *
 * `element.points.length` is read for line and arrow without checking the field
 * is there (`scene/Shape.ts`), and it is read while walking the whole scene, so
 * a single element without points throws out of the render and blanks the board
 * for every peer rather than for the one element that is broken.
 *
 * getElementsFromArray already does this for elements coming out of the shared
 * document, and that is the right place for the ones it sees. This exists
 * because it is not the only route: reconciliation, the queued-elements path
 * and the offline cache all reach `updateScene` too, and the cost of missing
 * one of them is the whole board.
 *
 * Empty is the honest answer when geometry cannot be recovered, and it degrades
 * the way it should -- Excalidraw treats a linear element with fewer than two
 * points as invisibly small and drops that one element.
 */
export function withRenderableGeometry<T>(elements: readonly T[]): readonly T[] {
  let firstBroken = -1;
  for (let i = 0; i < elements.length; i++) {
    if (needsPoints(elements[i])) {
      firstBroken = i;
      break;
    }
  }

  // A scene that is already fine is returned untouched. This runs on every
  // remote update, and copying the whole board to change nothing is not free.
  if (firstBroken === -1) return elements;

  const repaired = elements.slice();
  for (let i = firstBroken; i < repaired.length; i++) {
    if (needsPoints(repaired[i])) {
      repaired[i] = { ...(repaired[i] as object), points: [] } as T;
    }
  }
  return repaired;
}

function needsPoints(element: unknown): boolean {
  if (!element || typeof element !== 'object') return false;
  const candidate = element as { type?: unknown; points?: unknown };
  if (!POINT_BEARING_TYPES.has(candidate.type as string)) return false;
  return !Array.isArray(candidate.points);
}
