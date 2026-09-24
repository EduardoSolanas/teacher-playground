/**
 * Pure decisions for Download as PDF (spec/PDF_EXPORT_SPEC.md).
 *
 * The file is built in the teacher's browser from the scene already loaded
 * there. What belongs on which PDF page, how large to render it and where a
 * page sits inside an exported canvas are all arithmetic, so they live here
 * rather than beside the canvas and the PDF writer.
 */

import { hasAnyPageStamp, onPageStampOf, stackedDocuments } from './pagedDocuments';

/** Longest side of any rendered region, in pixels. */
export const MAX_EXPORT_SIDE = 4000;

/** JPEG quality for an embedded page: the worksheets are raster already. */
export const EXPORT_JPEG_QUALITY = 0.92;

/** Board units of air around the page of leftover drawing. */
export const EXPORT_MARGIN = 24;

/** Twice the board scale, so a page still reads when it is printed. */
const EXPORT_SCALE = 2;

export type Rect = { x: number; y: number; width: number; height: number };
export type SceneElement = Record<string, unknown>;

/** One page of an imported PDF, as import stamped it (PDF_IMPORT_SPEC §3). */
export type WorksheetPage = { id: string; rect: Rect };

type PageStamp = { importId: string; index: number };

function stampOf(element: SceneElement): PageStamp | null {
  const customData = element.customData;
  if (customData === null || typeof customData !== 'object') return null;
  const stamp = (customData as { pdfPage?: unknown }).pdfPage;
  if (stamp === null || typeof stamp !== 'object') return null;
  const { importId, index } = stamp as { importId?: unknown; index?: unknown };
  if (typeof importId !== 'string' || importId.length === 0) return null;
  if (!Number.isInteger(index) || (index as number) < 0) return null;
  return { importId, index: index as number };
}

function live(element: SceneElement): boolean {
  return element.isDeleted !== true;
}

/**
 * Whether a page element's stamp is a stacked-document page (spec
 * PAGED_DOCUMENTS_SPEC.md §3.1: `customData.pdfPage.stacked === true`), as
 * opposed to a column page. `stampOf` above deliberately ignores this flag --
 * a stacked page still reads as a well-formed `{importId, index}` stamp there
 * for the "is this a page vs. plain content" checks in `pageElements` and
 * `leftoverElements`, which behave correctly either way. Only
 * `worksheetPages` needs to tell the two apart, so it can leave stacked pages
 * out of the column grouping entirely; they are grouped and ordered instead
 * by `stackedDocuments` in `pagedDocuments.ts`, reused below.
 */
function isStackedPageStamp(element: SceneElement): boolean {
  const customData = element.customData;
  if (customData === null || typeof customData !== 'object') return false;
  const stamp = (customData as { pdfPage?: unknown }).pdfPage;
  if (stamp === null || typeof stamp !== 'object') return false;
  return (stamp as { stacked?: unknown }).stacked === true;
}

function rectOf(element: SceneElement): Rect | null {
  const { x, y, width, height } = element as Record<string, number>;
  // Number.isFinite is the whole check: it is false for a string, a boolean,
  // undefined, NaN and Infinity alike, so a typeof guard beside it says nothing.
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  return { x, y, width, height };
}

/**
 * Column pages grouped by import, each group's pages already ordered by the
 * stamped index -- the shared computation behind `worksheetPages` (which
 * flattens it) and `documentPages` (which needs the grouping to interleave
 * column imports with stacked ones by first appearance). A Map keeps the
 * order its keys were first set in, which is exactly the order the imports
 * first appear on the board -- no sort needed for that part.
 */
function columnPagesByImport(elements: readonly SceneElement[]): Map<string, WorksheetPage[]> {
  const imports = new Map<string, { index: number; page: WorksheetPage }[]>();
  elements.forEach((element) => {
    if (!live(element)) return;
    if (isStackedPageStamp(element)) return;
    const stamp = stampOf(element);
    if (!stamp) return;
    const rect = rectOf(element);
    const id = element.id;
    if (!rect || typeof id !== 'string') return;
    const group = imports.get(stamp.importId) ?? [];
    group.push({ index: stamp.index, page: { id, rect } });
    imports.set(stamp.importId, group);
  });

  const result = new Map<string, WorksheetPage[]>();
  imports.forEach((group, importId) => {
    result.set(importId, group
      .sort((left, right) => left.index - right.index)
      .map((entry) => entry.page));
  });
  return result;
}

/**
 * The imported worksheet pages on a board, in the order they should appear in
 * the file: each import in the order its first page appears on the board, and
 * within an import by the page index the import stamped, never by scene order
 * — a page moved or redrawn does not reorder the worksheet. Stacked-document
 * pages (spec PAGED_DOCUMENTS_SPEC.md §3.1) are left out: they export through
 * `documentPages` instead.
 */
export function worksheetPages(elements: readonly SceneElement[]): WorksheetPage[] {
  return [...columnPagesByImport(elements).values()].flat();
}

/** Whether two rectangles share any area. Touching edges do not count. */
function overlaps(left: Rect, right: Rect): boolean {
  return left.x < right.x + right.width
    && right.x < left.x + left.width
    && left.y < right.y + right.height
    && right.y < left.y + left.height;
}

/**
 * The page itself plus everything written on it. Other imported pages are left
 * out, so a page that overlaps its neighbour never renders on top of it; an
 * annotation crossing two pages belongs to both, exactly as it looks on the
 * board.
 */
export function pageElements(elements: readonly SceneElement[], rect: Rect): SceneElement[] {
  return elements.filter((element) => {
    if (!live(element)) return false;
    const elementRect = rectOf(element);
    if (!elementRect) return false;
    if (stampOf(element)) {
      return elementRect.x === rect.x && elementRect.y === rect.y
        && elementRect.width === rect.width && elementRect.height === rect.height;
    }
    return overlaps(elementRect, rect);
  });
}

/** What no worksheet page carries, which becomes the last page of the file. */
export function leftoverElements(
  elements: readonly SceneElement[],
  pages: readonly Rect[],
): SceneElement[] {
  const liveDocuments = stackedDocuments(elements);
  return elements.filter((element) => {
    // stampOf matches any well-formed `{importId, index}` pdfPage stamp,
    // stacked or column alike, so a stacked page is already excluded here.
    // An onPage-stamped annotation prints with its page (spec §6.4), so it is
    // never a leftover -- while that page's document still exists. Once the
    // document is removed the board shows the annotation on its own (§3.4),
    // and the file must print it too, so it is ordinary drawing again.
    if (!live(element) || stampOf(element)) return false;
    const annotation = onPageStampOf(element);
    if (annotation && liveDocuments.has(annotation.importId)) return false;
    const rect = rectOf(element);
    if (!rect) return false;
    return !pages.some((page) => overlaps(rect, page));
  });
}

/** One page of the exported file: a column worksheet page, or one index of a stacked document. */
export type ExportPage =
  | { kind: 'column'; id: string; rect: Rect }
  | { kind: 'stacked'; importId: string; index: number; id: string; rect: Rect };

/**
 * The position (index into `elements`) of the first live element that stamps
 * each import, whether as a column page or a stacked one -- both use
 * `customData.pdfPage.importId`. Used only to interleave column and stacked
 * imports by "first appearance on the board" (spec §6.4); the loose shape
 * check here does not need to fully validate a stamp, since inclusion in the
 * actual page groups is already decided by `columnPagesByImport` and
 * `stackedDocuments`.
 */
function firstAppearance(elements: readonly SceneElement[]): Map<string, number> {
  const seen = new Map<string, number>();
  elements.forEach((element, position) => {
    if (!live(element)) return;
    const customData = element.customData;
    if (customData === null || typeof customData !== 'object') return;
    const stamp = (customData as { pdfPage?: unknown }).pdfPage;
    if (stamp === null || typeof stamp !== 'object') return;
    const importId = (stamp as { importId?: unknown }).importId;
    if (typeof importId !== 'string') return;
    if (!seen.has(importId)) seen.set(importId, position);
  });
  return seen;
}

/**
 * Every page of the file that comes from an import -- column worksheet pages
 * and stacked-document pages together (spec PAGED_DOCUMENTS_SPEC.md §6.4) --
 * in the order they should appear: each import (of either kind) in the order
 * its first page appears on the board, and within an import by page index.
 * The stacked grouping is `stackedDocuments` from `pagedDocuments.ts`, reused
 * rather than recomputed here; deleted pages are already absent from it, so a
 * document simply has a gap at that index.
 */
export function documentPages(elements: readonly SceneElement[]): ExportPage[] {
  const order = firstAppearance(elements);
  const groups: { position: number; pages: ExportPage[] }[] = [];

  columnPagesByImport(elements).forEach((pages, importId) => {
    groups.push({
      position: order.get(importId) ?? Infinity,
      pages: pages.map((page) => ({ kind: 'column', id: page.id, rect: page.rect })),
    });
  });

  stackedDocuments(elements).forEach((document, importId) => {
    const pages: ExportPage[] = [...document.pages.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, id]) => ({ kind: 'stacked', importId, index, id, rect: document.rect }));
    groups.push({ position: order.get(importId) ?? Infinity, pages });
  });

  return groups
    .sort((left, right) => left.position - right.position)
    .flatMap((group) => group.pages);
}

/**
 * The elements that belong on one page of the file (spec §6.4): for a column
 * page, exactly what `pageElements` already decides. For a stacked page: the
 * page element itself (by id, since every page of the import shares one
 * rectangle), every live element stamped `onPage` for that import and index,
 * and every unstamped live element overlapping the document's rectangle
 * (those print on every page). An element stamped for another page -- of this
 * import or another -- never appears here, even if it happens to overlap.
 */
export function exportPageElements(elements: readonly SceneElement[], page: ExportPage): SceneElement[] {
  if (page.kind === 'column') return pageElements(elements, page.rect);

  const liveDocuments = stackedDocuments(elements);
  return elements.filter((element) => {
    if (!live(element)) return false;
    if (element.id === page.id) return true;
    const annotation = onPageStampOf(element);
    // Writing whose own document was removed is ordinary drawing again, as it
    // is on the board (§3.4), so it falls through to the overlap rule below.
    const orphaned = annotation !== null && !liveDocuments.has(annotation.importId);
    if (annotation && !orphaned) return annotation.importId === page.importId && annotation.index === page.index;
    if (!orphaned && hasAnyPageStamp(element)) return false;
    const rect = rectOf(element);
    return rect !== null && overlaps(rect, page.rect);
  });
}

/**
 * The region these elements occupy. The margin defaults to the air a page of
 * leftover drawing wants; pass 0 for the region itself, which is what a page
 * is rendered from.
 */
export function boundingBox(elements: readonly SceneElement[], margin = EXPORT_MARGIN): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const element of elements) {
    const rect = rectOf(element);
    if (!rect) continue;
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  if (!Number.isFinite(minX)) return null;
  return {
    x: minX - margin,
    y: minY - margin,
    width: maxX - minX + 2 * margin,
    height: maxY - minY + 2 * margin,
  };
}

/**
 * How large to render a region: twice its board size, held back so a very big
 * region cannot ask the browser for a canvas it will refuse to allocate.
 */
export function exportRenderScale(width: number, height: number): number {
  return Math.min(EXPORT_SCALE, MAX_EXPORT_SIDE / Math.max(width, height));
}

/** Where a page sits inside a canvas rendered from `box` at `scale`. */
export function cropInCanvas(box: Rect, page: Rect, scale: number): Rect {
  return {
    x: (page.x - box.x) * scale,
    y: (page.y - box.y) * scale,
    width: page.width * scale,
    height: page.height * scale,
  };
}

/** Why a download could not be made. */
export type ExportFailure = 'empty' | 'files-pending' | 'failed';

/** The one plain sentence each failure shows (spec §4). */
export function exportFailureMessage(failure: ExportFailure): string {
  switch (failure) {
    case 'empty':
      return 'Nothing on this board yet.';
    case 'files-pending':
      return 'Some pictures are still loading. Try again in a moment.';
    case 'failed':
      return "Couldn't build the PDF.";
  }
}
