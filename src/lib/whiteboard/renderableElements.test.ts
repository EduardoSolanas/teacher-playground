import { describe, expect, it } from 'vitest';

import { withRenderableGeometry } from './renderableElements';

describe('withRenderableGeometry', () => {
  it('gives a linear element empty points rather than none at all', () => {
    /*
     * Excalidraw reads `element.points.length` for line and arrow without
     * checking the field is there (scene/Shape.ts). It does so while walking
     * the whole scene, so one element missing points throws out of the render
     * and takes the entire board down with it -- for every peer, not just the
     * one holding the broken element.
     */
    const [arrow] = withRenderableGeometry([{ id: 'a', type: 'arrow' }]);
    expect((arrow as unknown as { points: unknown }).points).toEqual([]);

    const [line] = withRenderableGeometry([{ id: 'l', type: 'line' }]);
    expect((line as unknown as { points: unknown }).points).toEqual([]);

    const [draw] = withRenderableGeometry([{ id: 'f', type: 'freedraw' }]);
    expect((draw as unknown as { points: unknown }).points).toEqual([]);
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
    expect((arrow as unknown as { points: unknown }).points).toEqual([]);
  });

  it('does not touch elements that carry no geometry', () => {
    const rect = { id: 'r', type: 'rectangle', width: 10, height: 10 };
    const [out] = withRenderableGeometry([rect]);
    expect(out).toBe(rect);
    expect('points' in (out as object)).toBe(false);
  });

  it('does not mutate or rebuild the array it was given when repairing', () => {
    const input = [{ id: 'a', type: 'arrow' }];
    const output = withRenderableGeometry(input);

    expect(output).not.toBe(input);
    expect((input[0] as { points?: unknown }).points).toBeUndefined();
    expect((output[0] as unknown as { points: unknown }).points).toEqual([]);
  });

  it('leaves renderable elements after a broken one untouched', () => {
    const rect = { id: 'r', type: 'rectangle', width: 10, height: 10 };
    const output = withRenderableGeometry([{ id: 'a', type: 'arrow' }, rect]);

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
    const input = [{ id: 'r', type: 'rectangle' }, { id: 'a', type: 'arrow', points: [] }];
    expect(withRenderableGeometry(input)).toBe(input);
  });
});
