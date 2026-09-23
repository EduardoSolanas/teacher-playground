/*
 * Mutation note (AGENTS.md): five survivors on this module are equivalent
 * and cannot be killed.
 *
 * - `pdfPageStampOf`'s `(pageCount as number) < 1` clause (pagedDocuments.ts
 *   line 66): dropping it changes nothing observable. Whenever pageCount is
 *   <= 0, the later `(index as number) >= (pageCount as number)` check
 *   rejects every possible index anyway, since index is already validated as
 *   a non-negative integer and a non-negative number is never smaller than a
 *   non-positive pageCount.
 * - `onPageStampOf`'s `typeof importId !== 'string'` clause (line 85):
 *   dropping it (while keeping the pattern check) cannot be observed either.
 *   The only way to exploit a missing type check is to pass a non-string
 *   whose `String(...)` form matches the 16-hex pattern (e.g. a 16-digit
 *   number); but the resulting `importId` keeps its original, non-string
 *   type, and every place it is later compared -- `Map.get` in `isHidden`,
 *   `===` in `idsFor` -- uses strict, type-sensitive equality, so it can
 *   never match a real (string-keyed) document.
 * - `showingIndex`'s `document.pages.has(requested)` early return (line
 *   179): removing it still finds the same page, because an exact match
 *   always has distance 0 in the nearest-page search loop below it, and 0 is
 *   always the unique minimum (Map keys are distinct), so the loop and the
 *   early return can never disagree.
 * - `showingIndex`'s `nearest === null` clause (line 185): `bestDistance`
 *   starts at `Infinity`, so `distance < bestDistance` is provably true on
 *   the very first loop iteration regardless of `nearest`, making the
 *   `nearest === null` clause redundant with it in every reachable case.
 * - `showingIndex`'s tie-break `index < nearest` vs `index <= nearest` (line
 *   185): `nearest` only ever holds a key already visited, and the current
 *   loop `index` is always a different Map key (keys are unique), so `index`
 *   can never equal `nearest` at the point of comparison -- `<=` and `<`
 *   agree on every input that can occur.
 */
import { describe, expect, it } from 'vitest';
import {
  annotationStampFor,
  elementsToMove,
  elementsToRemove,
  isHidden,
  nextPage,
  previousPage,
  showingIndex,
  stackedDocuments,
  type StackedDocument,
} from './pagedDocuments';

type Element = Record<string, unknown>;

const IMPORT_A = '0123456789abcdef';
const IMPORT_B = 'fedcba9876543210';

function stackedPage(
  id: string,
  importId: string,
  index: number,
  pageCount: number,
  rect: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 612, height: 792 },
  overrides: Element = {},
): Element {
  return {
    id,
    type: 'image',
    ...rect,
    customData: { pdfPage: { importId, index, pageCount, stacked: true } },
    isDeleted: false,
    ...overrides,
  };
}

function onPageElement(
  id: string,
  importId: string,
  index: number,
  rect: { x: number; y: number; width: number; height: number } = { x: 120, y: 220, width: 50, height: 50 },
  overrides: Element = {},
): Element {
  return {
    id,
    type: 'freedraw',
    ...rect,
    customData: { onPage: { importId, index } },
    isDeleted: false,
    ...overrides,
  };
}

function plainElement(id: string, rect: { x: number; y: number; width: number; height: number }): Element {
  return { id, type: 'freedraw', ...rect, isDeleted: false };
}

const DOC_RECT = { x: 100, y: 200, width: 612, height: 792 };

function threePageDoc(importId: string, livePages: readonly number[] = [0, 1, 2]): StackedDocument {
  const pages = new Map<number, string>();
  for (const index of livePages) pages.set(index, `p${index}`);
  return { importId, pageCount: 3, pages, rect: DOC_RECT };
}

describe('stackedDocuments', () => {
  it('groups live pages by importId, reporting pageCount and the shared rectangle', () => {
    const elements: Element[] = [
      stackedPage('p0', IMPORT_A, 0, 3, { x: 100, y: 200, width: 612, height: 792 }),
      stackedPage('p1', IMPORT_A, 1, 3, { x: 100, y: 200, width: 612, height: 792 }),
      stackedPage('p2', IMPORT_A, 2, 3, { x: 100, y: 200, width: 612, height: 792 }),
    ];
    const documents = stackedDocuments(elements);
    expect(documents.size).toBe(1);
    const doc = documents.get(IMPORT_A)!;
    expect(doc.pageCount).toBe(3);
    expect(doc.rect).toEqual({ x: 100, y: 200, width: 612, height: 792 });
    expect(doc.pages.get(0)).toBe('p0');
    expect(doc.pages.get(1)).toBe('p1');
    expect(doc.pages.get(2)).toBe('p2');
  });

  it('separates documents by importId', () => {
    const elements: Element[] = [
      stackedPage('a0', IMPORT_A, 0, 2),
      stackedPage('b0', IMPORT_B, 0, 1),
    ];
    const documents = stackedDocuments(elements);
    expect(documents.size).toBe(2);
    expect(documents.get(IMPORT_A)!.pageCount).toBe(2);
    expect(documents.get(IMPORT_B)!.pageCount).toBe(1);
  });

  it('ignores a deleted page', () => {
    const elements: Element[] = [
      stackedPage('p0', IMPORT_A, 0, 2),
      stackedPage('p1', IMPORT_A, 1, 2, undefined, { isDeleted: true }),
    ];
    const doc = stackedDocuments(elements).get(IMPORT_A)!;
    expect(doc.pages.has(1)).toBe(false);
    expect(doc.pages.size).toBe(1);
  });

  it('omits an import with no live pages at all', () => {
    const elements: Element[] = [
      stackedPage('p0', IMPORT_A, 0, 1, undefined, { isDeleted: true }),
    ];
    expect(stackedDocuments(elements).size).toBe(0);
  });

  it('ignores a column page that carries no stacked flag', () => {
    const column = stackedPage('c0', IMPORT_A, 0, 1);
    delete (column.customData as { pdfPage: Record<string, unknown> }).pdfPage.stacked;
    expect(stackedDocuments([column]).size).toBe(0);
  });

  it('ignores malformed stamps: bad importId, out-of-range index, bad pageCount', () => {
    const badImportId = stackedPage('x', 'not-hex', 0, 1);
    const badIndex = stackedPage('x', IMPORT_A, 5, 3);
    const negativeIndex = stackedPage('x', IMPORT_A, -1, 3);
    const badPageCount = stackedPage('x', IMPORT_A, 0, 0);
    const tooManyPages = stackedPage('x', IMPORT_A, 0, 51);
    // A valid 16-hex run with junk before or after it must still be refused
    // in full: the pattern anchors both ends, not just one.
    const junkPrefix = stackedPage('x', `zzzzzzzzzzzzzzzz${IMPORT_A}`, 0, 1);
    const junkSuffix = stackedPage('x', `${IMPORT_A}zzzzzzzzzzzzzzzz`, 0, 1);
    for (const element of [badImportId, badIndex, negativeIndex, badPageCount, tooManyPages, junkPrefix, junkSuffix]) {
      expect(stackedDocuments([element]).size).toBe(0);
    }
  });

  it('ignores a page whose pdfPage stamp value itself is null', () => {
    const element: Element = { id: 'x', ...DOC_RECT, isDeleted: false, customData: { pdfPage: null } };
    expect(stackedDocuments([element]).size).toBe(0);
  });

  it('ignores a stamp whose importId is not actually a string (a numeric value cannot fake the pattern)', () => {
    const raw: Element = {
      id: 'x',
      ...DOC_RECT,
      isDeleted: false,
      customData: { pdfPage: { importId: 1234567890123456, index: 0, pageCount: 1, stacked: true } },
    };
    expect(stackedDocuments([raw]).size).toBe(0);
  });

  it('ignores a stamp whose index equals pageCount exactly (the range is exclusive at the top)', () => {
    expect(stackedDocuments([stackedPage('x', IMPORT_A, 3, 3)]).size).toBe(0);
  });

  it('ignores a stamp with a non-integer pageCount inside 1..MAX_PAGES_PER_IMPORT', () => {
    // 2.5 is neither < 1 nor > MAX_PAGES_PER_IMPORT, so only the isInteger
    // check catches it -- proving that check is not redundant with the
    // range checks either side of it.
    expect(stackedDocuments([stackedPage('x', IMPORT_A, 0, 2.5)]).size).toBe(0);
  });

  it('accepts a pageCount of exactly MAX_PAGES_PER_IMPORT', () => {
    expect(stackedDocuments([stackedPage('x', IMPORT_A, 0, 50)]).size).toBe(1);
  });

  it('ignores a page with a non-finite rectangle', () => {
    const badRect = stackedPage('x', IMPORT_A, 0, 1, { x: 0, y: 0, width: Number.NaN, height: 100 });
    expect(stackedDocuments([badRect]).size).toBe(0);
  });

  it('ignores a page element with a non-string id', () => {
    const badId = stackedPage('x', IMPORT_A, 0, 1, DOC_RECT);
    badId.id = 42;
    expect(stackedDocuments([badId]).size).toBe(0);
  });

  it("falls back to the lowest surviving page's rectangle when page 0 was deleted", () => {
    const elements = [
      stackedPage('p1', IMPORT_A, 1, 4, { x: 10, y: 10, width: 100, height: 100 }),
      stackedPage('p2', IMPORT_A, 2, 4, { x: 20, y: 20, width: 200, height: 200 }),
    ];
    const doc = stackedDocuments(elements).get(IMPORT_A)!;
    expect(doc.rect).toEqual({ x: 10, y: 10, width: 100, height: 100 });
  });

  it('ignores an element with no customData or an unrelated shape', () => {
    const elements: Element[] = [
      { id: 'x', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
      { id: 'y', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, customData: null },
      { id: 'z', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, customData: { pdfPage: 'nope' } },
    ];
    expect(stackedDocuments(elements).size).toBe(0);
  });
});

describe('showingIndex', () => {
  it('shows page 0 when the document has no entry in page state', () => {
    expect(showingIndex(threePageDoc(IMPORT_A), {})).toBe(0);
  });

  it('shows the stored index when it names a live page', () => {
    expect(showingIndex(threePageDoc(IMPORT_A), { [IMPORT_A]: 2 })).toBe(2);
  });

  it('clamps a stored index above the last page', () => {
    expect(showingIndex(threePageDoc(IMPORT_A), { [IMPORT_A]: 99 })).toBe(2);
  });

  it('clamps a negative stored index to 0', () => {
    expect(showingIndex(threePageDoc(IMPORT_A), { [IMPORT_A]: -5 })).toBe(0);
  });

  it('falls back to the nearest live page when the stored one was deleted', () => {
    const doc = threePageDoc(IMPORT_A, [0, 2]);
    expect(showingIndex(doc, { [IMPORT_A]: 1 })).toBe(0);
  });

  it('breaks a tie between two equally near live pages toward the lower index', () => {
    const pages = new Map<number, string>([[0, 'p0'], [4, 'p4']]);
    const doc: StackedDocument = { importId: IMPORT_A, pageCount: 5, pages, rect: DOC_RECT };
    expect(showingIndex(doc, { [IMPORT_A]: 2 })).toBe(0);
  });

  it('ignores a non-integer stored value and shows page 0', () => {
    expect(showingIndex(threePageDoc(IMPORT_A), { [IMPORT_A]: 1.5 })).toBe(0);
  });

  it('never overrides a strictly closer page with a farther, lower-index one', () => {
    // Visits the closer page (index 2, distance 1) first, then a farther one
    // (index 0, distance 3): the farther page must never win just for having
    // a lower index -- that tie-break only applies to an actual tie.
    const pages = new Map<number, string>([[2, 'p2'], [0, 'p0']]);
    const doc: StackedDocument = { importId: IMPORT_A, pageCount: 4, pages, rect: DOC_RECT };
    expect(showingIndex(doc, { [IMPORT_A]: 3 })).toBe(2);
  });

  it('falls back to the requested index for a document with no live pages at all (defensive)', () => {
    const pages = new Map<number, string>();
    const doc: StackedDocument = { importId: IMPORT_A, pageCount: 5, pages, rect: DOC_RECT };
    expect(showingIndex(doc, { [IMPORT_A]: 2 })).toBe(2);
  });

  it('clamps using pageCount - 1, not pageCount + 1, as the upper bound', () => {
    // pages carries an out-of-range index (3) on purpose: a document built by
    // stackedDocuments never does this, but showingIndex is a pure function
    // and this is the only way to observe the clamp's exact boundary rather
    // than have it masked by the nearest-page fallback.
    const pages = new Map<number, string>([[0, 'p0'], [1, 'p1'], [2, 'p2'], [3, 'p3']]);
    const doc: StackedDocument = { importId: IMPORT_A, pageCount: 3, pages, rect: DOC_RECT };
    expect(showingIndex(doc, { [IMPORT_A]: 99 })).toBe(2);
  });

  it('updates to a strictly closer later page even when an earlier, farther page was seen first', () => {
    const pages = new Map<number, string>([[5, 'p5'], [2, 'p2']]);
    const doc: StackedDocument = { importId: IMPORT_A, pageCount: 6, pages, rect: DOC_RECT };
    expect(showingIndex(doc, { [IMPORT_A]: 3 })).toBe(2);
  });

  it('breaks a tie toward the lower index regardless of which page was inserted first', () => {
    const pages = new Map<number, string>([[4, 'p4'], [0, 'p0']]);
    const doc: StackedDocument = { importId: IMPORT_A, pageCount: 5, pages, rect: DOC_RECT };
    expect(showingIndex(doc, { [IMPORT_A]: 2 })).toBe(0);
  });
});

describe('isHidden', () => {
  it('hides a stacked page that is not the showing index', () => {
    const elements = [
      stackedPage('p0', IMPORT_A, 0, 3, DOC_RECT),
      stackedPage('p1', IMPORT_A, 1, 3, DOC_RECT),
      stackedPage('p2', IMPORT_A, 2, 3, DOC_RECT),
    ];
    const documents = stackedDocuments(elements);
    expect(isHidden(elements[0], documents, {})).toBe(false);
    expect(isHidden(elements[1], documents, {})).toBe(true);
    expect(isHidden(elements[2], documents, {})).toBe(true);
  });

  it('hides an onPage annotation whose page is not showing, while its import has a live page', () => {
    const elements = [
      stackedPage('p0', IMPORT_A, 0, 2, DOC_RECT),
      stackedPage('p1', IMPORT_A, 1, 2, DOC_RECT),
    ];
    const documents = stackedDocuments(elements);
    const annotation = onPageElement('a0', IMPORT_A, 1);
    expect(isHidden(annotation, documents, {})).toBe(true);
    expect(isHidden(annotation, documents, { [IMPORT_A]: 1 })).toBe(false);
  });

  it('never hides an onPage annotation whose import has no live page left', () => {
    const documents = stackedDocuments([]); // the import was removed entirely
    const annotation = onPageElement('a0', IMPORT_A, 1);
    expect(isHidden(annotation, documents, {})).toBe(false);
  });

  it('never hides a deleted element', () => {
    const elements = [
      stackedPage('p0', IMPORT_A, 0, 2, DOC_RECT),
      stackedPage('p1', IMPORT_A, 1, 2, DOC_RECT),
    ];
    const documents = stackedDocuments(elements);
    const deletedOtherPage = stackedPage('p1', IMPORT_A, 1, 2, DOC_RECT, { isDeleted: true });
    expect(isHidden(deletedOtherPage, documents, {})).toBe(false);
  });

  it('never hides an element carrying neither stamp', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    expect(isHidden(plainElement('x', { x: 0, y: 0, width: 10, height: 10 }), documents, {})).toBe(false);
  });

  it('never hides a stacked page whose own document is missing from the provided map (defensive)', () => {
    const page = stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT);
    const documents = stackedDocuments([]); // built without this page, so IMPORT_A has no entry
    expect(isHidden(page, documents, {})).toBe(false);
  });

  it('treats a null customData as no stamp of either kind (defensive)', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    const element = { id: 'x', type: 'freedraw', x: 0, y: 0, width: 10, height: 10, isDeleted: false, customData: null };
    expect(isHidden(element, documents, {})).toBe(false);
  });

  it('treats a null onPage value as no annotation stamp (defensive)', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    const element = {
      id: 'x', type: 'freedraw', x: 0, y: 0, width: 10, height: 10, isDeleted: false,
      customData: { onPage: null },
    };
    expect(isHidden(element, documents, {})).toBe(false);
  });

  it('rejects an onPage stamp whose importId fails the hex pattern, even against a hand-built document sharing that key', () => {
    // A hand-built documents map (not produced by stackedDocuments) lets this
    // test reach past the coincidence that a Map lookup by a malformed key
    // would fail anyway -- it proves the importId is actually validated, not
    // just filtered by a lucky Map miss.
    const documents = new Map<string, StackedDocument>([
      ['not-hex', { importId: 'not-hex', pageCount: 2, pages: new Map([[0, 'p0'], [1, 'p1']]), rect: DOC_RECT }],
    ]);
    const annotation = onPageElement('a0', 'not-hex', 1);
    expect(isHidden(annotation, documents, {})).toBe(false);
  });

  it('rejects an onPage stamp with a negative index, even against a hand-built matching document', () => {
    const documents = new Map<string, StackedDocument>([
      [IMPORT_A, { importId: IMPORT_A, pageCount: 2, pages: new Map([[0, 'p0'], [1, 'p1']]), rect: DOC_RECT }],
    ]);
    const annotation = onPageElement('a0', IMPORT_A, -1);
    expect(isHidden(annotation, documents, {})).toBe(false);
  });
});

describe('annotationStampFor', () => {
  it('stamps a fresh element overlapping the showing page rectangle', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 3, DOC_RECT)]);
    const overlapping = plainElement('a0', { x: 150, y: 250, width: 30, height: 30 });
    expect(annotationStampFor(overlapping, documents, {})).toEqual({ importId: IMPORT_A, index: 0 });
  });

  it('stamps with the current showing index, not always page 0', () => {
    const elements = [
      stackedPage('p0', IMPORT_A, 0, 2, DOC_RECT),
      stackedPage('p1', IMPORT_A, 1, 2, DOC_RECT),
    ];
    const documents = stackedDocuments(elements);
    const overlapping = plainElement('a0', { x: 150, y: 250, width: 30, height: 30 });
    expect(annotationStampFor(overlapping, documents, { [IMPORT_A]: 1 })).toEqual({ importId: IMPORT_A, index: 1 });
  });

  it('does not stamp an element that already carries an onPage stamp', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    const already = onPageElement('a0', IMPORT_A, 0, { x: 150, y: 250, width: 30, height: 30 });
    expect(annotationStampFor(already, documents, {})).toBeNull();
  });

  it('does not stamp a page element itself', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    expect(annotationStampFor(stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT), documents, {})).toBeNull();
  });

  it('does not stamp an element with no overlap', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    const farAway = plainElement('a0', { x: 5000, y: 5000, width: 10, height: 10 });
    expect(annotationStampFor(farAway, documents, {})).toBeNull();
  });

  it('does not stamp an element that only touches the document edge', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    const touching = plainElement('a0', { x: DOC_RECT.x + DOC_RECT.width, y: DOC_RECT.y, width: 20, height: 20 });
    expect(annotationStampFor(touching, documents, {})).toBeNull();
  });

  it('does not stamp a deleted element', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    const deleted = plainElement('a0', { x: 150, y: 250, width: 30, height: 30 });
    deleted.isDeleted = true;
    expect(annotationStampFor(deleted, documents, {})).toBeNull();
  });

  it('does not stamp an element with no usable rectangle', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    expect(annotationStampFor({ id: 'a0', isDeleted: false }, documents, {})).toBeNull();
  });

  it('stamps an element whose customData is null (defensive: null is not "already stamped")', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    const element = {
      id: 'a0', type: 'freedraw', x: 150, y: 250, width: 30, height: 30, isDeleted: false, customData: null,
    };
    expect(annotationStampFor(element, documents, {})).toEqual({ importId: IMPORT_A, index: 0 });
  });

  it('stamps an element whose customData carries neither pdfPage nor onPage', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    const element = {
      id: 'a0', type: 'freedraw', x: 150, y: 250, width: 30, height: 30, isDeleted: false,
      customData: { color: 'red' },
    };
    expect(annotationStampFor(element, documents, {})).toEqual({ importId: IMPORT_A, index: 0 });
  });

  it('detects overlap when the element sits right at the rectangle\'s left edge (guards the overlap arithmetic)', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    const element = plainElement('a0', { x: DOC_RECT.x, y: DOC_RECT.y + 50, width: 5, height: 30 });
    expect(annotationStampFor(element, documents, {})).toEqual({ importId: IMPORT_A, index: 0 });
  });

  it('detects overlap when the element sits right at the rectangle\'s top edge (guards the overlap arithmetic)', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    const element = plainElement('a0', { x: DOC_RECT.x + 50, y: DOC_RECT.y, width: 30, height: 5 });
    expect(annotationStampFor(element, documents, {})).toEqual({ importId: IMPORT_A, index: 0 });
  });

  it('does not stamp an element that only touches the document\'s left edge', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    const touching = plainElement('a0', { x: DOC_RECT.x - 20, y: DOC_RECT.y, width: 20, height: 20 });
    expect(annotationStampFor(touching, documents, {})).toBeNull();
  });

  it('does not stamp an element that only touches the document\'s top edge', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    const touching = plainElement('a0', { x: DOC_RECT.x, y: DOC_RECT.y - 20, width: 50, height: 20 });
    expect(annotationStampFor(touching, documents, {})).toBeNull();
  });

  it('does not stamp an element that only touches the document\'s bottom edge', () => {
    const documents = stackedDocuments([stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT)]);
    const touching = plainElement('a0', { x: DOC_RECT.x, y: DOC_RECT.y + DOC_RECT.height, width: 50, height: 20 });
    expect(annotationStampFor(touching, documents, {})).toBeNull();
  });
});

describe('elementsToMove / elementsToRemove', () => {
  it('collects every live page and every onPage annotation for the import', () => {
    const elements = [
      stackedPage('p0', IMPORT_A, 0, 2, DOC_RECT),
      stackedPage('p1', IMPORT_A, 1, 2, DOC_RECT),
      onPageElement('a0', IMPORT_A, 0),
      onPageElement('a1', IMPORT_A, 1),
      stackedPage('other0', IMPORT_B, 0, 1),
      onPageElement('otherA', IMPORT_B, 0),
    ];
    expect(elementsToMove(elements, IMPORT_A).sort()).toEqual(['a0', 'a1', 'p0', 'p1']);
    expect(elementsToRemove(elements, IMPORT_A).sort()).toEqual(['a0', 'a1', 'p0', 'p1']);
  });

  it('excludes deleted elements', () => {
    const elements = [
      stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT),
      onPageElement('a0', IMPORT_A, 0, undefined, { isDeleted: true }),
    ];
    expect(elementsToMove(elements, IMPORT_A)).toEqual(['p0']);
    expect(elementsToRemove(elements, IMPORT_A)).toEqual(['p0']);
  });

  it('returns nothing for an import with no matching elements', () => {
    expect(elementsToMove([], IMPORT_A)).toEqual([]);
    expect(elementsToRemove([], IMPORT_A)).toEqual([]);
  });

  it('ignores an element with a non-string id', () => {
    const malformedId = stackedPage('p0', IMPORT_A, 0, 1, DOC_RECT);
    malformedId.id = 123;
    expect(elementsToMove([malformedId], IMPORT_A)).toEqual([]);
    expect(elementsToRemove([malformedId], IMPORT_A)).toEqual([]);
  });
});

describe('nextPage / previousPage', () => {
  it('advances by one, never past the last page', () => {
    expect(nextPage(0, 3)).toBe(1);
    expect(nextPage(1, 3)).toBe(2);
    expect(nextPage(2, 3)).toBe(2);
  });

  it('retreats by one, never before the first page', () => {
    expect(previousPage(2)).toBe(1);
    expect(previousPage(1)).toBe(0);
    expect(previousPage(0)).toBe(0);
  });
});
