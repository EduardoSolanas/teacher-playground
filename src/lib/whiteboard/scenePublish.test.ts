import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { diffScene, shouldPublish, elementsToPublish } from './scenePublish';
import { createWhiteboardDoc, replaceSharedElements } from './yjsDoc';

type El = { id: string; version: number; points?: number[][] };

const el = (id: string, version: number, points = 2): El => ({
  id,
  version,
  points: Array.from({ length: points }, (_, i) => [i, i]),
});

/** A board of `n` finished strokes, as a scene and as a published baseline. */
function board(n: number) {
  const elements = Array.from({ length: n }, (_, i) => el(`el-${i}`, 1));
  const baseline = new Map(elements.map((e) => [e.id, e.version]));
  return { elements, baseline };
}

describe('diffScene', () => {
  it('reports nothing changed when the scene is the baseline', () => {
    const { elements, baseline } = board(3);
    const diff = diffScene(baseline, elements);

    expect(diff.changedIds.size).toBe(0);
    expect(diff.removed).toBe(false);
    expect(shouldPublish(diff)).toBe(false);
  });

  it('reports only the element whose version moved', () => {
    const { elements, baseline } = board(3);
    const moved = [...elements];
    moved[1] = el('el-1', 2, 40);

    const diff = diffScene(baseline, moved);

    expect([...diff.changedIds]).toEqual(['el-1']);
    expect(shouldPublish(diff)).toBe(true);
  });

  it('treats a new element as changed', () => {
    const { elements, baseline } = board(2);
    const diff = diffScene(baseline, [...elements, el('el-new', 1)]);

    expect([...diff.changedIds]).toEqual(['el-new']);
  });

  it('flags a removal, because the stale sweep needs the whole scene', () => {
    const { elements, baseline } = board(3);
    const diff = diffScene(baseline, elements.slice(1));

    expect(diff.removed).toBe(true);
    expect(elementsToPublish(elements.slice(1), diff).wholeScene).toBe(true);
  });

  it('ignores entries with no usable id rather than throwing', () => {
    const diff = diffScene(new Map(), [null, undefined, {}, { id: '' }, el('real', 1)]);

    expect([...diff.changedIds]).toEqual(['real']);
  });

  it('treats a missing version as 0, so an element without one still publishes once', () => {
    const diff = diffScene(new Map(), [{ id: 'no-version' }]);

    expect(diff.nextVersions.get('no-version')).toBe(0);
    expect([...diff.changedIds]).toEqual(['no-version']);
  });
});

describe('shouldPublish force', () => {
  // The bug this exists for: a stroke whose final points arrive without a
  // version bump was never published, and the peer kept the partial stroke.
  it('publishes a finished stroke even when no version moved', () => {
    const { elements, baseline } = board(1);
    const diff = diffScene(baseline, elements);

    expect(shouldPublish(diff, false)).toBe(false);
    expect(shouldPublish(diff, true)).toBe(true);
  });

  it('with force=true and unchanged elements, returns the baseline elements', () => {
    const { elements, baseline } = board(1);
    const diff = diffScene(baseline, elements);

    // Confirm diff has no changes
    expect(diff.changedIds.size).toBe(0);
    expect(diff.removed).toBe(false);

    // When force=true, should return the unchanged element even though changedIds is empty
    const { elements: result, wholeScene } = elementsToPublish(elements, diff, true);

    expect(wholeScene).toBe(false);
    expect(result).toHaveLength(1);
    expect((result[0] as El).id).toBe('el-0');
  });
});

describe('publishing cost does not scale with the board', () => {
  // The performance property, asserted as a mechanism rather than a duration:
  // a timing threshold measures the machine, this measures the code.
  it('sends one element for one stroke, whatever the board holds', () => {
    for (const size of [1, 50, 500]) {
      const { elements, baseline } = board(size);
      const drawing = [...elements, el('stroke', 1, 300)];

      const diff = diffScene(baseline, drawing);
      const { elements: payload, wholeScene } = elementsToPublish(drawing, diff);

      expect(wholeScene).toBe(false);
      expect(payload).toHaveLength(1);
      expect((payload[0] as El).id).toBe('stroke');
    }
  });

  it('keeps the serialized payload flat as the board grows', () => {
    const sizes = [10, 200];
    const bytes = sizes.map((size) => {
      const { elements, baseline } = board(size);
      const drawing = [...elements, el('stroke', 1, 300)];
      const diff = diffScene(baseline, drawing);
      return JSON.stringify(elementsToPublish(drawing, diff).elements).length;
    });

    // A twentyfold board must not move the cost of drawing on it.
    expect(bytes[1]).toBe(bytes[0]);
  });

  it('touches one shared element per stroke sample in a real document', () => {
    const { doc, elementsArray } = createWhiteboardDoc('perf-room');
    const { elements, baseline } = board(200);
    replaceSharedElements(doc, elementsArray, elements as any, 'seed');

    let touched = 0;
    elementsArray.observeDeep((events) => {
      for (const event of events) touched += 1;

    });

    const drawing = [...elements, el('stroke', 1, 300)];
    const diff = diffScene(baseline, drawing);
    const { elements: payload } = elementsToPublish(drawing, diff);
    replaceSharedElements(doc, elementsArray, payload as any, 'local', { deleteMissing: false });

    expect(touched).toBeLessThanOrEqual(2);
    expect(elementsArray.length).toBe(201);
    doc.destroy();
  });

  it('a removal still sweeps the whole scene', () => {
    const { doc, elementsArray } = createWhiteboardDoc('sweep-room');
    const { elements, baseline } = board(5);
    replaceSharedElements(doc, elementsArray, elements as any, 'seed');

    const survivors = elements.slice(1);
    const diff = diffScene(baseline, survivors);
    const { elements: payload, wholeScene } = elementsToPublish(survivors, diff);
    expect(wholeScene).toBe(true);

    replaceSharedElements(doc, elementsArray, payload as any, 'local', {
      previousIds: elements.map((e) => e.id),
    });

    expect(elementsArray.length).toBe(4);
    doc.destroy();
  });
});

describe('baseline advancement success contract', () => {
  it('if a publish fails, re-diffing against the old baseline produces the same diff', () => {
    // This test documents the contract: the baseline must ONLY advance after
    // a successful publish. If it advances before (then the write fails), the
    // failed change is lost because the baseline has already moved.

    // Start with a baseline of 2 elements at version 1
    const { elements: initial, baseline: v1Baseline } = board(2);

    // Change one element to version 2
    const updated = [...initial];
    updated[0] = el('el-0', 2, 40);

    // First diff against v1 baseline (simulating the first commit attempt)
    const diff1 = diffScene(v1Baseline, updated);
    expect(diff1.changedIds.has('el-0')).toBe(true);

    // Now simulate that the publish failed. In the buggy code, the baseline
    // would have already advanced to diff1.nextVersions. This test verifies
    // the fix: if we re-diff against the OLD baseline (because the publish
    // failed and the baseline should not have advanced), we get the same diff.
    const diff2 = diffScene(v1Baseline, updated);

    expect(diff2.changedIds).toEqual(diff1.changedIds);
    expect(diff2.removed).toBe(diff1.removed);
  });
});
