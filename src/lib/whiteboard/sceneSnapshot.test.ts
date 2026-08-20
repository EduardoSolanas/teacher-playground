import { describe, expect, it } from 'vitest';

import { snapshotElements } from './sceneSnapshot';

describe('snapshotElements', () => {
  it('drops erased strokes so a board cannot grow without bound', () => {
    // The shape that caused the bug: a board showing one stroke, storing four.
    const elements = [
      { id: 'live', type: 'freedraw' },
      { id: 'erased-1', type: 'freedraw', isDeleted: true },
      { id: 'erased-2', type: 'freedraw', isDeleted: true },
      { id: 'erased-3', type: 'freedraw', isDeleted: true },
    ];

    expect(snapshotElements(elements).map((element) => element.id)).toEqual(['live']);
  });

  it('keeps every visible element, in order', () => {
    const elements = [
      { id: 'a', isDeleted: false },
      { id: 'b' },
      { id: 'c', isDeleted: false },
    ];

    expect(snapshotElements(elements).map((element) => element.id)).toEqual(['a', 'b', 'c']);
  });

  it('treats only isDeleted === true as a tombstone', () => {
    // Nothing else may drop an element a teacher can still see: a truthy-ish
    // value is not a deletion, and Excalidraw only ever sets the boolean.
    const elements = [
      { id: 'string-flag', isDeleted: 'true' },
      { id: 'numeric-flag', isDeleted: 1 },
      { id: 'null-flag', isDeleted: null },
      { id: 'undefined-flag', isDeleted: undefined },
    ];

    expect(snapshotElements(elements)).toHaveLength(4);
  });

  it('survives malformed entries without throwing', () => {
    const elements = [null, undefined, 'not-an-element', { id: 'real' }];

    expect(() => snapshotElements(elements)).not.toThrow();
    expect(snapshotElements(elements)).toHaveLength(4);
  });

  it('returns a new array rather than mutating the caller', () => {
    const elements = [{ id: 'live' }, { id: 'gone', isDeleted: true }];

    const result = snapshotElements(elements);

    expect(elements).toHaveLength(2);
    expect(result).not.toBe(elements);
  });

  it('shrinks the payload it produces', () => {
    // The point of the filter: a board of mostly tombstones stores far less.
    const stroke = (id: string, isDeleted: boolean) => ({
      id,
      isDeleted,
      points: Array.from({ length: 300 }, (_, i) => [i, i]),
    });
    const elements = [stroke('live', false), stroke('a', true), stroke('b', true)];

    const before = JSON.stringify(elements).length;
    const after = JSON.stringify(snapshotElements(elements)).length;

    expect(after).toBeLessThan(before / 2);
  });
});
