import { describe, expect, it } from 'vitest';

import {
  LONG_STROKE_COMMIT_INTERVAL_MS,
  LONG_STROKE_POINTS,
  STROKE_COMMIT_INTERVAL_MS,
  livePointCount,
  strokeCommitIntervalMs,
} from './strokeCadence';

describe('strokeCommitIntervalMs', () => {
  it('leaves an ordinary stroke at the cadence it always had', () => {
    // Handwriting is short strokes, and they must look exactly as before:
    // this is the case that decides whether the board feels live.
    expect(strokeCommitIntervalMs(0)).toBe(STROKE_COMMIT_INTERVAL_MS);
    expect(strokeCommitIntervalMs(1)).toBe(STROKE_COMMIT_INTERVAL_MS);
    expect(strokeCommitIntervalMs(LONG_STROKE_POINTS)).toBe(STROKE_COMMIT_INTERVAL_MS);
  });

  it('widens once past the threshold', () => {
    expect(strokeCommitIntervalMs(LONG_STROKE_POINTS + 1)).toBe(LONG_STROKE_COMMIT_INTERVAL_MS);
    expect(strokeCommitIntervalMs(5_000)).toBe(LONG_STROKE_COMMIT_INTERVAL_MS);
  });
});

describe('livePointCount', () => {
  it('reads the stroke under the pointer, which is the last element', () => {
    expect(livePointCount([
      { points: [[0, 0], [1, 1], [2, 2]] },
      { points: [[0, 0]] },
    ])).toBe(1);
  });

  it('answers zero for anything that is not a stroke', () => {
    // Rectangles and text carry no points, and an empty scene has no last
    // element at all. Neither may throw on the drawing path.
    expect(livePointCount([])).toBe(0);
    expect(livePointCount([{ type: 'rectangle' }])).toBe(0);
    expect(livePointCount([{ points: 'not-an-array' }])).toBe(0);
    expect(livePointCount([null])).toBe(0);
    expect(livePointCount([undefined])).toBe(0);
  });
});
