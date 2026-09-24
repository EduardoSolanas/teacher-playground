/*
 * Mutation note (AGENTS.md): one survivor on this module is equivalent and
 * cannot be killed. Dropping `stamp === null` from the stamp reader changes
 * nothing observable -- destructuring a string or a number yields an undefined
 * importId, which the very next check refuses anyway.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPORT_JPEG_QUALITY,
  EXPORT_MARGIN,
  MAX_EXPORT_SIDE,
  boundingBox,
  cropInCanvas,
  exportFailureMessage,
  exportRenderScale,
  leftoverElements,
  pageElements,
  worksheetPages,
} from './pdfExport';

type Element = Record<string, unknown>;

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

describe('exportFailureMessage', () => {
  it('gives each failure its plain message', () => {
    expect(exportFailureMessage('empty')).toBe('Nothing on this board yet.');
    expect(exportFailureMessage('files-pending'))
      .toBe('Some pictures are still loading. Try again in a moment.');
    expect(exportFailureMessage('failed')).toBe("Couldn't build the PDF.");
  });
});
