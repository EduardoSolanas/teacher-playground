/**
 * Pure decisions for taking a PDF in by drop or paste (spec/PDF_IMPORT_SPEC.md
 * §3): there is no menu item, footer button or file picker for PDFs, so these
 * are the choices the capture-phase drop/paste handlers make before anything
 * touches PDF.js, the canvas, or the board.
 */

import { MAX_PAGES_PER_IMPORT, PAGE_GAP } from './pdfImport';

/** The bit of a `File`/`DataTransferItem` these decisions need. */
export type FileLike = { type: string; name: string };

/**
 * A file counts as a PDF by its declared type or, failing that, by a `.pdf`
 * name (spec §3): some browsers report no type for a file picked from certain
 * sources, and PDF.js itself decides whether the bytes really are a PDF.
 */
export function isPdfFile(file: FileLike): boolean {
  if (file.type === 'application/pdf') return true;
  return /\.pdf$/i.test(file.name);
}

/** Every PDF in a drop or paste, in the order they were offered. */
export function pdfsInDrop<T extends FileLike>(files: readonly T[]): T[] {
  return files.filter(isPdfFile);
}

/**
 * Whether a drop that holds at least one PDF also holds something that is
 * not a PDF (spec §3: "Only the PDF was added. Drop pictures on their own.").
 * A drop with no PDF at all is not this handler's concern, so it reads false.
 */
export function someNonPdf(files: readonly FileLike[]): boolean {
  const pdfCount = pdfsInDrop(files).length;
  if (pdfCount === 0) return false;
  return files.length > pdfCount;
}

/** Whether a PDF this long needs the teacher to choose which pages (spec §3). */
export function needsPageRangeChoice(pageCount: number): boolean {
  return pageCount > MAX_PAGES_PER_IMPORT;
}

export type DocumentOrigin = { x: number; y: number };
export type FirstPageSize = { width: number; height: number };

/**
 * Where each document of a multi-file drop is placed: the first is centred on
 * the drop point (or the view centre for a paste), and each further document
 * goes beside the last, with a page gap between them (spec §3).
 */
export function documentOrigins(
  firstPageSizes: readonly FirstPageSize[],
  centre: DocumentOrigin,
): DocumentOrigin[] {
  const origins: DocumentOrigin[] = [];
  let x = centre.x;
  for (const size of firstPageSizes) {
    origins.push({ x: x - size.width / 2, y: centre.y - size.height / 2 });
    x += size.width + PAGE_GAP;
  }
  return origins;
}

/** The bit of a `DataTransferItem` the dragover hint needs. */
export type DragItemLike = { type: string };

/**
 * Whether a dragover carries a PDF, for the "Drop to add this PDF" hint.
 * Safari may report no item types at all while dragging; that shows no hint,
 * but the drop itself still works by name (spec §3), so this is a hint only,
 * never the gate on whether a drop is accepted.
 */
export function dragOverHasPdf(items: readonly DragItemLike[] | null | undefined): boolean {
  if (!items) return false;
  return items.some((item) => item.type === 'application/pdf');
}

/** The status line while a page renders (spec §3). */
export function addingPageMessage(pageNumber: number, total: number): string {
  return `Adding page ${pageNumber} of ${total}…`;
}

/** Shown when someone who is not the room owner drops or pastes a PDF (spec §3). */
export const NOT_OWNER_MESSAGE = 'Only the teacher can add a PDF.';

/** Shown when a drop held a PDF alongside something else (spec §3). */
export const MIXED_DROP_MESSAGE = 'Only the PDF was added. Drop pictures on their own.';
