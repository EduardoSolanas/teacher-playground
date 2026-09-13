import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import {
  createWhiteboardDoc,
  getElementsFromArray,
  replaceSharedElements,
  pruneTombstonedElements,
  addElementToArray,
  removeElementFromArray,
  updateElementInArray,
} from './yjsDoc';
import { encodePoints } from './pointCodec';

function idsOf(doc: Y.Doc): string[] {
  const arr = doc.getArray<Y.Map<unknown>>('elements');
  return getElementsFromArray(arr).map((el) => String(el.id)).sort();
}

function connect(a: Y.Doc, b: Y.Doc) {
  a.on('update', (update, origin) => {
    if (origin === 'remote') return;
    Y.applyUpdate(b, update, 'remote');
  });
  b.on('update', (update, origin) => {
    if (origin === 'remote') return;
    Y.applyUpdate(a, update, 'remote');
  });
}

describe('replaceSharedElements', () => {
  it('adds, updates, and removes by element id without duplicating', () => {
    const { doc, elementsArray } = createWhiteboardDoc('room');

    replaceSharedElements(doc, elementsArray, [
      { id: 'rect-1', type: 'rectangle', width: 10 },
    ]);
    expect(idsOf(doc)).toEqual(['rect-1']);

    replaceSharedElements(doc, elementsArray, [
      { id: 'rect-1', type: 'rectangle', width: 20 },
      { id: 'line-1', type: 'line', width: 5 },
    ]);
    expect(idsOf(doc)).toEqual(['line-1', 'rect-1']);
    expect(getElementsFromArray(elementsArray).find((el) => el.id === 'rect-1')).toMatchObject({
      width: 20,
    });

    replaceSharedElements(doc, elementsArray, []);
    expect(idsOf(doc)).toEqual([]);
  });

  it('keeps concurrent inserts of different ids instead of duplicating a wholesale replace', () => {
    const a = createWhiteboardDoc('room-a');
    const b = createWhiteboardDoc('room-b');

    const pendingA: Uint8Array[] = [];
    const pendingB: Uint8Array[] = [];
    a.doc.on('update', (update, origin) => {
      if (origin === 'remote') return;
      pendingA.push(update);
    });
    b.doc.on('update', (update, origin) => {
      if (origin === 'remote') return;
      pendingB.push(update);
    });

    replaceSharedElements(a.doc, a.elementsArray, [
      { id: 'from-a', type: 'rectangle', width: 40, height: 40 },
    ]);
    replaceSharedElements(b.doc, b.elementsArray, [
      { id: 'from-b', type: 'ellipse', width: 30, height: 30 },
    ]);

    for (const update of pendingA) Y.applyUpdate(b.doc, update, 'remote');
    for (const update of pendingB) Y.applyUpdate(a.doc, update, 'remote');

    expect(idsOf(a.doc)).toEqual(['from-a', 'from-b']);
    expect(idsOf(b.doc)).toEqual(['from-a', 'from-b']);
  });

  it('does not duplicate a shared scene when both peers rewrite it concurrently', () => {
    const a = createWhiteboardDoc('dup-a');
    const b = createWhiteboardDoc('dup-b');

    const pendingA: Uint8Array[] = [];
    const pendingB: Uint8Array[] = [];
    a.doc.on('update', (update, origin) => {
      if (origin === 'remote') return;
      pendingA.push(update);
    });
    b.doc.on('update', (update, origin) => {
      if (origin === 'remote') return;
      pendingB.push(update);
    });

    const shared = [
      { id: 'rect-1', type: 'rectangle', width: 40, height: 40 },
      { id: 'ell-1', type: 'ellipse', width: 30, height: 30 },
    ];
    replaceSharedElements(a.doc, a.elementsArray, shared);
    for (const update of pendingA) Y.applyUpdate(b.doc, update, 'remote');
    expect(idsOf(b.doc)).toEqual(['ell-1', 'rect-1']);

    pendingA.length = 0;
    pendingB.length = 0;

    replaceSharedElements(a.doc, a.elementsArray, shared);
    replaceSharedElements(b.doc, b.elementsArray, shared);

    for (const update of pendingA) Y.applyUpdate(b.doc, update, 'remote');
    for (const update of pendingB) Y.applyUpdate(a.doc, update, 'remote');

    expect(idsOf(a.doc)).toEqual(['ell-1', 'rect-1']);
    expect(idsOf(b.doc)).toEqual(['ell-1', 'rect-1']);
  });

  it('an HTTP snapshot with previousIds [] does not prune live remote ids', () => {
    const { doc, elementsArray } = createWhiteboardDoc('api-fallback');
    replaceSharedElements(doc, elementsArray, [
      { id: 'from-yjs', type: 'ellipse' },
    ]);

    replaceSharedElements(
      doc,
      elementsArray,
      [{ id: 'from-http', type: 'rectangle' }],
      'api-fallback',
      { previousIds: [] },
    );

    expect(idsOf(doc)).toEqual(['from-http', 'from-yjs']);
  });

  it('does not remove remote ids that were never in the previous local scene', () => {
    const { doc, elementsArray } = createWhiteboardDoc('keep-remote');
    replaceSharedElements(doc, elementsArray, [
      { id: 'from-a', type: 'rectangle' },
      { id: 'from-b', type: 'ellipse' },
    ]);

    replaceSharedElements(
      doc,
      elementsArray,
      [{ id: 'from-a', type: 'rectangle', width: 12 }],
      'local',
      { previousIds: ['from-a'] },
    );

    expect(idsOf(doc)).toEqual(['from-a', 'from-b']);
    expect(getElementsFromArray(elementsArray).find((el) => el.id === 'from-a')).toMatchObject({
      width: 12,
    });
  });

  it('removes ids the local scene dropped', () => {
    const { doc, elementsArray } = createWhiteboardDoc('drop-local');
    replaceSharedElements(doc, elementsArray, [
      { id: 'keep', type: 'rectangle' },
      { id: 'drop', type: 'ellipse' },
    ]);

    replaceSharedElements(
      doc,
      elementsArray,
      [{ id: 'keep', type: 'rectangle' }],
      'local',
      { previousIds: ['keep', 'drop'] },
    );

    expect(idsOf(doc)).toEqual(['keep']);
  });

  it('copies every field off the shared map so freedraw points survive a round trip', () => {
    const { doc, elementsArray } = createWhiteboardDoc('room');
    replaceSharedElements(doc, elementsArray, [
      {
        id: 'pen-1',
        type: 'freedraw',
        points: [[0, 0], [8, 12]],
        pressures: [0.4, 0.5],
        simulatePressure: true,
      },
    ]);

    const [element] = getElementsFromArray(elementsArray);
    expect(element).toMatchObject({
      id: 'pen-1',
      type: 'freedraw',
      points: [[0, 0], [8, 12]],
      simulatePressure: true,
    });
  });

  it('live-linked docs stay aligned after an id-keyed replace', () => {
    const a = createWhiteboardDoc('live-a');
    const b = createWhiteboardDoc('live-b');
    connect(a.doc, b.doc);

    replaceSharedElements(a.doc, a.elementsArray, [
      { id: 'shared', type: 'rectangle', width: 12 },
    ]);
    expect(idsOf(b.doc)).toEqual(['shared']);
  });

  it('stores nested Excalidraw fields that are not Yjs shared types', () => {
    const { doc, elementsArray } = createWhiteboardDoc('nested');
    replaceSharedElements(doc, elementsArray, [
      {
        id: 'rect-nested',
        type: 'rectangle',
        roundness: { type: 3 },
        boundElements: [{ id: 'arrow-1', type: 'arrow' }],
        groupIds: [],
        index: 'a0',
      },
    ]);
    expect(getElementsFromArray(elementsArray)[0]).toMatchObject({
      id: 'rect-nested',
      roundness: { type: 3 },
      boundElements: [{ id: 'arrow-1', type: 'arrow' }],
      index: 'a0',
    });
  });
});

describe('getElementsFromArray point recovery', () => {
  function seed(entries: Record<string, unknown>): Y.Array<Y.Map<unknown>> {
    const { doc } = createWhiteboardDoc('points-room');
    const array = doc.getArray<Y.Map<unknown>>('elements');
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(entries)) map.set(key, value);
    array.push([map]);
    return array;
  }

  /*
   * Excalidraw's restore() reads `points.length` on a linear or freedraw
   * element without checking it is there, so one element missing its points
   * throws out of the observer and takes the whole scene down for every peer
   * -- not just the element that is broken. Empty points is the honest answer
   * when the geometry cannot be recovered, and Excalidraw then drops that one
   * element as invisibly small.
   */
  it('gives a linear element empty points when the map holds none', () => {
    const [element] = getElementsFromArray(seed({ id: 'line-1', type: 'line' }));
    expect((element as { points?: unknown }).points).toEqual([]);
  });

  it('gives an arrow empty points when the map holds none', () => {
    const [element] = getElementsFromArray(seed({ id: 'arrow-1', type: 'arrow' }));
    expect((element as { points?: unknown }).points).toEqual([]);
  });

  it('gives a freedraw element empty points when the encoding is unreadable', () => {
    // A leading byte that is not the codec version: decode refuses it.
    const corrupt = new Uint8Array([9, 9, 9, 9]);
    const [element] = getElementsFromArray(
      seed({ id: 'draw-1', type: 'freedraw', points: corrupt }),
    );
    expect((element as { points?: unknown }).points).toEqual([]);
  });

  it('leaves a shape that never had points alone', () => {
    const [element] = getElementsFromArray(seed({ id: 'rect-1', type: 'rectangle' }));
    expect((element as { points?: unknown }).points).toBeUndefined();
  });

  it('still decodes points it can read', () => {
    const { doc, elementsArray: array } = createWhiteboardDoc('points-ok');
    replaceSharedElements(doc, array, [
      { id: 'line-2', type: 'line', points: [[0, 0], [10, 5]] },
    ] as never);
    const [element] = getElementsFromArray(array);
    expect((element as { points?: unknown }).points).toEqual([[0, 0], [10, 5]]);
  });
});

describe('pruneTombstonedElements', () => {
  /**
   * Creates a freedraw element with a given number of points.
   * Each point is a small array like [x, y], so more points = more bytes.
   */
  function freedrawStroke(id: string, points: number) {
    return {
      id,
      type: 'freedraw',
      points: Array.from({ length: points }, (_, i) => [i, i * 2]),
    };
  }

  it('returns 0 when there are no tombstones', () => {
    const { doc, elementsArray } = createWhiteboardDoc('no-tombstones');
    replaceSharedElements(doc, elementsArray, [
      freedrawStroke('stroke-1', 50),
      freedrawStroke('stroke-2', 50),
    ] as any);

    const deleted = pruneTombstonedElements(doc);
    expect(deleted).toBe(0);
  });

  it('reduces snapshot size after erasing and pruning', () => {
    const { doc, elementsArray } = createWhiteboardDoc('shrink-test');
    const strokes = Array.from({ length: 20 }, (_, i) =>
      freedrawStroke(`stroke-${i}`, 100),
    );
    replaceSharedElements(doc, elementsArray, strokes as any);

    const beforeSize = Y.encodeStateAsUpdate(doc).byteLength;

    /* Erase half the strokes by marking them deleted (as Excalidraw does). */
    replaceSharedElements(
      doc,
      elementsArray,
      strokes.map((s, i) => ({
        ...s,
        isDeleted: i < 10 ? true : undefined,
      })) as any,
    );

    const afterEraseSize = Y.encodeStateAsUpdate(doc).byteLength;
    expect(afterEraseSize).toBeGreaterThan(beforeSize); // Tombstones are in the doc

    const deleted = pruneTombstonedElements(doc);
    expect(deleted).toBe(10);

    const afterPruneSize = Y.encodeStateAsUpdate(doc).byteLength;
    expect(afterPruneSize).toBeLessThan(afterEraseSize);
    expect(afterPruneSize).toBeLessThan(beforeSize); // Much smaller than the original
  });

  it('preserves non-deleted elements unchanged', () => {
    const { doc, elementsArray } = createWhiteboardDoc('preserve-test');
    const keep = freedrawStroke('keep-1', 80);
    const erase = freedrawStroke('erase-1', 100);

    replaceSharedElements(doc, elementsArray, [keep, erase] as any);

    /* Mark erase as deleted. */
    replaceSharedElements(
      doc,
      elementsArray,
      [
        keep,
        { ...erase, isDeleted: true },
      ] as any,
    );

    pruneTombstonedElements(doc);

    const remaining = getElementsFromArray(elementsArray);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      id: 'keep-1',
      type: 'freedraw',
    });
    /* Points survive intact after the round trip through pruning. */
    expect((remaining[0] as any).points).toHaveLength(80);
  });

  it('converges two connected docs without duplicating after pruning', () => {
    const host = createWhiteboardDoc('prune-host');
    const peer = createWhiteboardDoc('prune-peer');
    connect(host.doc, peer.doc);

    /* Both start with the same strokes. */
    const strokes = Array.from({ length: 15 }, (_, i) =>
      freedrawStroke(`stroke-${i}`, 80),
    );
    replaceSharedElements(host.doc, host.elementsArray, strokes as any);
    expect(idsOf(peer.doc)).toEqual(idsOf(host.doc));

    /* Mark half as deleted on the host. */
    replaceSharedElements(
      host.doc,
      host.elementsArray,
      strokes.map((s, i) => ({
        ...s,
        isDeleted: i < 7 ? true : undefined,
      })) as any,
    );

    /* Peer receives the tombstones. */
    expect(idsOf(peer.doc)).toEqual(idsOf(host.doc));

    /* Prune on the host (simulating no open sockets). */
    const deleted = pruneTombstonedElements(host.doc);
    expect(deleted).toBe(7);

    /* Peer receives the delete as a normal update and converges. */
    expect(idsOf(peer.doc)).toEqual(idsOf(host.doc));
    expect(idsOf(host.doc)).toHaveLength(8);

    /* No duplicates: each element appears exactly once on both. */
    const hostElements = getElementsFromArray(host.elementsArray);
    const peerElements = getElementsFromArray(peer.elementsArray);
    const hostIds = hostElements.map((e: any) => e.id).sort();
    const peerIds = peerElements.map((e: any) => e.id).sort();
    expect(peerIds).toEqual(hostIds);
    expect(new Set(hostIds).size).toBe(8);
    host.doc.destroy();
    peer.doc.destroy();
  });

  it('returns the count of elements actually deleted', () => {
    const { doc, elementsArray } = createWhiteboardDoc('count-test');
    const strokes = Array.from({ length: 25 }, (_, i) =>
      freedrawStroke(`stroke-${i}`, 50),
    );
    replaceSharedElements(doc, elementsArray, strokes as any);

    /* Erase 7 strokes. */
    replaceSharedElements(
      doc,
      elementsArray,
      strokes.map((s, i) => ({
        ...s,
        isDeleted: i < 7 ? true : undefined,
      })) as any,
    );

    const deleted = pruneTombstonedElements(doc);
    expect(deleted).toBe(7);

    const remaining = getElementsFromArray(elementsArray);
    expect(remaining).toHaveLength(18);
  });
});

describe('addElementToArray', () => {
  it('preserves strokeWidth of 0 instead of replacing with default 2', () => {
    const { elementsArray } = createWhiteboardDoc('stroke-width-zero');

    const rectangle = {
      id: 'rect-1',
      type: 'rectangle' as const,
      x: 10,
      y: 10,
      width: 100,
      height: 50,
      fill: 'transparent',
      stroke: '#000000',
      strokeWidth: 0,
    } as any;

    addElementToArray(elementsArray, rectangle);

    const elements = getElementsFromArray(elementsArray);
    expect(elements).toHaveLength(1);
    expect((elements[0] as any).strokeWidth).toBe(0);
  });

  it('preserves borderRadius of 0 instead of replacing with default 4', () => {
    const { elementsArray } = createWhiteboardDoc('border-radius-zero');

    const stickyNote = {
      id: 'sticky-1',
      type: 'stickyNote' as const,
      x: 20,
      y: 30,
      width: 120,
      height: 120,
      content: 'Test note',
      backgroundColor: '#fff9c4',
      borderColor: '#000000',
      borderRadius: 0,
    } as any;

    addElementToArray(elementsArray, stickyNote);

    const elements = getElementsFromArray(elementsArray);
    expect(elements).toHaveLength(1);
    expect((elements[0] as any).borderRadius).toBe(0);
  });

  it('preserves underline: true on text elements', () => {
    const { elementsArray } = createWhiteboardDoc('underline-text');

    const textElement = {
      id: 'text-1',
      type: 'text' as const,
      x: 50,
      y: 50,
      width: 200,
      height: 100,
      text: 'Underlined text',
      color: '#000000',
      fontSize: 16,
      fontFamily: 'sans-serif',
      bold: false,
      italic: false,
      underline: true,
    } as any;

    addElementToArray(elementsArray, textElement);

    const elements = getElementsFromArray(elementsArray);
    expect(elements).toHaveLength(1);
    expect((elements[0] as any).underline).toBe(true);
  });

  it('writes every field of a fully specified element to the shared map', () => {
    const { elementsArray } = createWhiteboardDoc('full-element');
    const points = [[0, 0], [10, 5]];
    const element = {
      id: 'pen-1',
      type: 'pen',
      points,
      color: '#ff0000',
      strokeWidth: 3,
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      text: 'hi',
      fontSize: 20,
      fontFamily: 'serif',
      bold: true,
      italic: true,
      underline: true,
      fill: '#eeeeee',
      stroke: '#111111',
      content: 'note',
      backgroundColor: '#aabbcc',
      borderColor: '#ddeeff',
      borderRadius: 9,
      rotation: 45,
    } as any;

    addElementToArray(elementsArray, element);

    const map = elementsArray.get(0);
    expect(map.get('id')).toBe('pen-1');
    expect(map.get('type')).toBe('pen');
    expect(Array.from(map.get('points') as Uint8Array)).toEqual(Array.from(encodePoints(points)!));
    expect(map.get('color')).toBe('#ff0000');
    expect(map.get('strokeWidth')).toBe(3);
    expect(map.get('x')).toBe(1);
    expect(map.get('y')).toBe(2);
    expect(map.get('width')).toBe(3);
    expect(map.get('height')).toBe(4);
    expect(map.get('text')).toBe('hi');
    expect(map.get('fontSize')).toBe(20);
    expect(map.get('fontFamily')).toBe('serif');
    expect(map.get('bold')).toBe(true);
    expect(map.get('italic')).toBe(true);
    expect(map.get('underline')).toBe(true);
    expect(map.get('fill')).toBe('#eeeeee');
    expect(map.get('stroke')).toBe('#111111');
    expect(map.get('content')).toBe('note');
    expect(map.get('backgroundColor')).toBe('#aabbcc');
    expect(map.get('borderColor')).toBe('#ddeeff');
    expect(map.get('borderRadius')).toBe(9);
    expect(map.get('rotation')).toBe(45);
  });

  it('writes the documented default for every field an element omits', () => {
    const { elementsArray } = createWhiteboardDoc('minimal-element');

    addElementToArray(elementsArray, { id: 'min-1', type: 'rectangle' } as any);

    const map = elementsArray.get(0);
    expect(Array.from(map.get('points') as Uint8Array)).toEqual(Array.from(encodePoints([])!));
    expect(map.get('color')).toBe('');
    expect(map.get('strokeWidth')).toBe(2);
    expect(map.get('x')).toBe(0);
    expect(map.get('y')).toBe(0);
    expect(map.get('width')).toBe(0);
    expect(map.get('height')).toBe(0);
    expect(map.get('text')).toBe('');
    expect(map.get('fontSize')).toBe(16);
    expect(map.get('fontFamily')).toBe('sans-serif');
    expect(map.get('bold')).toBe(false);
    expect(map.get('italic')).toBe(false);
    expect(map.get('underline')).toBe(false);
    expect(map.get('fill')).toBe('transparent');
    expect(map.get('stroke')).toBe('#000000');
    expect(map.get('content')).toBe('');
    expect(map.get('backgroundColor')).toBe('#fff9c4');
    expect(map.get('borderColor')).toBe('#000000');
    expect(map.get('borderRadius')).toBe(4);
    expect(map.has('rotation')).toBe(false);
  });

  it('keeps rotation 0 rather than dropping it as falsy', () => {
    const { elementsArray } = createWhiteboardDoc('rotation-zero');

    addElementToArray(elementsArray, { id: 'rot-0', type: 'rectangle', rotation: 0 } as any);

    expect(elementsArray.get(0).get('rotation')).toBe(0);
  });

  it('falls back to JSON for points the codec cannot represent', () => {
    const { elementsArray } = createWhiteboardDoc('unencodable-points');
    const points = [[0, 0], [Number.POSITIVE_INFINITY, 5]];

    addElementToArray(elementsArray, { id: 'bad-points', type: 'pen', points } as any);

    expect(elementsArray.get(0).get('points')).toBe(JSON.stringify(points));
  });
});

describe('removeElementFromArray', () => {
  it('removes the matching element and ignores an unknown id', () => {
    const { doc, elementsArray } = createWhiteboardDoc('remove-element');
    replaceSharedElements(doc, elementsArray, [
      { id: 'a', type: 'rectangle' },
      { id: 'b', type: 'ellipse' },
    ]);

    removeElementFromArray(elementsArray, 'a');
    expect(idsOf(doc)).toEqual(['b']);

    removeElementFromArray(elementsArray, 'missing');
    expect(idsOf(doc)).toEqual(['b']);
  });
});

describe('updateElementInArray', () => {
  it('updates the matching element and encodes replacement points', () => {
    const { doc, elementsArray } = createWhiteboardDoc('update-element');
    replaceSharedElements(doc, elementsArray, [
      { id: 'a', type: 'freedraw', points: [[0, 0]], width: 1 },
    ]);

    updateElementInArray(elementsArray, 'a', { width: 20, points: [[2, 2], [3, 3]] } as never);

    const [element] = getElementsFromArray(elementsArray) as any[];
    expect(element.width).toBe(20);
    expect(element.points).toEqual([[2, 2], [3, 3]]);

    updateElementInArray(elementsArray, 'missing', { width: 99 } as never);
    expect((getElementsFromArray(elementsArray)[0] as any).width).toBe(20);
  });

  it('writes encoded empty points when an update clears the geometry', () => {
    const { doc, elementsArray } = createWhiteboardDoc('update-empty-points');
    replaceSharedElements(doc, elementsArray, [{ id: 'a', type: 'freedraw', points: [[1, 1]] }]);

    updateElementInArray(elementsArray, 'a', { points: undefined } as never);

    expect(elementsArray.get(0).get('points')).toBeInstanceOf(Uint8Array);
  });

  it('falls back to JSON when an updated points value cannot be encoded', () => {
    const { doc, elementsArray } = createWhiteboardDoc('update-fallback');
    const points = [[0, 0], [Number.NaN, 1]];
    replaceSharedElements(doc, elementsArray, [{ id: 'a', type: 'freedraw', points: [[0, 0]] }]);

    updateElementInArray(elementsArray, 'a', { points } as never);

    expect(elementsArray.get(0).get('points')).toBe(JSON.stringify(points));
  });
});

describe('createWhiteboardDoc', () => {
  it('names the shared elements array, viewport, and cursors maps', () => {
    const { doc, elementsArray, viewportMap, cursorsMap } = createWhiteboardDoc('names-room');

    expect(doc.getArray('elements')).toBe(elementsArray);
    expect(doc.getMap('viewport')).toBe(viewportMap);
    expect(doc.getMap('cursors')).toBe(cursorsMap);
  });
});

describe('replaceSharedElements field transport', () => {
  it('ignores entries without a usable string id', () => {
    const { doc, elementsArray } = createWhiteboardDoc('bad-ids');

    replaceSharedElements(doc, elementsArray, [
      { id: 42, type: 'rectangle' },
      { id: '', type: 'rectangle' },
      {},
      { id: 'ok', type: 'rectangle' },
    ] as any);

    expect(idsOf(doc)).toEqual(['ok']);
  });

  it('updates in place when one call repeats an id', () => {
    const { doc, elementsArray } = createWhiteboardDoc('dup-ids');

    replaceSharedElements(doc, elementsArray, [
      { id: 'a', type: 'rectangle', width: 1 },
      { id: 'a', type: 'rectangle', width: 2 },
    ]);

    expect(elementsArray.length).toBe(1);
    expect((getElementsFromArray(elementsArray)[0] as any).width).toBe(2);
  });

  it('stores stroke points in the binary codec form', () => {
    const { doc, elementsArray } = createWhiteboardDoc('binary-points');
    const points = [[0, 0], [10, 5]];

    replaceSharedElements(doc, elementsArray, [{ id: 'a', type: 'freedraw', points }]);

    const stored = elementsArray.get(0).get('points');
    expect(stored).toBeInstanceOf(Uint8Array);
    expect(Array.from(stored as Uint8Array)).toEqual(Array.from(encodePoints(points)!));
  });

  it('falls back to plain points for values the codec cannot represent', () => {
    const { doc, elementsArray } = createWhiteboardDoc('fallback-points');
    const points = [[0, 0], [Number.POSITIVE_INFINITY, 5]];

    replaceSharedElements(doc, elementsArray, [{ id: 'a', type: 'freedraw', points }]);

    expect(elementsArray.get(0).get('points')).toEqual(points);
  });

  it('does not overwrite a stored field with an explicitly undefined update', () => {
    const { doc, elementsArray } = createWhiteboardDoc('undefined-field');
    replaceSharedElements(doc, elementsArray, [{ id: 'a', type: 'rectangle', width: 5 }]);

    replaceSharedElements(doc, elementsArray, [
      { id: 'a', type: 'rectangle', width: undefined },
    ]);

    expect((getElementsFromArray(elementsArray)[0] as any).width).toBe(5);
  });

  it('writes nothing when the incoming scene is unchanged', () => {
    const { doc, elementsArray } = createWhiteboardDoc('no-op');
    const scene = [
      { id: 'a', type: 'rectangle', width: 5 },
      { id: 'b', type: 'freedraw', points: [[0, 0], [1, 1]], groupIds: [] },
    ];
    replaceSharedElements(doc, elementsArray, scene);

    let updates = 0;
    doc.on('update', () => {
      updates += 1;
    });
    replaceSharedElements(doc, elementsArray, scene);

    expect(updates).toBe(0);
  });

  it('drops keys the incoming element no longer carries', () => {
    const { doc, elementsArray } = createWhiteboardDoc('strip-keys');
    replaceSharedElements(doc, elementsArray, [
      { id: 'a', type: 'rectangle', width: 5, stroke: '#f00' },
    ]);

    replaceSharedElements(doc, elementsArray, [{ id: 'a', type: 'rectangle' }]);

    const map = elementsArray.get(0);
    expect(map.has('width')).toBe(false);
    expect(map.has('stroke')).toBe(false);
    expect(map.has('id')).toBe(true);
  });

  it('does not sweep entries whose stored id is not a string', () => {
    const { doc, elementsArray } = createWhiteboardDoc('weird-id');
    const map = new Y.Map<unknown>();
    map.set('width', 1);
    elementsArray.push([map]);

    replaceSharedElements(doc, elementsArray, []);

    expect(elementsArray.length).toBe(1);
  });

  it('tags a local replace with the local origin', () => {
    const { doc, elementsArray } = createWhiteboardDoc('origin-room');
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction: Y.Transaction) => origins.push(transaction.origin));

    replaceSharedElements(doc, elementsArray, [{ id: 'a', type: 'rectangle' }]);

    expect(origins).toEqual(['local']);
  });

  it('tags a prune with the prune origin', () => {
    const { doc, elementsArray } = createWhiteboardDoc('prune-origin');
    replaceSharedElements(doc, elementsArray, [
      { id: 'a', type: 'freedraw', points: [[0, 0]], isDeleted: true },
    ]);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction: Y.Transaction) => origins.push(transaction.origin));

    pruneTombstonedElements(doc);

    expect(origins).toEqual(['prune']);
  });
});
