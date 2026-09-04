import * as Y from 'yjs';
import { cloneForYjs, valuesEqual } from './yjsValue';
import { encodePoints, decodePoints } from './pointCodec';
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

  // Use binary encoding for points if possible, fall back to JSON
  const points = (element as any).points || [];
  const encoded = encodePoints(points);
  yMap.set('points', encoded || JSON.stringify(points));

  /*
   * `??`, not `||`: these are defaults for a *missing* field, and `||` also
   * swallowed legitimate falsy values. A rectangle drawn with strokeWidth 0
   * came back as 2, and a sticky note with square corners came back rounded.
   * The default values below are unchanged — only when they apply is.
   */
  yMap.set('color', (element as any).color ?? '');
  yMap.set('strokeWidth', (element as any).strokeWidth ?? 2);
  yMap.set('x', (element as any).x ?? 0);
  yMap.set('y', (element as any).y ?? 0);
  yMap.set('width', (element as any).width ?? 0);
  yMap.set('height', (element as any).height ?? 0);
  yMap.set('text', (element as any).text ?? '');
  yMap.set('fontSize', (element as any).fontSize ?? 16);
  yMap.set('fontFamily', (element as any).fontFamily ?? 'sans-serif');
  yMap.set('bold', (element as any).bold ?? false);
  yMap.set('italic', (element as any).italic ?? false);
  yMap.set('underline', (element as any).underline ?? false);
  yMap.set('fill', (element as any).fill ?? 'transparent');
  yMap.set('stroke', (element as any).stroke ?? '#000000');
  yMap.set('content', (element as any).content ?? '');
  yMap.set('backgroundColor', (element as any).backgroundColor ?? '#fff9c4');
  yMap.set('borderColor', (element as any).borderColor ?? '#000000');
  yMap.set('borderRadius', (element as any).borderRadius ?? 4);
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
      // Use binary encoding for points if possible, fall back to JSON
      const encoded = encodePoints(value || []);
      yMap.set(key, encoded || JSON.stringify(value || []));
    } else {
      yMap.set(key, value);
    }
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
        /*
         * Strokes are the reason the codec exists, and this is the path they
         * take: every pointer sample reaches the document through here, not
         * through addElementToArray. Encoding only there left the packing
         * switched on in code and switched off in practice.
         *
         * A null means the codec could not represent these points exactly, so
         * they are stored the ordinary way rather than approximated.
         */
        const encoded = key === 'points'
          ? (encodePoints(value) ?? cloneForYjs(value))
          : cloneForYjs(value);
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

/** Element types whose geometry lives in `points` rather than width/height. */
const POINT_BEARING_TYPES = new Set(['line', 'arrow', 'freedraw']);

export function getElementsFromArray(
  elementsArray: Y.Array<Y.Map<any>>
): CanvasElement[] {
  return elementsArray.toArray().map((yMap) => {
    const element: Record<string, unknown> = {};
    yMap.forEach((value: unknown, key: string) => {
      element[key] = value;
    });
    // Use decodePoints to handle all four forms: binary Uint8Array, JSON string, plain array, or already-decoded
    const decoded = decodePoints(element.points);
    if (decoded !== null) {
      element.points = decoded;
    } else if (POINT_BEARING_TYPES.has(element.type as string)) {
      /*
       * Excalidraw reads `points.length` on these types without checking the
       * field is there, and it does so inside restore(), which runs over the
       * whole scene. One element that arrives without readable points -- a map
       * that never held them, or bytes this codec cannot read -- therefore
       * throws out of the observer and blanks the board for every peer, not
       * just for the element that is broken.
       *
       * Empty is the honest answer when the geometry cannot be recovered, and
       * it degrades the way it should: Excalidraw treats a linear element with
       * fewer than two points as invisibly small and drops that one element.
       */
      element.points = [];
    }
    return element as CanvasElement;
  });
}

/**
 * Prunes tombstoned (deleted) elements from a Y.Doc's elements array.
 *
 * Excalidraw marks erased elements with isDeleted: true rather than removing
 * them, and every freedraw stroke carries a full point array (~10KB each). A
 * snapshot that keeps them grows every draw-and-erase cycle and never shrinks,
 * eventually exceeding the request body cap and stopping saves silently.
 *
 * This function deletes the Y.Map entries for tombstoned elements from the
 * array. It is a normal CRDT delete: each full element map collapses to a
 * small delete-set range, it propagates to peers correctly, and it does NOT
 * reset document identity. This must only run when the room has NO open
 * WebSockets, because a peer holding a pre-erase scene would republish its
 * erased elements as new items. Without that guard, the delete propagates to
 * the peer as a separate operation, and the peer's old scene creates a second
 * copy of every shape.
 *
 * Returns the number of tombstoned elements deleted.
 */
export function pruneTombstonedElements(doc: Y.Doc): number {
  const elementsArray = doc.getArray<Y.Map<any>>('elements');
  const current = elementsArray.toArray();

  const tombstoneIndexes: number[] = [];
  current.forEach((yMap, index) => {
    const isDeleted = yMap.get('isDeleted');
    if (isDeleted === true) {
      tombstoneIndexes.push(index);
    }
  });

  if (tombstoneIndexes.length === 0) {
    return 0;
  }

  /*
   * Delete from highest index downward. Deleting the highest first ensures
   * subsequent indexes remain valid. This matches the pattern used in
   * replaceSharedElements for its stale sweep.
   */
  doc.transact(() => {
    for (let i = tombstoneIndexes.length - 1; i >= 0; i--) {
      elementsArray.delete(tombstoneIndexes[i], 1);
    }
  }, 'prune');

  return tombstoneIndexes.length;
}
