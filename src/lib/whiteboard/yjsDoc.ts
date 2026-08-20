import * as Y from 'yjs';
import type { CanvasElement } from '@/types/whiteboard';

export function createWhiteboardDoc(roomId: string) {
  const doc = new Y.Doc();

  const elementsArray = doc.getArray<Y.Map<any>>('elements');
  const viewportMap = doc.getMap('viewport');
  const cursorsMap = doc.getMap('cursors');

  return { doc, elementsArray, viewportMap, cursorsMap };
}

export function addElementToArray(
  elementsArray: Y.Array<Y.Map<any>>,
  element: CanvasElement
) {
  const yMap = new Y.Map();
  yMap.set('id', element.id);
  yMap.set('type', element.type);
  yMap.set('points', JSON.stringify((element as any).points || []));
  yMap.set('color', (element as any).color || '');
  yMap.set('strokeWidth', (element as any).strokeWidth || 2);
  yMap.set('x', (element as any).x || 0);
  yMap.set('y', (element as any).y || 0);
  yMap.set('width', (element as any).width || 0);
  yMap.set('height', (element as any).height || 0);
  yMap.set('text', (element as any).text || '');
  yMap.set('fontSize', (element as any).fontSize || 16);
  yMap.set('fontFamily', (element as any).fontFamily || 'sans-serif');
  yMap.set('bold', (element as any).bold || false);
  yMap.set('italic', (element as any).italic || false);
  yMap.set('fill', (element as any).fill || 'transparent');
  yMap.set('stroke', (element as any).stroke || '#000000');
  yMap.set('content', (element as any).content || '');
  yMap.set('backgroundColor', (element as any).backgroundColor || '#fff9c4');
  yMap.set('borderColor', (element as any).borderColor || '#000000');
  yMap.set('borderRadius', (element as any).borderRadius || 4);
  if ((element as { rotation?: number }).rotation != null) {
    yMap.set('rotation', (element as { rotation?: number }).rotation);
  }
  elementsArray.push([yMap]);
}

export function removeElementFromArray(
  elementsArray: Y.Array<Y.Map<any>>,
  elementId: string
) {
  const items = elementsArray.toArray();
  const index = items.findIndex((item) => item.get('id') === elementId);
  if (index !== -1) {
    elementsArray.delete(index, 1);
  }
}

export function updateElementInArray(
  elementsArray: Y.Array<Y.Map<any>>,
  elementId: string,
  updates: Partial<CanvasElement>
) {
  const items = elementsArray.toArray();
  const index = items.findIndex((item) => item.get('id') === elementId);
  if (index === -1) return;

  const yMap = items[index];
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'points') {
      yMap.set(key, JSON.stringify(value || []));
    } else {
      yMap.set(key, value);
    }
  }
}

function toYjsValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left == null || right == null) return left === right;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

type ReplaceSharedOptions = {
  /** When set, only these ids may be deleted if they are missing from `nextElements`. */
  previousIds?: readonly string[];
  /**
   * Set false when `nextElements` is only the elements that changed rather than
   * the whole scene. Without it the stale sweep below would treat every element
   * the caller did not resend as deleted and wipe the board.
   */
  deleteMissing?: boolean;
};

/**
 * Sync a scene into the shared array by element id.
 *
 * Wholesale `delete(0, length)` + `push` races: two peers each replacing the
 * whole array at once duplicate every shape. Updating the map for an existing
 * id (and only inserting/removing the delta) keeps concurrent draws additive.
 *
 * Local Excalidraw `onChange` is a snapshot of *this* client's scene. It must
 * not prune remote ids it has not observed yet — pass `previousIds` from the
 * last scene this client published.
 */
export function replaceSharedElements(
  doc: Y.Doc,
  elementsArray: Y.Array<Y.Map<any>>,
  nextElements: ReadonlyArray<Record<string, unknown>>,
  origin: unknown = 'local',
  options?: ReplaceSharedOptions,
): void {
  doc.transact(() => {
    const byId = new Map<string, Y.Map<any>>();
    for (const map of elementsArray.toArray()) {
      const id = map.get('id');
      if (typeof id === 'string') byId.set(id, map);
    }

    const seen = new Set<string>();
    for (const element of nextElements) {
      const id = element.id;
      if (typeof id !== 'string' || id.length === 0) continue;
      seen.add(id);

      let map = byId.get(id);
      if (!map) {
        map = new Y.Map();
        elementsArray.push([map]);
        byId.set(id, map);
      }

      for (const [key, value] of Object.entries(element)) {
        const encoded = toYjsValue(value);
        if (encoded === undefined) continue;
        if (!valuesEqual(map.get(key), encoded)) {
          map.set(key, encoded);
        }
      }
      for (const key of Array.from(map.keys())) {
        if (!Object.prototype.hasOwnProperty.call(element, key)) {
          map.delete(key);
        }
      }
    }

    if (options?.deleteMissing === false) return;

    const removable = options?.previousIds ? new Set(options.previousIds) : null;
    const staleIndexes: number[] = [];
    elementsArray.toArray().forEach((map, index) => {
      const id = map.get('id');
      if (typeof id !== 'string' || seen.has(id)) return;
      if (removable && !removable.has(id)) return;
      staleIndexes.push(index);
    });
    for (let i = staleIndexes.length - 1; i >= 0; i--) {
      elementsArray.delete(staleIndexes[i], 1);
    }
  }, origin);
}

export function getElementsFromArray(
  elementsArray: Y.Array<Y.Map<any>>
): CanvasElement[] {
  return elementsArray.toArray().map((yMap) => {
    const element: Record<string, unknown> = {};
    yMap.forEach((value: unknown, key: string) => {
      element[key] = value;
    });
    if (typeof element.points === 'string') {
      try {
        element.points = JSON.parse(element.points);
      } catch {
        // Keep the raw string when a legacy row is not JSON.
      }
    }
    return element as CanvasElement;
  });
}
