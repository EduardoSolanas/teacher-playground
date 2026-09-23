/**
 * Pure decisions for PDF import (spec/PDF_IMPORT_SPEC.md). The PDF is rendered
 * in the importing browser and its pages become ordinary board images, so
 * nothing here touches the server: these are the choices the dialog and the
 * renderer make, kept apart from PDF.js and the canvas so they can be tested.
 */

/** Largest PDF the browser will open (spec §4): bounds memory on Chromebooks. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

/** Most pages one import may insert (spec §4): bounds render time and quota. */
export const MAX_PAGES_PER_IMPORT = 50;

/** Board units between stacked pages. */
export const PAGE_GAP = 40;

const MAX_RASTER_SIDE = 2000;
const MAX_UPSCALE = 3;

/** The range the dialog proposes: every page, up to the import cap. */
export function defaultPageRange(pageCount: number): string {
  const last = Math.min(pageCount, MAX_PAGES_PER_IMPORT);
  return last === 1 ? '1' : `1-${last}`;
}

export type PageRangeResult =
  | { ok: true; pages: number[] }
  | { ok: false; message: string };

const PART_PATTERN = /^(\d+)(?:\s*-\s*(\d+))?$/;

/**
 * Parses a choice such as "1-3, 5" into ascending, unique, 1-based pages.
 * Every page must exist, and the choice may not exceed the import cap.
 */
export function parsePageRange(input: string, pageCount: number): PageRangeResult {
  const parts = input.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) return { ok: false, message: 'Choose at least one page.' };

  const pages = new Set<number>();
  for (const part of parts) {
    const match = PART_PATTERN.exec(part);
    if (!match) return { ok: false, message: 'Use page numbers like 1-3, 5.' };
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (last < first) return { ok: false, message: 'Write ranges low to high, like 3-5.' };
    if (first < 1 || last > pageCount) {
      return { ok: false, message: `This PDF has pages 1 to ${pageCount}.` };
    }
    for (let page = first; page <= last; page += 1) pages.add(page);
  }

  if (pages.size > MAX_PAGES_PER_IMPORT) {
    return { ok: false, message: `Insert at most ${MAX_PAGES_PER_IMPORT} pages at a time.` };
  }
  return { ok: true, pages: [...pages].sort((a, b) => a - b) };
}

/**
 * The render scale for a page of the given size in PDF units: its longest side
 * becomes 2000 px, without enlarging a small page more than 3x. The side limit
 * alone keeps every page within 4 million pixels.
 */
export function rasterScale(width: number, height: number): number {
  return Math.min(MAX_RASTER_SIDE / Math.max(width, height), MAX_UPSCALE);
}

/** The hairline colour the room uses for borders (Tailwind slate-300). */
export const PAGE_FRAME_COLOR = '#cbd5e1';

/**
 * The border drawn into a rendered page. A white page on a white board has no
 * visible edge, so without one a teacher cannot see where a page ends or where
 * the next begins. Drawn into the image rather than the board, so every peer
 * sees the same edge. About one page unit wide, never under 2 px, and inset by
 * half its width so the canvas does not clip it.
 */
export function pageFrame(
  canvasWidth: number,
  canvasHeight: number,
  scale: number,
): { x: number; y: number; width: number; height: number; lineWidth: number } {
  const lineWidth = Math.max(2, Math.round(scale));
  const inset = lineWidth / 2;
  return {
    x: inset,
    y: inset,
    width: canvasWidth - lineWidth,
    height: canvasHeight - lineWidth,
    lineWidth,
  };
}

export type PageSize = { width: number; height: number };
export type PagePlacement = { x: number; y: number; width: number; height: number };

/**
 * Stacks pages top to bottom from `origin`, each at its PDF size in board
 * units, so a page looks page-sized whatever resolution it was rendered at.
 */
export function columnLayout(sizes: readonly PageSize[], origin: { x: number; y: number }): PagePlacement[] {
  const placements: PagePlacement[] = [];
  let y = origin.y;
  for (const size of sizes) {
    placements.push({ x: origin.x, y, width: size.width, height: size.height });
    y += size.height + PAGE_GAP;
  }
  return placements;
}

export type StackedRect = { x: number; y: number; width: number; height: number };

/**
 * Fits a page of size `pageSize` inside `firstPageRect`, centred, keeping its
 * own aspect ratio (spec/PAGED_DOCUMENTS_SPEC.md §3.1): every page of a
 * stacked import shares the first page's rectangle, but a page whose PDF
 * size differs is shown scaled down (never up) to fit inside it rather than
 * stretched or cropped. The binding dimension -- the one that would reach the
 * rectangle's edge first -- is whichever gives the smaller scale.
 */
export function stackedPageRect(pageSize: PageSize, firstPageRect: StackedRect): StackedRect {
  const scale = Math.min(firstPageRect.width / pageSize.width, firstPageRect.height / pageSize.height);
  const width = pageSize.width * scale;
  const height = pageSize.height * scale;
  return {
    x: firstPageRect.x + (firstPageRect.width - width) / 2,
    y: firstPageRect.y + (firstPageRect.height - height) / 2,
    width,
    height,
  };
}

/**
 * The encoding to keep for a page. A canvas that cannot encode WebP (Safari)
 * silently returns PNG instead, so the produced type decides, never the
 * request; anything but WebP is re-encoded as JPEG.
 */
export function pageEncodingFor(producedType: string): 'image/webp' | 'image/jpeg' {
  return producedType === 'image/webp' ? 'image/webp' : 'image/jpeg';
}

export type PdfImportFailure =
  | { kind: 'invalid' }
  | { kind: 'password' }
  | { kind: 'too-large' }
  | { kind: 'page'; page: number };

/** Maps what PDF.js threw while opening a file to a failure the dialog shows. */
export function classifyPdfError(error: unknown): PdfImportFailure {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'PasswordException' ? { kind: 'password' } : { kind: 'invalid' };
}

/** The one plain sentence each failure shows (spec §5). */
export function failureMessage(failure: PdfImportFailure): string {
  switch (failure.kind) {
    case 'password':
      return 'This PDF is password protected. Remove the password and try again.';
    case 'too-large':
      return 'This PDF is larger than 50 MB.';
    case 'page':
      return `Page ${failure.page} couldn't be rendered.`;
    case 'invalid':
      return "This file isn't a PDF we can open.";
  }
}
