import { describe, expect, it } from 'vitest';
import {
  excalidrawElementsEqual,
  reconcileElements,
  serializeExcalidrawElement,
  serializeExcalidrawElements,
  toExcalidrawToolType,
  uniqueElementsById,
} from './excalidrawSync';

describe('excalidraw sync helpers', () => {
  it('maps app tool ids to Excalidraw tool types', () => {
    expect(toExcalidrawToolType('select')).toBe('selection');
    expect(toExcalidrawToolType('pen')).toBe('freedraw');
    expect(toExcalidrawToolType('circle')).toBe('ellipse');
    expect(toExcalidrawToolType('unknown')).toBe('selection');
  });

  it('drops elements without a valid Excalidraw type', () => {
    expect(serializeExcalidrawElement({ id: 'bad' })).toBeNull();
    expect(serializeExcalidrawElement({ id: 'bad', type: 'pen' })).toBeNull();
    expect(serializeExcalidrawElements([
      { id: 'ok', type: 'line', x: 0, y: 0, points: [[0, 0], [10, 10]] },
      { id: 'bad', type: undefined },
    ])).toHaveLength(1);
  });

  it('removes undefined object properties before writing to Yjs', () => {
    expect(serializeExcalidrawElement({
      id: 'rect',
      type: 'rectangle',
      x: 0,
      y: 0,
      customData: undefined,
    })).toEqual({
      id: 'rect',
      type: 'rectangle',
      x: 0,
      y: 0,
    });
  });

  it('keeps the last copy when restoreElements repeats an id', () => {
    expect(uniqueElementsById([
      { id: 'rect', type: 'rectangle', width: 10 },
      { id: 'ell', type: 'ellipse' },
      { id: 'rect', type: 'rectangle', width: 20 },
    ])).toEqual([
      { id: 'rect', type: 'rectangle', width: 20 },
      { id: 'ell', type: 'ellipse' },
    ]);
  });

  it('compares elements after serialization', () => {
    expect(excalidrawElementsEqual(
      [{ id: 'rect', type: 'rectangle', customData: undefined }],
      [{ id: 'rect', type: 'rectangle' }],
    )).toBe(true);
  });
});

describe('reconcileElements', () => {
  const element = (id: string, version: number, extra: Record<string, unknown> = {}) => ({
    id, type: 'rectangle', version, ...extra,
  });

  it('keeps a local element the stale snapshot has not caught up with', () => {
    const merged = reconcileElements([element('a', 5, { x: 99 })], [element('a', 2, { x: 1 })]);
    expect(merged).toEqual([element('a', 5, { x: 99 })]);
  });

  it('takes the remote element when it is newer', () => {
    const merged = reconcileElements([element('a', 1)], [element('a', 7, { x: 3 })]);
    expect(merged).toEqual([element('a', 7, { x: 3 })]);
  });

  it('never drops a local element missing from the snapshot', () => {
    const merged = reconcileElements([element('local-only', 1)], [element('remote-only', 1)]);
    expect(merged.map((e) => e.id).sort()).toEqual(['local-only', 'remote-only']);
  });

  it('adds elements the snapshot has and the scene does not', () => {
    expect(reconcileElements([], [element('a', 1)])).toEqual([element('a', 1)]);
  });

  it('prefers local on an equal version, so a redundant poll changes nothing', () => {
    const merged = reconcileElements([element('a', 3, { x: 10 })], [element('a', 3, { x: 20 })]);
    expect(merged).toEqual([element('a', 3, { x: 10 })]);
  });

  it('treats a missing version as oldest rather than throwing', () => {
    const merged = reconcileElements(
      [{ id: 'a', type: 'rectangle' }],
      [element('a', 1, { x: 5 })],
    );
    expect(merged).toEqual([element('a', 1, { x: 5 })]);
  });

  it('ignores entries that are not valid Excalidraw elements', () => {
    const merged = reconcileElements([element('a', 1)], [{ id: 'b', type: 'bogus' }, null]);
    expect(merged.map((e) => e.id)).toEqual(['a']);
  });
});
