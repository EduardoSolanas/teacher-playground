/*
 * Mutation note (AGENTS.md): the following survivors in documentPageGuard.ts
 * were investigated by hand-applying each mutation and re-running this
 * suite; each is a genuine equivalent (no test can observe a difference), or
 * a Stryker duplicate-mutant artifact (a byte-identical mutation at the same
 * location that a *different* mutant id, at the same line/column, already
 * demonstrably kills -- confirmed by hand-applying it too).
 *
 * Genuine equivalents:
 * - `applyFrameDecisionToList`'s `typeof element.id === 'string' ? element.id
 *   : undefined` (documentPageGuard.ts line ~168): forcing the ternary to
 *   always take the `element.id` branch is unobservable. `decision.restore`
 *   and `decision.removeCreatedIds` are always built from real string ids
 *   (guarded the same way at the `frameFromElementLists` indexing step), so
 *   they can never contain a non-string key. Whatever a malformed
 *   `element.id` evaluates to under the mutant, `removeIds.has(id)` and
 *   `decision.restore.get(id)` still never match -- the same "leave the
 *   element alone" outcome the `undefined` fallback produces.
 * - `applyPageGuardDecision`'s `if (id) byId.set(id, ...)` (line ~326): an
 *   id-less element indexed under the key `undefined` is never observably
 *   different, because `decision.restore` / `decision.removeCreatedIds` are
 *   real string ids and never look up `undefined`.
 * - `applyPageGuardDecision`'s `if (decision.reinsert.size > 0) { ... }`
 *   (line ~349): `elementsArray.push([])` with no elements to re-insert is a
 *   verified no-op (confirmed experimentally: it neither changes the array's
 *   length nor fires an extra `afterTransaction`), so skipping the empty
 *   push changes nothing observable.
 * - `elementId`'s `id.length > 0` clause, specifically the `>= 0` /
 *   always-true mutants at documentPageGuard.ts line ~190 (NOT the `typeof
 *   id === 'string'` clause, which the "id is a number" test below does
 *   kill): every caller of `elementId` gates on `if (id)` / `if (!id)`, a
 *   plain truthiness test. This sub-clause only changes behaviour when `id`
 *   is exactly `''`, and `elementId` then returns `''` instead of
 *   `undefined` -- both are falsy, so every caller treats them identically.
 *
 * Stryker duplicate-mutant artifacts (verified by hand-applying the
 * identical mutation and confirming it fails the test the `Killed` twin at
 * the same location fails):
 * - `frameFromElementLists`'s two `if (typeof element.id === 'string' &&
 *   element.id.length > 0)` guards (lines ~116 and ~120): the "ignores an
 *   element with no id or an empty id" tests below kill the mutation when
 *   hand-applied; Stryker reports one instance killed and a byte-identical
 *   second instance at the same line:column survived.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  carriesPdfPage,
  decideFrame,
  recordPageGuardFrame,
  applyPageGuardDecision,
  enforcePageGuard,
  frameFromElementLists,
  applyFrameDecisionToList,
  type FrameRecord,
  type ElementRecord,
} from './documentPageGuard';

function docWithArray(): { doc: Y.Doc; elements: Y.Array<Y.Map<unknown>> } {
  const doc = new Y.Doc();
  const elements = doc.getArray<Y.Map<unknown>>('elements');
  return { doc, elements };
}

function pushElement(
  elements: Y.Array<Y.Map<unknown>>,
  data: Record<string, unknown>,
): void {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(data)) map.set(key, value);
  elements.push([map]);
}

function readElements(elements: Y.Array<Y.Map<unknown>>): Record<string, unknown>[] {
  return elements.toArray().map((map) => {
    const out: Record<string, unknown> = {};
    map.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  });
}

describe('carriesPdfPage', () => {
  it('is true when the key is present and not null, whatever its shape', () => {
    expect(carriesPdfPage({ pdfPage: { importId: 'a', index: 0 } })).toBe(true);
    expect(carriesPdfPage({ pdfPage: 'not-an-object-but-still-present' })).toBe(true);
    expect(carriesPdfPage({ pdfPage: 0 })).toBe(true);
  });

  it('is false when the key is absent, null, or customData is not an object', () => {
    expect(carriesPdfPage({})).toBe(false);
    expect(carriesPdfPage({ pdfPage: null })).toBe(false);
    expect(carriesPdfPage(undefined)).toBe(false);
    expect(carriesPdfPage(null)).toBe(false);
    expect(carriesPdfPage('nope')).toBe(false);
  });
});

describe('decideFrame (pure)', () => {
  it('refuses every touched key of an element that already carried pdfPage', () => {
    const frame: FrameRecord = {
      changed: new Map([
        [
          'page-1',
          {
            changedKeys: new Map<string, unknown>([
              ['x', 10],
              ['locked', true],
            ]),
            beforeCustomData: { pdfPage: { importId: 'a', index: 0 } },
            afterCustomData: { pdfPage: { importId: 'a', index: 0 } },
          },
        ],
      ]),
      created: new Map(),
      removed: new Map(),
    };
    const decision = decideFrame(frame);
    expect(decision.restore.get('page-1')).toEqual(new Map<string, unknown>([['x', 10], ['locked', true]]));
  });

  it('refuses only customData when it is what added the pdfPage stamp', () => {
    const frame: FrameRecord = {
      changed: new Map([
        [
          'plain-1',
          {
            changedKeys: new Map([['customData', undefined]]),
            beforeCustomData: undefined,
            afterCustomData: { pdfPage: { importId: 'a', index: 0 } },
          },
        ],
      ]),
      created: new Map(),
      removed: new Map(),
    };
    const decision = decideFrame(frame);
    expect(decision.restore.get('plain-1')).toEqual(new Map([['customData', undefined]]));
  });

  it('leaves an ordinary element change alone', () => {
    const frame: FrameRecord = {
      changed: new Map([
        [
          'stroke-1',
          {
            changedKeys: new Map([['x', 1]]),
            beforeCustomData: undefined,
            afterCustomData: undefined,
          },
        ],
      ]),
      created: new Map(),
      removed: new Map(),
    };
    expect(decideFrame(frame).restore.size).toBe(0);
  });

  it('marks a created page element for removal, and leaves an ordinary created element alone', () => {
    const frame: FrameRecord = {
      changed: new Map(),
      created: new Map([
        ['page-new', { id: 'page-new', customData: { pdfPage: { importId: 'a', index: 1 } } }],
        ['stroke-new', { id: 'stroke-new', customData: undefined }],
      ]),
      removed: new Map(),
    };
    const decision = decideFrame(frame);
    expect(decision.removeCreatedIds).toEqual(['page-new']);
  });

  it('marks a removed page element for re-insertion, and leaves an ordinary removal alone', () => {
    const pageContent = { id: 'page-gone', x: 5, customData: { pdfPage: { importId: 'a', index: 0 } } };
    const frame: FrameRecord = {
      changed: new Map(),
      created: new Map(),
      removed: new Map<string, ElementRecord>([
        ['page-gone', pageContent],
        ['stroke-gone', { id: 'stroke-gone', customData: undefined }],
      ]),
    };
    const decision = decideFrame(frame);
    expect(decision.reinsert.get('page-gone')).toBe(pageContent);
    expect(decision.reinsert.has('stroke-gone')).toBe(false);
  });

  it('does not refuse an unrelated key change just because customData elsewhere carries a stamp', () => {
    // customData was not among the touched keys, so whatever afterCustomData
    // holds is irrelevant -- only a genuine customData change can add a stamp.
    const frame: FrameRecord = {
      changed: new Map([
        [
          'plain-1',
          {
            changedKeys: new Map<string, unknown>([['x', 1]]),
            beforeCustomData: undefined,
            afterCustomData: { pdfPage: { importId: 'a', index: 0 } },
          },
        ],
      ]),
      created: new Map(),
      removed: new Map(),
    };
    expect(decideFrame(frame).restore.size).toBe(0);
  });
});

describe('recordPageGuardFrame (Yjs adapter)', () => {
  it('records a changed key on an existing element, with its old value', () => {
    const { elements } = docWithArray();
    pushElement(elements, { id: 'page-1', x: 0, customData: { pdfPage: { importId: 'a', index: 0 } } });

    const frame = recordPageGuardFrame(elements, () => {
      elements.get(0).set('x', 99);
    });

    const change = frame.changed.get('page-1');
    expect(change?.changedKeys.get('x')).toBe(0);
    expect(carriesPdfPage(change?.beforeCustomData)).toBe(true);
  });

  it('records customData before/after when the stamp is added to a plain element', () => {
    const { elements } = docWithArray();
    pushElement(elements, { id: 'plain-1', x: 0 });

    const frame = recordPageGuardFrame(elements, () => {
      elements.get(0).set('customData', { pdfPage: { importId: 'a', index: 2 } });
    });

    const change = frame.changed.get('plain-1');
    expect(carriesPdfPage(change?.beforeCustomData)).toBe(false);
    expect(carriesPdfPage(change?.afterCustomData)).toBe(true);
  });

  it('records a newly created element', () => {
    const { elements } = docWithArray();

    const frame = recordPageGuardFrame(elements, () => {
      pushElement(elements, { id: 'page-new', customData: { pdfPage: { importId: 'a', index: 1 } } });
    });

    expect(frame.created.get('page-new')).toMatchObject({ id: 'page-new' });
  });

  it('records a removed element with its full old content, still readable after deletion', () => {
    const { elements } = docWithArray();
    pushElement(elements, {
      id: 'page-gone',
      x: 7,
      y: 8,
      customData: { pdfPage: { importId: 'a', index: 3 } },
    });

    const frame = recordPageGuardFrame(elements, () => {
      elements.delete(0, 1);
    });

    expect(frame.removed.get('page-gone')).toEqual({
      id: 'page-gone',
      x: 7,
      y: 8,
      customData: { pdfPage: { importId: 'a', index: 3 } },
    });
  });

  it('does not record the server sanitize transactions that run outside apply', () => {
    const { elements } = docWithArray();
    pushElement(elements, { id: 'page-1', customData: { pdfPage: { importId: 'a', index: 0 } } });

    const frame = recordPageGuardFrame(elements, () => {
      // The frame itself changes nothing.
    });
    // A change made after recording has stopped must never appear.
    elements.get(0).set('x', 123);

    expect(frame.changed.size).toBe(0);
    expect(frame.created.size).toBe(0);
    expect(frame.removed.size).toBe(0);
  });

  it('ignores a non-Y.Map value pushed into the array (a malformed entry)', () => {
    const { elements } = docWithArray();
    const frame = recordPageGuardFrame(elements, () => {
      (elements as unknown as Y.Array<unknown>).push(['not-a-map']);
    });
    expect(frame.created.size).toBe(0);
  });

  it('ignores a created element with no id', () => {
    const { elements } = docWithArray();
    const frame = recordPageGuardFrame(elements, () => {
      const map = new Y.Map<unknown>();
      map.set('type', 'rectangle');
      elements.push([map]);
    });
    expect(frame.created.size).toBe(0);
  });

  it('ignores a created element with an empty string id', () => {
    const { elements } = docWithArray();
    const frame = recordPageGuardFrame(elements, () => {
      pushElement(elements, { id: '', customData: { pdfPage: { importId: 'a', index: 0 } } });
    });
    expect(frame.created.size).toBe(0);
  });

  it('ignores a created element whose id is not a string (a hostile client could push any type)', () => {
    const { elements } = docWithArray();
    const frame = recordPageGuardFrame(elements, () => {
      // A truthy, non-string id: falsy-value guards downstream (`!id`) do not
      // catch this the way they catch a missing or empty id, so this is what
      // actually exercises the `typeof id === 'string'` check itself.
      pushElement(elements, { id: 42, customData: { pdfPage: { importId: 'a', index: 0 } } });
    });
    expect(frame.created.size).toBe(0);
  });

  it('ignores deletion of a non-Y.Map array entry, without crashing', () => {
    const { elements } = docWithArray();
    (elements as unknown as Y.Array<unknown>).push(['not-a-map']);
    const frame = recordPageGuardFrame(elements, () => {
      elements.delete(0, 1);
    });
    expect(frame.removed.size).toBe(0);
  });

  it('ignores a removed element with no id', () => {
    const { elements } = docWithArray();
    pushElement(elements, { x: 1 }); // no id field
    const frame = recordPageGuardFrame(elements, () => {
      elements.delete(0, 1);
    });
    expect(frame.removed.size).toBe(0);
  });

  it('ignores a removed element with an empty string id', () => {
    const { elements } = docWithArray();
    pushElement(elements, { id: '', x: 1 });
    const frame = recordPageGuardFrame(elements, () => {
      elements.delete(0, 1);
    });
    expect(frame.removed.size).toBe(0);
  });

  it('drops an element created and removed within the same frame from both created and removed', () => {
    const { elements } = docWithArray();
    const frame = recordPageGuardFrame(elements, () => {
      pushElement(elements, { id: 'ephemeral', customData: { pdfPage: { importId: 'a', index: 0 } } });
      elements.delete(0, 1);
    });
    expect(frame.created.has('ephemeral')).toBe(false);
    expect(frame.removed.has('ephemeral')).toBe(false);
  });

  it('ignores a deeply nested change that is not on a direct element map', () => {
    const { elements } = docWithArray();
    const outer = new Y.Map<unknown>();
    outer.set('id', 'outer-1');
    const nested = new Y.Map<unknown>();
    // Coincidentally sharing an id with something a naive id-lookup could
    // pick up, to prove the depth-1 guard -- not the id check -- is what
    // keeps this out of `changed`.
    nested.set('id', 'outer-1');
    nested.set('inner', 1);
    outer.set('nestedType', nested);
    elements.push([outer]);

    const frame = recordPageGuardFrame(elements, () => {
      nested.set('inner', 2);
    });

    expect(frame.changed.size).toBe(0);
  });

  it('ignores a changed key on a direct element map with no id', () => {
    const { elements } = docWithArray();
    pushElement(elements, { x: 1 }); // no id field
    const frame = recordPageGuardFrame(elements, () => {
      elements.get(0).set('x', 2);
    });
    expect(frame.changed.size).toBe(0);
  });

  it('accumulates changed keys across two separate transactions on the same element within one frame', () => {
    const { elements } = docWithArray();
    pushElement(elements, { id: 'e1', x: 1, y: 2 });

    const frame = recordPageGuardFrame(elements, () => {
      elements.get(0).set('x', 99); // transaction 1: oldValue 1
      elements.get(0).set('y', 88); // transaction 2: oldValue 2
    });

    const change = frame.changed.get('e1');
    expect(change?.changedKeys.get('x')).toBe(1);
    expect(change?.changedKeys.get('y')).toBe(2);
  });

  it('keeps the earliest old value when the same key changes twice within one frame', () => {
    const { elements } = docWithArray();
    pushElement(elements, { id: 'e1', x: 0 });

    const frame = recordPageGuardFrame(elements, () => {
      elements.get(0).set('x', 5); // transaction 1: oldValue 0
      elements.get(0).set('x', 10); // transaction 2: oldValue 5
    });

    expect(frame.changed.get('e1')?.changedKeys.get('x')).toBe(0);
  });
});

describe('applyPageGuardDecision', () => {
  it('restores a changed key, deleting it when it did not exist before the frame', () => {
    const { doc, elements } = docWithArray();
    pushElement(elements, { id: 'page-1', x: 0, customData: { pdfPage: { importId: 'a', index: 0 } } });

    elements.get(0).set('x', 99);
    elements.get(0).set('locked', true); // did not exist before

    applyPageGuardDecision(doc, elements, {
      restore: new Map([
        ['page-1', new Map<string, unknown>([['x', 0], ['locked', undefined]])],
      ]),
      removeCreatedIds: [],
      reinsert: new Map(),
    });

    const [restored] = readElements(elements);
    expect(restored.x).toBe(0);
    expect('locked' in restored).toBe(false);
  });

  it('removes a created page element entirely', () => {
    const { doc, elements } = docWithArray();
    pushElement(elements, { id: 'stroke-1' });
    pushElement(elements, { id: 'page-new', customData: { pdfPage: { importId: 'a', index: 1 } } });

    applyPageGuardDecision(doc, elements, {
      restore: new Map(),
      removeCreatedIds: ['page-new'],
      reinsert: new Map(),
    });

    expect(readElements(elements).map((e) => e.id)).toEqual(['stroke-1']);
  });

  it('re-inserts a removed page element with its old content', () => {
    const { doc, elements } = docWithArray();
    pushElement(elements, { id: 'stroke-1' });

    applyPageGuardDecision(doc, elements, {
      restore: new Map(),
      removeCreatedIds: [],
      reinsert: new Map([
        ['page-gone', { id: 'page-gone', x: 7, customData: { pdfPage: { importId: 'a', index: 0 } } }],
      ]),
    });

    const ids = readElements(elements).map((e) => e.id);
    expect(ids).toContain('stroke-1');
    expect(ids).toContain('page-gone');
    const restored = readElements(elements).find((e) => e.id === 'page-gone');
    expect(restored).toEqual({ id: 'page-gone', x: 7, customData: { pdfPage: { importId: 'a', index: 0 } } });
  });

  it('is a no-op when nothing needs undoing', () => {
    const { doc, elements } = docWithArray();
    pushElement(elements, { id: 'stroke-1', x: 1 });
    const before = readElements(elements);

    applyPageGuardDecision(doc, elements, { restore: new Map(), removeCreatedIds: [], reinsert: new Map() });

    expect(readElements(elements)).toEqual(before);
  });

  it('opens no transaction at all when there is nothing to undo', () => {
    const { doc, elements } = docWithArray();
    pushElement(elements, { id: 'stroke-1', x: 1 });
    let transactions = 0;
    doc.on('afterTransaction', () => { transactions += 1; });

    applyPageGuardDecision(doc, elements, { restore: new Map(), removeCreatedIds: [], reinsert: new Map() });

    expect(transactions).toBe(0);
  });

  it('silently skips a restore whose id is no longer in the array', () => {
    const { doc, elements } = docWithArray();
    pushElement(elements, { id: 'other', x: 1 });

    expect(() => applyPageGuardDecision(doc, elements, {
      restore: new Map([['missing', new Map<string, unknown>([['x', 0]])]]),
      removeCreatedIds: [],
      reinsert: new Map(),
    })).not.toThrow();
  });

  it('silently skips a remove-created id that is no longer in the array', () => {
    const { doc, elements } = docWithArray();
    pushElement(elements, { id: 'other', x: 1 });

    expect(() => applyPageGuardDecision(doc, elements, {
      restore: new Map(),
      removeCreatedIds: ['missing'],
      reinsert: new Map(),
    })).not.toThrow();
  });

  it('removes multiple created page elements without corrupting the indexes of what is kept', () => {
    const { doc, elements } = docWithArray();
    pushElement(elements, { id: 'keep-1' });
    pushElement(elements, { id: 'page-a', customData: { pdfPage: { importId: 'a', index: 0 } } });
    pushElement(elements, { id: 'keep-2' });
    pushElement(elements, { id: 'page-b', customData: { pdfPage: { importId: 'a', index: 1 } } });
    pushElement(elements, { id: 'keep-3' });

    applyPageGuardDecision(doc, elements, {
      restore: new Map(),
      removeCreatedIds: ['page-a', 'page-b'],
      reinsert: new Map(),
    });

    expect(readElements(elements).map((e) => e.id)).toEqual(['keep-1', 'keep-2', 'keep-3']);
  });

  it('tags its transaction with the page-guard origin', () => {
    const { doc, elements } = docWithArray();
    pushElement(elements, { id: 'e1', x: 0, customData: { pdfPage: { importId: 'a', index: 0 } } });
    let origin: unknown;
    doc.on('afterTransaction', (transaction: { origin: unknown }) => { origin = transaction.origin; });

    applyPageGuardDecision(doc, elements, {
      restore: new Map([['e1', new Map<string, unknown>([['x', undefined]])]]),
      removeCreatedIds: [],
      reinsert: new Map(),
    });

    expect(origin).toBe('page-guard');
  });
});

describe('frameFromElementLists + applyFrameDecisionToList (HTTP scene route path)', () => {
  it('refuses a submitted move of an existing page, allows an ordinary stroke edit', () => {
    const stored = [
      { id: 'page-1', x: 0, y: 0, customData: { pdfPage: { importId: 'a', index: 0 } } },
      { id: 'stroke-1', x: 5 },
    ];
    const submitted = [
      { id: 'page-1', x: 999, y: 999, customData: { pdfPage: { importId: 'a', index: 0 } } },
      { id: 'stroke-1', x: 6 },
    ];

    const decision = decideFrame(frameFromElementLists(stored, submitted));
    const corrected = applyFrameDecisionToList(submitted, decision);

    const byId = new Map(corrected.map((e) => [e.id, e]));
    expect(byId.get('page-1')).toMatchObject({ x: 0, y: 0 });
    expect(byId.get('stroke-1')).toMatchObject({ x: 6 });
  });

  it('refuses a submitted new page element, keeps an ordinary new element', () => {
    const stored: Record<string, unknown>[] = [];
    const submitted = [
      { id: 'page-new', customData: { pdfPage: { importId: 'a', index: 0 } } },
      { id: 'stroke-new', x: 1 },
    ];

    const decision = decideFrame(frameFromElementLists(stored, submitted));
    const corrected = applyFrameDecisionToList(submitted, decision);

    expect(corrected.map((e) => e.id)).toEqual(['stroke-new']);
  });

  it('refuses a submitted removal of a page element, keeping it with its stored content', () => {
    const stored = [
      { id: 'page-1', x: 3, customData: { pdfPage: { importId: 'a', index: 0 } } },
      { id: 'stroke-1', x: 5 },
    ];
    const submitted = [{ id: 'stroke-1', x: 5 }];

    const decision = decideFrame(frameFromElementLists(stored, submitted));
    const corrected = applyFrameDecisionToList(submitted, decision);

    expect(corrected).toContainEqual({ id: 'page-1', x: 3, customData: { pdfPage: { importId: 'a', index: 0 } } });
    expect(corrected).toContainEqual({ id: 'stroke-1', x: 5 });
  });

  it('is a no-op when the submission matches what was stored', () => {
    const stored = [{ id: 'page-1', x: 0, customData: { pdfPage: { importId: 'a', index: 0 } } }];

    const decision = decideFrame(frameFromElementLists(stored, stored));
    const corrected = applyFrameDecisionToList(stored, decision);
    expect(corrected).toEqual(stored);
  });

  it('does not record a "changed" entry when nothing about the element actually differs', () => {
    const identical = { id: 'e1', x: 1, customData: null };
    const frame = frameFromElementLists([identical], [{ ...identical }]);
    expect(frame.changed.size).toBe(0);
    expect(frame.created.size).toBe(0);
    expect(frame.removed.size).toBe(0);
  });

  it('ignores an element with no id or an empty id in the "before" list', () => {
    const before = [{ id: '', x: 1 }, { id: 'kept', x: 9 }];
    const after = [{ id: 'kept', x: 9 }];
    // If the empty id were indexed, it would show up in `removed`; it must
    // not, because it was never a real element the room could track.
    expect(frameFromElementLists(before, after).removed.size).toBe(0);
  });

  it('ignores an element with no id or an empty id in the "after" list', () => {
    const before: Record<string, unknown>[] = [];
    const after = [{ id: '', x: 1 }];
    expect(frameFromElementLists(before, after).created.size).toBe(0);
  });

  it('deletes an added key entirely, rather than leaving it present with value undefined', () => {
    const after = [{ id: 'e1', x: 1, locked: true }];
    const decision = {
      restore: new Map([['e1', new Map<string, unknown>([['locked', undefined]])]]),
      removeCreatedIds: [],
      reinsert: new Map(),
    };
    const [corrected] = applyFrameDecisionToList(after, decision);
    expect('locked' in corrected).toBe(false);
  });
});

describe('enforcePageGuard (end to end on real Y.Docs)', () => {
  it('undoes a refused move on an existing page while leaving an ordinary stroke alone', () => {
    const { doc, elements } = docWithArray();
    pushElement(elements, { id: 'page-1', x: 0, y: 0, customData: { pdfPage: { importId: 'a', index: 0 } } });
    pushElement(elements, { id: 'stroke-1', x: 5 });

    enforcePageGuard(doc, elements, () => {
      elements.get(0).set('x', 999);
      elements.get(1).set('x', 6);
    });

    const byId = new Map(readElements(elements).map((e) => [e.id, e]));
    expect(byId.get('page-1')?.x).toBe(0);
    expect(byId.get('stroke-1')?.x).toBe(6);
  });

  it('undoes a refused pdfPage creation, removes just that element', () => {
    const { doc, elements } = docWithArray();

    enforcePageGuard(doc, elements, () => {
      pushElement(elements, { id: 'page-new', customData: { pdfPage: { importId: 'a', index: 0 } } });
      pushElement(elements, { id: 'stroke-1' });
    });

    expect(readElements(elements).map((e) => e.id)).toEqual(['stroke-1']);
  });

  it('undoes a refused removal of a page element', () => {
    const { doc, elements } = docWithArray();
    pushElement(elements, { id: 'page-1', customData: { pdfPage: { importId: 'a', index: 0 } } });

    enforcePageGuard(doc, elements, () => {
      elements.delete(0, 1);
    });

    expect(readElements(elements).map((e) => e.id)).toEqual(['page-1']);
  });

  it('leaves the owner-equivalent frame alone when there is nothing to enforce (allow path)', () => {
    const { doc, elements } = docWithArray();
    pushElement(elements, { id: 'stroke-1', x: 0 });

    const decision = enforcePageGuard(doc, elements, () => {
      elements.get(0).set('x', 42);
    });

    expect(decision.restore.size).toBe(0);
    expect(readElements(elements)[0].x).toBe(42);
  });
});
