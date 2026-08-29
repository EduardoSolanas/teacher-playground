import { describe, expect, it } from 'vitest';

import {
  formatIncrementComparisonWarning,
  incrementSceneChange,
  isRemoteIncrement,
  publishCandidatesEqual,
  updateVersionBaselineFromIncrement,
} from './incrementSync';
import { diffScene } from './scenePublish';

const event = (changes: {
  added?: string[];
  removed?: string[];
  updated?: string[];
}) => ({
  elementsChange: {
    added: new Map((changes.added ?? []).map((id) => [id, {}])),
    removed: new Map((changes.removed ?? []).map((id) => [id, {}])),
    updated: new Map((changes.updated ?? []).map((id) => [id, {}])),
  },
});

describe('Excalidraw increment sync', () => {
  it('selects complete current elements for added and updated ids', () => {
    const elements = [
      { id: 'old', type: 'rectangle', version: 1 },
      { id: 'updated', type: 'rectangle', version: 2, x: 40 },
      { id: 'added', type: 'ellipse', version: 1 },
    ];

    expect(incrementSceneChange(event({ added: ['added'], updated: ['updated'] }), elements))
      .toEqual({
        elements: [elements[1], elements[2]],
        wholeScene: false,
      });
  });

  it('uses the whole current scene when an element was removed', () => {
    const elements = [
      { id: 'survivor', type: 'rectangle', version: 3 },
    ];

    expect(incrementSceneChange(event({ removed: ['deleted'] }), elements))
      .toEqual({ elements, wholeScene: true });
  });

  it('compares the exact payload shape and sweep mode', () => {
    expect(publishCandidatesEqual(
      { elements: [{ id: 'a', type: 'rectangle' }], wholeScene: false },
      { elements: [{ id: 'a', type: 'rectangle' }], wholeScene: false },
    )).toBe(true);
    expect(publishCandidatesEqual(
      { elements: [{ id: 'a', type: 'rectangle' }], wholeScene: false },
      { elements: [{ id: 'a', type: 'rectangle' }], wholeScene: true },
    )).toBe(false);
  });

  it('formats a redacted structured mismatch warning without scene contents', () => {
    const warning = formatIncrementComparisonWarning(
      { elements: [{ id: 'legacy', type: 'rectangle', text: 'private answer' }], wholeScene: false },
      { elements: [], wholeScene: false },
    );

    expect(warning).toContain('"event":"whiteboard_increment_mismatch"');
    expect(warning).toContain('"legacyCount":1');
    expect(warning).toContain('"incrementCount":0');
    expect(warning).not.toContain('private answer');
  });

  it('recognizes only the explicit remote increment source', () => {
    expect(isRemoteIncrement({ ...event({ added: ['remote'] }), source: 'remote' })).toBe(true);
    expect(isRemoteIncrement({ ...event({ added: ['local'] }), source: undefined })).toBe(false);
    expect(isRemoteIncrement({ ...event({ added: ['local'] }), source: 'api' })).toBe(false);
  });

  it('drops an element that left the scene, however the increment reported it', () => {
    /*
     * Defence, not a reported bug: a user erase satisfies Excalidraw's
     * `satisfiesRemoval` and arrives in `removed`, which is already handled.
     *
     * The property is held anyway because the failure mode is silent and
     * permanent. diffScene reports a removal by finding a baseline id absent
     * from the scene, so one stale entry latches `wholeScene: true` for the
     * rest of the session -- every later publish sending the whole board
     * instead of the element that moved, which is the exact cost this work set
     * out to reduce. Whichever bucket an increment uses, the baseline must
     * never keep an id the scene no longer has.
     */
    const baseline = new Map([['erased', 1], ['kept', 1]]);
    const scene = [{ id: 'kept', version: 1 }];

    const next = updateVersionBaselineFromIncrement(
      baseline,
      event({ added: [], removed: [], updated: ['erased'] }),
      scene,
    );

    expect(next.has('erased')).toBe(false);
    expect(diffScene(next, scene).removed).toBe(false);
  });

  it('updates only changed ids in the published version baseline', () => {
    const baseline = new Map([
      ['keep', 1],
      ['updated', 1],
      ['deleted', 1],
    ]);
    const elements = [
      { id: 'keep', version: 1 },
      { id: 'updated', version: 2 },
      { id: 'added', version: 1 },
    ];

    expect(updateVersionBaselineFromIncrement(
      baseline,
      event({ added: ['added'], removed: ['deleted'], updated: ['updated'] }),
      elements,
    )).toEqual(new Map([
      ['keep', 1],
      ['updated', 2],
      ['added', 1],
    ]));
    expect(baseline).toEqual(new Map([
      ['keep', 1],
      ['updated', 1],
      ['deleted', 1],
    ]));
  });
});
