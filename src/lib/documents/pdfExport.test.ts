/*
 * Mutation note (AGENTS.md): four survivors on this module are equivalent and
 * cannot be killed.
 *
 * - Dropping `stamp === null` from the original stamp reader (`stampOf`)
 *   changes nothing observable -- destructuring a string or a number yields
 *   an undefined importId, which the very next check refuses anyway.
 * - `isStackedPageStamp`'s two `return false` defaults (for `customData` and
 *   for `pdfPage` being null or a non-object) cannot be flipped to `true`
 *   observably. Its only caller, `columnPagesByImport`, always follows it
 *   with `stampOf(element)`, which re-reads the exact same `customData` and
 *   `pdfPage` values and applies the identical null/non-object guard before
 *   accepting a stamp. Whenever `isStackedPageStamp` would wrongly claim
 *   "stacked" for malformed input, `stampOf` still (correctly) rejects it one
 *   line later, so the element is excluded from the column grouping either
 *   way -- claiming it early or claiming it late produces the same result.
 * - `firstAppearance`'s `typeof importId !== 'string'` guard: an importId
 *   that fails this check is never a real, looked-up key. Every id actually
 *   queried against the returned map (`order.get(importId)` in
 *   `documentPages`) comes from `columnPagesByImport` or `stackedDocuments`,
 *   both of which already validate their importId as a genuine string before
 *   using it as a Map key. A stray non-string key recorded by a weakened
 *   guard is simply never read, so removing the guard cannot change any
 *   `documentPages` output -- the same reasoning `pagedDocuments.test.ts`
 *   already documents for its own numeric-importId case.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPORT_JPEG_QUALITY,
  EXPORT_MARGIN,
  MAX_EXPORT_SIDE,
  boundingBox,
  cropInCanvas,
  documentPages,
  exportFailureMessage,
  exportPageElements,
  exportRenderScale,
  leftoverElements,
  pageElements,
  worksheetPages,
} from './pdfExport';

type Element = Record<string, unknown>;

const IMPORT_A = '0123456789abcdef';
const IMPORT_B = 'fedcba9876543210';

function page(id: string, importId: string, index: number, x: number, y: number): Element {
  return {
    id,
    type: 'image',
    x,
    y,
    width: 612,
    height: 792,
    customData: { pdfPage: { importId, index } },
  };
}

function stroke(id: string, x: number, y: number, width = 50, height = 50): Element {
  return { id, type: 'freedraw', x, y, width, height };
}

function stackedPage(
  id: string,
  importId: string,
  index: number,
  pageCount: number,
  x = 0,
  y = 0,
): Element {
  return {
    id,
    type: 'image',
    x,
    y,
    width: 612,
    height: 792,
    customData: { pdfPage: { importId, index, pageCount, stacked: true } },
  };
}

function onPage(id: string, importId: string, index: number, x: number, y: number, width = 50, height = 50): Element {
  return { id, type: 'freedraw', x, y, width, height, customData: { onPage: { importId, index } } };
}

describe('pinned export constants', () => {
  it('uses the specified literal values', () => {
    expect(MAX_EXPORT_SIDE).toBe(4000);
    expect(EXPORT_JPEG_QUALITY).toBe(0.92);
    expect(EXPORT_MARGIN).toBe(24);
  });
});

describe('worksheetPages', () => {
  it('orders the pages of one import by their page index, not by scene order', () => {
    const elements = [page('c', 'imp-1', 2, 0, 1664), page('a', 'imp-1', 0, 0, 0), page('b', 'imp-1', 1, 0, 832)];
    expect(worksheetPages(elements).map((found) => found.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps two imports apart, in the order they first appear on the board', () => {
    const elements = [
      page('second-1', 'imp-2', 0, 900, 0),
      page('first-1', 'imp-1', 0, 0, 0),
      page('first-2', 'imp-1', 1, 0, 832),
    ];
    expect(worksheetPages(elements).map((found) => found.id))
      .toEqual(['second-1', 'first-1', 'first-2']);
  });

  it('ignores deleted pages and anything not stamped by an import', () => {
    const elements = [
      { ...page('gone', 'imp-1', 0, 0, 0), isDeleted: true },
      page('kept', 'imp-1', 1, 0, 832),
      { id: 'plain', type: 'image', x: 0, y: 0, width: 10, height: 10 },
      { id: 'odd', type: 'image', x: 0, y: 0, width: 10, height: 10, customData: { pdfPage: 'nope' } },
      // Each of these reached the stamp reader and must leave it empty-handed
      // rather than throwing or being taken for a page.
      { id: 'null-data', type: 'image', x: 0, y: 0, width: 10, height: 10, customData: null },
      { id: 'null-stamp', type: 'image', x: 0, y: 0, width: 10, height: 10, customData: { pdfPage: null } },
      {
        id: 'numeric-import',
        type: 'image',
        x: 0, y: 0, width: 10, height: 10,
        customData: { pdfPage: { importId: 7, index: 0 } },
      },
      {
        id: 'empty-import',
        type: 'image',
        x: 0, y: 0, width: 10, height: 10,
        customData: { pdfPage: { importId: '', index: 0 } },
      },
      {
        id: 'fractional-index',
        type: 'image',
        x: 0, y: 0, width: 10, height: 10,
        customData: { pdfPage: { importId: 'imp-1', index: 1.5 } },
      },
      {
        id: 'negative-index',
        type: 'image',
        x: 0, y: 0, width: 10, height: 10,
        customData: { pdfPage: { importId: 'imp-1', index: -1 } },
      },
      {
        id: 'no-size',
        type: 'image',
        customData: { pdfPage: { importId: 'imp-1', index: 3 } },
      },
      {
        id: 7 as unknown as string,
        type: 'image',
        x: 0, y: 0, width: 10, height: 10,
        customData: { pdfPage: { importId: 'imp-1', index: 4 } },
      },
      stroke('ink', 5, 5),
    ];
    expect(worksheetPages(elements).map((found) => found.id)).toEqual(['kept']);
  });

  it('reports each page as its rectangle on the board', () => {
    expect(worksheetPages([page('a', 'imp-1', 0, 100, -40)])[0]).toEqual({
      id: 'a',
      rect: { x: 100, y: -40, width: 612, height: 792 },
    });
  });

  it('finds no pages on a board that never had an import', () => {
    expect(worksheetPages([stroke('ink', 0, 0)])).toEqual([]);
  });
});

describe('pageElements', () => {
  const rect = { x: 0, y: 0, width: 612, height: 792 };

  it('takes the page itself and everything written on it', () => {
    const elements = [page('a', 'imp-1', 0, 0, 0), stroke('on', 100, 100), stroke('off', 5000, 5000)];
    expect(pageElements(elements, rect).map((element) => element.id)).toEqual(['a', 'on']);
  });

  it('keeps an annotation that only overlaps the edge, and drops one that merely touches it', () => {
    const elements = [
      page('a', 'imp-1', 0, 0, 0),
      stroke('overlapping', 600, 780, 50, 50),
      stroke('touching', 612, 0, 50, 50),
    ];
    expect(pageElements(elements, rect).map((element) => element.id)).toEqual(['a', 'overlapping']);
  });

  it("leaves another import's page out, so two pages never render on top of each other", () => {
    const elements = [page('a', 'imp-1', 0, 0, 0), page('b', 'imp-1', 1, 0, 700)];
    expect(pageElements(elements, rect).map((element) => element.id)).toEqual(['a']);
  });

  it('drops an annotation whose edge merely meets the page on any side', () => {
    const elements = [
      page('a', 'imp-1', 0, 0, 0),
      stroke('left-of', -50, 100, 50, 50),
      stroke('above', 100, -50, 50, 50),
      stroke('below', 100, 792, 50, 50),
      stroke('inside-left', -49, 100, 50, 50),
    ];
    expect(pageElements(elements, rect).map((element) => element.id)).toEqual(['a', 'inside-left']);
  });

  it('tells this page from another that shares part of its rectangle', () => {
    // Each of these differs in exactly one of x, y, width and height, so a page
    // is only itself when all four agree.
    const elements = [
      page('a', 'imp-1', 0, 0, 0),
      { ...page('same-size-right', 'imp-1', 1, 0, 0), x: 10 },
      { ...page('same-size-down', 'imp-1', 2, 0, 0), y: 10 },
      { ...page('narrower', 'imp-1', 3, 0, 0), width: 600 },
      { ...page('shorter', 'imp-1', 4, 0, 0), height: 700 },
    ];
    expect(pageElements(elements, rect).map((element) => element.id)).toEqual(['a']);
  });

  it('skips an element with no usable geometry', () => {
    const elements = [page('a', 'imp-1', 0, 0, 0), { id: 'bad', type: 'freedraw' }];
    expect(pageElements(elements, rect).map((element) => element.id)).toEqual(['a']);
  });

  it('skips deleted annotations', () => {
    const elements = [page('a', 'imp-1', 0, 0, 0), { ...stroke('gone', 10, 10), isDeleted: true }];
    expect(pageElements(elements, rect).map((element) => element.id)).toEqual(['a']);
  });
});

describe('leftoverElements', () => {
  it('returns what no page carries', () => {
    const elements = [page('a', 'imp-1', 0, 0, 0), stroke('on', 10, 10), stroke('away', 5000, 5000)];
    const rects = worksheetPages(elements).map((found) => found.rect);
    expect(leftoverElements(elements, rects).map((element) => element.id)).toEqual(['away']);
  });

  it('returns every drawn element when the board has no pages', () => {
    const elements = [stroke('one', 0, 0), stroke('two', 80, 0)];
    expect(leftoverElements(elements, []).map((element) => element.id)).toEqual(['one', 'two']);
  });

  it('leaves out a deleted element that sits nowhere near a page', () => {
    const elements = [
      { ...stroke('gone', 5000, 5000), isDeleted: true },
      stroke('here', 5000, 5100),
    ];
    expect(leftoverElements(elements, [{ x: 0, y: 0, width: 612, height: 792 }])
      .map((element) => element.id)).toEqual(['here']);
  });

  it('leaves out an element with no usable geometry', () => {
    expect(leftoverElements([{ id: 'bad', type: 'freedraw' }], [])).toEqual([]);
  });

  it('returns nothing when every element sits on a page', () => {
    const elements = [page('a', 'imp-1', 0, 0, 0), stroke('on', 10, 10)];
    expect(leftoverElements(elements, [{ x: 0, y: 0, width: 612, height: 792 }])).toEqual([]);
  });
});

describe('boundingBox', () => {
  it('covers every element with the export margin around it', () => {
    expect(boundingBox([stroke('a', 100, 50, 40, 20), stroke('b', 0, 200, 10, 10)])).toEqual({
      x: -24,
      y: 26,
      width: 140 + 48,
      height: 160 + 48,
    });
  });

  it('can be asked for the region itself, which is what a page is drawn from', () => {
    expect(boundingBox([stroke('a', 100, 50, 40, 20), stroke('b', 0, 200, 10, 10)], 0)).toEqual({
      x: 0,
      y: 50,
      width: 140,
      height: 160,
    });
  });

  it('places the box by its own left and top edges, not by their sum', () => {
    expect(boundingBox([stroke('a', 100, 200, 40, 20)], 0)).toEqual({
      x: 100,
      y: 200,
      width: 40,
      height: 20,
    });
  });

  it('ignores an element with no usable geometry', () => {
    expect(boundingBox([stroke('a', 0, 0, 10, 10), { id: 'bad', type: 'freedraw' }], 0)).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(boundingBox([{ id: 'nan', type: 'freedraw', x: Number.NaN, y: 0, width: 5, height: 5 }], 0))
      .toBeNull();
    expect(boundingBox([{ id: 'text', type: 'freedraw', x: '10', y: 0, width: 5, height: 5 }], 0))
      .toBeNull();
    expect(boundingBox([{ id: 'inf', type: 'freedraw', x: 0, y: 0, width: Infinity, height: 5 }], 0))
      .toBeNull();
  });

  it('has no box for nothing', () => {
    expect(boundingBox([])).toBeNull();
  });
});

describe('exportRenderScale', () => {
  it('renders at twice the board scale so a page reads when printed', () => {
    expect(exportRenderScale(612, 792)).toBe(2);
  });

  it('holds the longest side at the export cap for a very large region', () => {
    expect(exportRenderScale(1000, 3000)).toBeCloseTo(4000 / 3000, 10);
    expect(exportRenderScale(5000, 1000)).toBe(0.8);
  });
});

describe('cropInCanvas', () => {
  it('locates a page inside a canvas exported from a wider bounding box', () => {
    // The canvas covers x 0..700 at scale 2; the page starts at x 40, y 10.
    expect(cropInCanvas(
      { x: 0, y: 0, width: 700, height: 900 },
      { x: 40, y: 10, width: 612, height: 792 },
      2,
    )).toEqual({ x: 80, y: 20, width: 1224, height: 1584 });
  });

  it('handles a bounding box that starts at negative board coordinates', () => {
    expect(cropInCanvas(
      { x: -100, y: -50, width: 800, height: 900 },
      { x: -100, y: 0, width: 200, height: 100 },
      1,
    )).toEqual({ x: 0, y: 50, width: 200, height: 100 });
  });
});

describe('documentPages and exportPageElements (stacked documents, spec/PAGED_DOCUMENTS_SPEC.md §6.4)', () => {
  it('exports a three-page stacked import as three pages: the onPage-stamped stroke only on its own page, the unstamped stroke on all three', () => {
    const elements = [
      stackedPage('p0', IMPORT_A, 0, 3),
      stackedPage('p1', IMPORT_A, 1, 3),
      stackedPage('p2', IMPORT_A, 2, 3),
      onPage('stamped', IMPORT_A, 1, 100, 100),
      stroke('unstamped', 200, 200),
    ];
    const pages = documentPages(elements);
    expect(pages).toHaveLength(3);
    expect(pages.map((found) => exportPageElements(elements, found).map((element) => element.id))).toEqual([
      ['p0', 'unstamped'],
      ['p1', 'stamped', 'unstamped'],
      ['p2', 'unstamped'],
    ]);
  });

  it('never puts an onPage-stamped element on the leftover page, even far from every page rectangle', () => {
    const elements = [
      stackedPage('p0', IMPORT_A, 0, 1),
      onPage('far', IMPORT_A, 0, 5000, 5000),
    ];
    const rects = documentPages(elements).map((found) => found.rect);
    expect(leftoverElements(elements, rects).map((element) => element.id)).toEqual([]);
  });

  it('skips a deleted page: its index is simply missing, the surviving pages still export', () => {
    const elements = [
      stackedPage('p0', IMPORT_A, 0, 3),
      { ...stackedPage('p1', IMPORT_A, 1, 3), isDeleted: true },
      stackedPage('p2', IMPORT_A, 2, 3),
    ];
    const pages = documentPages(elements);
    expect(pages.map((found) => found.id)).toEqual(['p0', 'p2']);
    expect(pages.map((found) => (found.kind === 'stacked' ? found.index : -1))).toEqual([0, 2]);
  });

  it('keeps a stacked and a column import in the order their first page appears on the board', () => {
    const stackedFirst = [
      stackedPage('stacked-1', IMPORT_A, 0, 1, 900, 0),
      page('column-1', IMPORT_B, 0, 0, 0),
    ];
    expect(documentPages(stackedFirst).map((found) => found.id)).toEqual(['stacked-1', 'column-1']);

    const columnFirst = [
      page('column-1', IMPORT_B, 0, 0, 0),
      stackedPage('stacked-1', IMPORT_A, 0, 1, 900, 0),
    ];
    expect(documentPages(columnFirst).map((found) => found.id)).toEqual(['column-1', 'stacked-1']);
  });

  it('uses each import\'s earliest appearance, not a later one, to order it against another import', () => {
    // Both imports' first pages come after a filler element with no stamp, so
    // neither import's true position is 0 -- otherwise a bug that always
    // treated a nonzero position as "very late" could coincidentally land on
    // the right answer by luck of 0 sorting first anyway.
    const columnFirst = [
      stroke('filler', 0, 0),
      page('column-1', IMPORT_B, 0, 0, 0),
      stackedPage('stacked-1', IMPORT_A, 0, 1, 900, 0),
    ];
    expect(documentPages(columnFirst).map((found) => found.id)).toEqual(['column-1', 'stacked-1']);

    const stackedFirst = [
      stroke('filler', 0, 0),
      stackedPage('stacked-1', IMPORT_A, 0, 1, 900, 0),
      page('column-1', IMPORT_B, 0, 0, 0),
    ];
    expect(documentPages(stackedFirst).map((found) => found.id)).toEqual(['stacked-1', 'column-1']);
  });

  it('orders an import by its earliest page, not a later one that happens to set the position last', () => {
    const elements = [
      stackedPage('x0', IMPORT_A, 0, 2, 0, 0),
      page('y0', IMPORT_B, 0, 900, 0),
      stackedPage('x1', IMPORT_A, 1, 2, 0, 0),
    ];
    expect(documentPages(elements).map((found) => found.id)).toEqual(['x0', 'x1', 'y0']);
  });

  it('ignores a deleted element when computing an import\'s first-appearance position', () => {
    const elements = [
      { ...stackedPage('deleted-early', IMPORT_A, 0, 1, 0, 0), isDeleted: true },
      page('col1', IMPORT_B, 0, 900, 0),
      stackedPage('real-a', IMPORT_A, 0, 1, 0, 0),
    ];
    expect(documentPages(elements).map((found) => found.id)).toEqual(['col1', 'real-a']);
  });

  it('ignores an element with malformed customData or an unusable pdfPage stamp when computing order', () => {
    const elements = [
      { id: 'null-custom-data', type: 'image', x: 0, y: 0, width: 10, height: 10, customData: null },
      { id: 'null-stamp', type: 'image', x: 0, y: 0, width: 10, height: 10, customData: { pdfPage: null } },
      page('col1', IMPORT_B, 0, 0, 0),
    ];
    expect(documentPages(elements).map((found) => found.id)).toEqual(['col1']);
  });

  it('orders a stacked document\'s pages by their stamped index, not by scene order', () => {
    const elements = [
      stackedPage('p2', IMPORT_A, 2, 3),
      stackedPage('p0', IMPORT_A, 0, 3),
      stackedPage('p1', IMPORT_A, 1, 3),
    ];
    expect(documentPages(elements).map((found) => found.id)).toEqual(['p0', 'p1', 'p2']);
  });

  it('builds a column page\'s elements through the same rule pageElements uses, not the stacked rule', () => {
    // An onPage-stamped element has no `pdfPage` stamp, so `pageElements`
    // (the real column rule) treats it as ordinary overlapping content and
    // keeps it -- unlike the stacked rule, which only keeps an onPage
    // annotation whose importId/index match the page. This element's
    // importId ('nobody') never matches anything, so if `exportPageElements`
    // ever ran the stacked rule for a column page, it would wrongly drop it.
    const elements = [
      page('a', IMPORT_B, 0, 0, 0),
      stroke('on', 100, 100),
      onPage('marked', 'nobody-imports-this', 0, 150, 150),
      stroke('off', 5000, 5000),
    ];
    const [columnPage] = documentPages(elements);
    expect(columnPage.kind).toBe('column');
    expect(exportPageElements(elements, columnPage).map((element) => element.id)).toEqual(['a', 'on', 'marked']);
  });

  it('excludes a deleted annotation, an annotation for a different import, an element that does not overlap, and one with no usable geometry from a stacked page', () => {
    const elements = [
      stackedPage('p1', IMPORT_A, 1, 3),
      { ...onPage('gone', IMPORT_A, 1, 100, 100), isDeleted: true },
      onPage('wrong-import', IMPORT_B, 1, 100, 100),
      stroke('far', 5000, 5000),
      { id: 'bad', type: 'freedraw' },
      stroke('near', 100, 100),
      onPage('mine', IMPORT_A, 1, 200, 200),
    ];
    const target = documentPages(elements).find((found) => found.kind === 'stacked' && found.index === 1)!;
    expect(exportPageElements(elements, target).map((element) => element.id)).toEqual(['p1', 'near', 'mine']);
  });
});

describe('exportFailureMessage', () => {
  it('gives each failure its plain message', () => {
    expect(exportFailureMessage('empty')).toBe('Nothing on this board yet.');
    expect(exportFailureMessage('files-pending'))
      .toBe('Some pictures are still loading. Try again in a moment.');
    expect(exportFailureMessage('failed')).toBe("Couldn't build the PDF.");
  });
});
