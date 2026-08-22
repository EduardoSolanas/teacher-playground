import { describe, expect, it } from 'vitest';

import { cloneForYjs, valuesEqual } from './yjsValue';

const stroke = (n: number, shift = 0) =>
  Array.from({ length: n }, (_, i) => [i + shift, i * 2 + shift]);

describe('valuesEqual', () => {
  it('matches identical primitives and references', () => {
    expect(valuesEqual(1, 1)).toBe(true);
    expect(valuesEqual('a', 'a')).toBe(true);
    expect(valuesEqual(null, null)).toBe(true);
    const shared = { a: 1 };
    expect(valuesEqual(shared, shared)).toBe(true);
  });

  it('separates unequal primitives and mismatched types', () => {
    expect(valuesEqual(1, 2)).toBe(false);
    expect(valuesEqual(1, '1')).toBe(false);
    expect(valuesEqual(null, undefined)).toBe(false);
    expect(valuesEqual({ a: 1 }, 1)).toBe(false);
  });

  it('compares arrays element by element', () => {
    expect(valuesEqual([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(valuesEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(valuesEqual([1, [2, 3]], [1, [2, 4]])).toBe(false);
  });

  /*
   * The trap in comparing strokes cheaply: same length, same first and last
   * point, same bounding box — and a different drawing. Anything that answers
   * "equal" here stops the change syncing and the stroke silently never
   * reaches the other peer.
   */
  it('separates strokes that differ only in the middle', () => {
    const left = stroke(300);
    const right = stroke(300);
    right[150] = [999, 999];

    expect(valuesEqual(left, right)).toBe(false);
  });

  it('separates strokes of equal length and equal bounds', () => {
    const left = [[0, 0], [5, 10], [10, 10]];
    const right = [[0, 0], [9, 1], [10, 10]];

    expect(valuesEqual(left, right)).toBe(false);
  });

  it('compares objects by keys and values, not key order', () => {
    expect(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('treats two NaNs as equal, so a NaN coordinate does not republish forever', () => {
    expect(valuesEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(valuesEqual([Number.NaN], [Number.NaN])).toBe(true);
  });

  it('survives a cyclic structure rather than overflowing the stack', () => {
    const left: Record<string, unknown> = { a: 1 };
    left.self = left;
    const right: Record<string, unknown> = { a: 1 };
    right.self = right;

    expect(() => valuesEqual(left, right)).not.toThrow();
  });
});

describe('cloneForYjs', () => {
  it('returns primitives unchanged', () => {
    expect(cloneForYjs(5)).toBe(5);
    expect(cloneForYjs('x')).toBe('x');
    expect(cloneForYjs(null)).toBe(null);
    expect(cloneForYjs(undefined)).toBeUndefined();
  });

  it('deep copies, so later edits cannot reach into the document', () => {
    const source = { a: [1, 2], b: { c: 3 } };
    const copy = cloneForYjs(source) as typeof source;

    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    expect(copy.a).not.toBe(source.a);
    source.a[0] = 99;
    expect(copy.a[0]).toBe(1);
  });

  it('drops what JSON dropped: undefined members and functions', () => {
    const copy = cloneForYjs({ keep: 1, gone: undefined, fn: () => {} }) as Record<string, unknown>;

    expect(copy).toEqual({ keep: 1 });
    expect('gone' in copy).toBe(false);
    expect('fn' in copy).toBe(false);
  });

  it('keeps array holes and functions as null, the way JSON did', () => {
    expect(cloneForYjs([1, undefined, 2])).toEqual([1, null, 2]);
  });

  it('returns undefined for a cyclic value rather than throwing', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;

    expect(cloneForYjs(cyclic)).toBeUndefined();
  });
});
