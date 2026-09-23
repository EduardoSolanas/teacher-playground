/**
 * Pure decisions for paged documents (spec/PAGED_DOCUMENTS_SPEC.md §3, §8).
 *
 * A stacked PDF import is an ordinary set of image elements on the board,
 * each stamped with which import and page it belongs to. Which page is
 * *showing* lives outside the scene, in server-held page state (§3.3), so
 * turning a page never edits fifty elements. Everything here reads a scene
 * snapshot plus that page state and answers: which pages exist, which one is
 * showing, and which elements are hidden -- kept apart from the renderer and
 * the fork's `isElementHidden` hook so the logic can be tested without a
 * canvas.
 */
import { MAX_PAGES_PER_IMPORT } from './pdfImport';

/** Every page of one import shares this rectangle (spec §3.1). */
export type Rect = { x: number; y: number; width: number; height: number };

/** A board element as the whiteboard passes it in: only the fields read here. */
export type SceneElement = Record<string, unknown>;

/** One stacked import as it stands in the current scene. */
export type StackedDocument = {
  importId: string;
  /** Pages the import was created with, 1..MAX_PAGES_PER_IMPORT. */
  pageCount: number;
  /** Live page element ids, keyed by their stamped index. Never empty. */
  pages: ReadonlyMap<number, string>;
  /** The shared placement rectangle (spec §3.1: the first page's rectangle). */
  rect: Rect;
};

/** The onPage stamp an annotation carries once it is written on a page. */
export type AnnotationStamp = { importId: string; index: number };

/**
 * The server's per-room page state (spec §3.3): importId -> showing index.
 * A plain record, since it is exactly what `documents:pages` stores as JSON
 * and what a page frame (`pageMessage.ts`) carries one entry of.
 */
export type PageState = Readonly<Record<string, number>>;

/** What `randomHexId(8)` makes at import: 16 lowercase hex characters. */
export const IMPORT_ID_PATTERN = /^[0-9a-f]{16}$/;

type PageStamp = { importId: string; index: number; pageCount: number };

/**
 * Reads and validates `customData.pdfPage` (spec §3.1). Returns null for
 * anything malformed -- wrong shape, a non-hex or wrong-length importId, a
 * pageCount outside 1..MAX_PAGES_PER_IMPORT, an index outside
 * 0..pageCount-1, or a column page that carries no `stacked: true` -- so
 * callers never have to repeat this validation.
 */
function pdfPageStampOf(element: SceneElement): PageStamp | null {
  const customData = element.customData;
  if (customData === null || typeof customData !== 'object') return null;
  const stamp = (customData as { pdfPage?: unknown }).pdfPage;
  if (stamp === null || typeof stamp !== 'object') return null;
  const { importId, index, pageCount, stacked } = stamp as {
    importId?: unknown;
    index?: unknown;
    pageCount?: unknown;
    stacked?: unknown;
  };
  if (stacked !== true) return null;
  if (typeof importId !== 'string' || !IMPORT_ID_PATTERN.test(importId)) return null;
  if (!Number.isInteger(pageCount) || (pageCount as number) < 1 || (pageCount as number) > MAX_PAGES_PER_IMPORT) {
    return null;
  }
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= (pageCount as number)) return null;
  return { importId, index: index as number, pageCount: pageCount as number };
}

/**
 * Reads and validates `customData.onPage` (spec §3.2). Returns null for
 * anything malformed. The upper bound on `index` is not checked against any
 * particular document here -- an annotation's page is only ever compared
 * against a document's own live pages in `isHidden`/`showingIndex`.
 */
export function onPageStampOf(element: SceneElement): AnnotationStamp | null {
  const customData = element.customData;
  if (customData === null || typeof customData !== 'object') return null;
  const stamp = (customData as { onPage?: unknown }).onPage;
  if (stamp === null || typeof stamp !== 'object') return null;
  const { importId, index } = stamp as { importId?: unknown; index?: unknown };
  if (typeof importId !== 'string' || !IMPORT_ID_PATTERN.test(importId)) return null;
  if (!Number.isInteger(index) || (index as number) < 0) return null;
  return { importId, index: index as number };
}

/**
 * Whether an element already carries a page stamp of either kind, checked by
 * key presence rather than full validity: spec §3.2 stamps an element "if
 * ... the element has no `pdfPage` or `onPage` stamp yet", so a malformed but
 * present stamp still counts as already stamped -- the drawing client never
 * overwrites it.
 */
export function hasAnyPageStamp(element: SceneElement): boolean {
  const customData = element.customData;
  if (customData === null || typeof customData !== 'object') return false;
  const data = customData as { pdfPage?: unknown; onPage?: unknown };
  return data.pdfPage != null || data.onPage != null;
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

/** Whether two rectangles share any area. Touching edges do not count. */
function overlaps(left: Rect, right: Rect): boolean {
  return left.x < right.x + right.width
    && right.x < left.x + left.width
    && left.y < right.y + right.height
    && right.y < left.y + left.height;
}

/**
 * Groups the scene's live, validly-stamped stacked pages by import (spec
 * §8). Deleted pages, column pages (no `stacked: true`) and malformed stamps
 * are ignored, as if the element were not a page at all. An import with no
 * live page left is omitted entirely, which is what lets `isHidden` tell "the
 * document was removed" apart from "the document exists but this isn't its
 * page" just by looking up the importId.
 *
 * Assumption (undocumented by the spec): all pages of one import are written
 * with the same `pageCount` and rectangle, so the first live page encountered
 * fixes both for the whole document; a later page that disagrees does not
 * change them. The shared rectangle prefers page index 0's rectangle, falling
 * back to the lowest surviving index if page 0 itself was deleted.
 */
export function stackedDocuments(elements: readonly SceneElement[]): ReadonlyMap<string, StackedDocument> {
  const byImport = new Map<string, { pageCount: number; pages: Map<number, string>; rects: Map<number, Rect> }>();

  for (const element of elements) {
    if (!live(element)) continue;
    const stamp = pdfPageStampOf(element);
    if (!stamp) continue;
    const rect = rectOf(element);
    const id = element.id;
    if (!rect || typeof id !== 'string') continue;

    let entry = byImport.get(stamp.importId);
    if (!entry) {
      entry = { pageCount: stamp.pageCount, pages: new Map(), rects: new Map() };
      byImport.set(stamp.importId, entry);
    }
    entry.pages.set(stamp.index, id);
    entry.rects.set(stamp.index, rect);
  }

  const documents = new Map<string, StackedDocument>();
  for (const [importId, entry] of byImport) {
    const lowestIndex = Math.min(...entry.rects.keys());
    const rect = entry.rects.get(0) ?? entry.rects.get(lowestIndex)!;
    documents.set(importId, { importId, pageCount: entry.pageCount, pages: entry.pages, rect });
  }
  return documents;
}

/**
 * The showing index for a document (spec §3.4), clamped to a page that
 * actually exists: the stored index is first clamped into
 * `0..pageCount-1`, and if that page was deleted, the nearest surviving page
 * (by index distance, ties broken toward the lower index) shows instead of
 * nothing. A missing entry in `pageState` means page 0, as spec §3.3 says.
 */
export function showingIndex(document: StackedDocument, pageState: PageState): number {
  const stored = pageState[document.importId];
  const requested = Number.isInteger(stored)
    ? Math.min(Math.max(stored, 0), document.pageCount - 1)
    : 0;
  if (document.pages.has(requested)) return requested;

  let nearest: number | null = null;
  let bestDistance = Infinity;
  for (const index of document.pages.keys()) {
    const distance = Math.abs(index - requested);
    if (nearest === null || distance < bestDistance || (distance === bestDistance && index < nearest)) {
      nearest = index;
      bestDistance = distance;
    }
  }
  // document.pages is never empty for an entry stackedDocuments produced, but
  // the fallback keeps this total for a hand-built document in a test.
  return nearest ?? requested;
}

/**
 * Whether an element is hidden (spec §3.4): a stacked page not on the
 * showing index of its own import, or an annotation stamped for a page that
 * is not showing -- unless its import has no live page left, in which case
 * it is never hidden. Everything else, including any element without either
 * stamp, is visible.
 */
export function isHidden(
  element: SceneElement,
  documents: ReadonlyMap<string, StackedDocument>,
  pageState: PageState,
): boolean {
  if (!live(element)) return false;

  const pageStamp = pdfPageStampOf(element);
  if (pageStamp) {
    const document = documents.get(pageStamp.importId);
    if (!document) return false;
    return showingIndex(document, pageState) !== pageStamp.index;
  }

  const annotation = onPageStampOf(element);
  if (annotation) {
    const document = documents.get(annotation.importId);
    if (!document) return false; // the import was removed: never hidden
    return showingIndex(document, pageState) !== annotation.index;
  }

  return false;
}

/**
 * The `onPage` stamp to write on a newly finished element (spec §3.2), or
 * null when it should not be stamped: it is already stamped (either kind --
 * a page stamp means the element is a page itself), it has no usable
 * rectangle, or its rectangle does not overlap any stacked document's
 * rectangle (touching edges only does not count).
 *
 * Assumption: if an element's rectangle overlaps more than one stacked
 * document (overlapping imports), it is stamped for the first document in
 * `documents`' iteration order, which is board order for a map built by
 * `stackedDocuments`.
 */
export function annotationStampFor(
  element: SceneElement,
  documents: ReadonlyMap<string, StackedDocument>,
  pageState: PageState,
): AnnotationStamp | null {
  if (!live(element)) return null;
  if (hasAnyPageStamp(element)) return null;
  const rect = rectOf(element);
  if (!rect) return null;

  for (const document of documents.values()) {
    if (overlaps(rect, document.rect)) {
      return { importId: document.importId, index: showingIndex(document, pageState) };
    }
  }
  return null;
}

function idsFor(elements: readonly SceneElement[], importId: string): string[] {
  const ids: string[] = [];
  for (const element of elements) {
    if (!live(element)) continue;
    const id = element.id;
    if (typeof id !== 'string') continue;

    const pageStamp = pdfPageStampOf(element);
    if (pageStamp && pageStamp.importId === importId) {
      ids.push(id);
      continue;
    }
    const annotation = onPageStampOf(element);
    if (annotation && annotation.importId === importId) ids.push(id);
  }
  return ids;
}

/**
 * The live element ids a move of `importId` carries along (spec §6.3): every
 * page of the import plus every element stamped `onPage` for it.
 */
export function elementsToMove(elements: readonly SceneElement[], importId: string): string[] {
  return idsFor(elements, importId);
}

/**
 * The live element ids Remove deletes (spec §6.3): the same set a move
 * carries -- every page of the import plus every element stamped `onPage`
 * for it.
 */
export function elementsToRemove(elements: readonly SceneElement[], importId: string): string[] {
  return idsFor(elements, importId);
}

/** The index after Next, never past the last page. */
export function nextPage(index: number, pageCount: number): number {
  return Math.min(index + 1, pageCount - 1);
}

/** The index after Previous, never before the first page. */
export function previousPage(index: number): number {
  return Math.max(index - 1, 0);
}
