import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import {
  createWhiteboardDoc,
  getElementsFromArray,
  replaceSharedElements,
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
