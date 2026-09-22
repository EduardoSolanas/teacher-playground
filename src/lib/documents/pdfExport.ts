/**
 * Pure decisions for Download as PDF (spec/PDF_EXPORT_SPEC.md).
 *
 * The file is built in the teacher's browser from the scene already loaded
 * there. What belongs on which PDF page, how large to render it and where a
 * page sits inside an exported canvas are all arithmetic, so they live here
 * rather than beside the canvas and the PDF writer.
 */

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

function rectOf(element: SceneElement): Rect | null {
  const { x, y, width, height } = element as Record<string, number>;
  // Number.isFinite is the whole check: it is false for a string, a boolean,
  // undefined, NaN and Infinity alike, so a typeof guard beside it says nothing.
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  return { x, y, width, height };
}

/**
 * The imported worksheet pages on a board, in the order they should appear in
 * the file: each import in the order its first page appears on the board, and
 * within an import by the page index the import stamped, never by scene order
 * — a page moved or redrawn does not reorder the worksheet.
 */
export function worksheetPages(elements: readonly SceneElement[]): WorksheetPage[] {
  // A Map keeps the order its keys were first set in, which is exactly the
  // order the imports first appear on the board -- no sort needed for it.
  const imports = new Map<string, { index: number; page: WorksheetPage }[]>();
  elements.forEach((element) => {
    if (!live(element)) return;
    const stamp = stampOf(element);
    if (!stamp) return;
    const rect = rectOf(element);
    const id = element.id;
    if (!rect || typeof id !== 'string') return;
    const group = imports.get(stamp.importId) ?? [];
    group.push({ index: stamp.index, page: { id, rect } });
    imports.set(stamp.importId, group);
  });

  return [...imports.values()].flatMap((group) => group
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.page));
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
  return elements.filter((element) => {
    if (!live(element) || stampOf(element)) return false;
    const rect = rectOf(element);
    if (!rect) return false;
    return !pages.some((page) => overlaps(rect, page));
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
