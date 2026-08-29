import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import {
  createWhiteboardDoc,
  getElementsFromArray,
  replaceSharedElements,
  pruneTombstonedElements,
} from './yjsDoc';

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
