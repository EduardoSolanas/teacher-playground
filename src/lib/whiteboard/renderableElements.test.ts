import { describe, expect, it } from 'vitest';

import { withRenderableGeometry } from './renderableElements';

describe('withRenderableGeometry', () => {
  it('gives an element a transparent background when the scene omitted it', () => {
    const input = [{ id: 'r', type: 'rectangle', width: 10, height: 10 }];
    const [rectangle] = withRenderableGeometry(input);

    expect((rectangle as unknown as { backgroundColor: unknown }).backgroundColor)
      .toBe('transparent');
    expect((input[0] as { backgroundColor?: unknown }).backgroundColor).toBeUndefined();
  });

  it('gives a linear element a single origin point and a freedraw none at all', () => {
    /*
     * Excalidraw reads `element.points.length` for line and arrow without
     * checking the field is there (scene/Shape.ts), and its bounds then
     * destructure `points[0]`, so an empty list is as fatal as a missing one.
     * One element in that state throws out of the render and takes the whole
     * board down with it -- for every peer, not just the one holding it.
     */
    const [arrow] = withRenderableGeometry([{ id: 'a', type: 'arrow' }]);
    expect((arrow as unknown as { points: unknown }).points).toEqual([[0, 0]]);

    const [line] = withRenderableGeometry([{ id: 'l', type: 'line' }]);
    expect((line as unknown as { points: unknown }).points).toEqual([[0, 0]]);

    /*
     * A freedraw reads `pressures[i]` for every point once it has one, and a
     * repaired element has no pressures, so empty is the safe answer here: the
     * shape falls back to its own default point without touching them.
     */
    const [draw] = withRenderableGeometry([{ id: 'f', type: 'freedraw' }]);
    expect((draw as unknown as { points: unknown }).points).toEqual([]);
  });

  it('repairs a linear element whose point list is empty', () => {
    const [line] = withRenderableGeometry([{ id: 'l', type: 'line', points: [] }]);
    expect((line as unknown as { points: unknown }).points).toEqual([[0, 0]]);
  });

  it('leaves real points alone', () => {
    const points = [[0, 0], [10, 10]];
    const [arrow] = withRenderableGeometry([{ id: 'a', type: 'arrow', points }]);
    expect((arrow as unknown as { points: unknown }).points).toBe(points);
  });

  it('replaces points that are present but not an array', () => {
    // A string has a length, so it survives the `.length` read and fails later
    // and less legibly, inside the geometry itself.
    const [arrow] = withRenderableGeometry([{ id: 'a', type: 'arrow', points: 'AQID' }]);
    expect((arrow as unknown as { points: unknown }).points).toEqual([[0, 0]]);
  });

  it('does not touch elements that carry no geometry', () => {
    const rect = { id: 'r', type: 'rectangle', width: 10, height: 10, backgroundColor: 'transparent' };
    const [out] = withRenderableGeometry([rect]);
    expect(out).toBe(rect);
    expect('points' in (out as object)).toBe(false);
  });

  it('fills a transparent background for every kind the editor fills', () => {
    for (const type of ['rectangle', 'iframe', 'embeddable', 'ellipse', 'diamond']) {
      const [element] = withRenderableGeometry([{ id: type, type }]);
      expect((element as { backgroundColor?: unknown }).backgroundColor, type).toBe('transparent');
    }

    const [line] = withRenderableGeometry([{ id: 'l', type: 'line', points: [[0, 0]] }]);
    expect((line as { backgroundColor?: unknown }).backgroundColor).toBe('transparent');

    const [draw] = withRenderableGeometry([{ id: 'f', type: 'freedraw', points: [[0, 0]] }]);
    expect((draw as { backgroundColor?: unknown }).backgroundColor).toBe('transparent');
  });

  it('keeps every other field on a repaired element', () => {
    const [element] = withRenderableGeometry([
      { id: 'a', type: 'arrow', x: 5, y: 6, width: 7, height: 8, seed: 9 },
    ]);
    expect(element).toMatchObject({ id: 'a', type: 'arrow', x: 5, y: 6, width: 7, height: 8, seed: 9 });
  });

  it('does not invent geometry for an element that only lost its background', () => {
    const [element] = withRenderableGeometry([{ id: 'r', type: 'rectangle', width: 10, height: 10 }]);
    expect('points' in (element as object)).toBe(false);
  });

  it('replaces a background colour that is present but blank', () => {
    const [element] = withRenderableGeometry([{ id: 'r', type: 'rectangle', backgroundColor: '' }]);
    expect((element as { backgroundColor?: unknown }).backgroundColor).toBe('transparent');
  });

  it('does not invent a background for an element that only lost its points', () => {
    const [element] = withRenderableGeometry([{ id: 'a', type: 'arrow' }]);
    expect((element as { backgroundColor?: unknown }).backgroundColor).toBeUndefined();
  });

  it('does not mutate or rebuild the array it was given when repairing', () => {
    const input = [{ id: 'a', type: 'arrow' }];
    const output = withRenderableGeometry(input);

    expect(output).not.toBe(input);
    expect((input[0] as { points?: unknown }).points).toBeUndefined();
    expect((output[0] as unknown as { points: unknown }).points).toEqual([[0, 0]]);
  });

  it('leaves renderable elements after a broken one untouched', () => {
    const rect = { id: 'r', type: 'rectangle', width: 10, height: 10, backgroundColor: 'transparent' };
    const output = withRenderableGeometry([{ id: 'a', type: 'arrow' }, rect]);

    expect((output[0] as { points?: unknown }).points).toEqual([[0, 0]]);
    expect(output[1]).toBe(rect);
    expect('points' in (output[1] as object)).toBe(false);
  });

  it('ignores null and primitive entries without throwing or rebuilding', () => {
    const input = [null, undefined, 42, 'arrow'] as unknown[];
    expect(withRenderableGeometry(input)).toBe(input);
  });

  it('returns the same array when everything is already renderable', () => {
    // The hot path is a scene that is fine. Rebuilding it on every remote
    // update would copy the whole board for nothing.
    const input = [
      { id: 'r', type: 'rectangle', backgroundColor: 'transparent' },
      { id: 'a', type: 'arrow', points: [[0, 0]], backgroundColor: 'transparent' },
    ];
    expect(withRenderableGeometry(input)).toBe(input);
  });
});
