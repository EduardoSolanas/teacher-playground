import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  MAX_PDF_BYTES,
  PAGE_FRAME_COLOR,
  classifyPdfError,
  pageEncodingFor,
  pageFrame,
  rasterScale,
  type PdfImportFailure,
} from '@/lib/documents/pdfImport';

/**
 * PDF.js in the importing browser (spec/PDF_IMPORT_SPEC.md §4).
 *
 * Everything here needs a real canvas, so it is proved by
 * tests/e2e/pdf-import.spec.ts rather than jsdom; the decisions it applies live
 * in src/lib/documents/pdfImport.ts and are unit- and mutation-tested there.
 *
 * PDF.js is imported on first use, never at module load: it is a large bundle
 * that only a teacher inserting a PDF should pay for.
 */

/** Where scripts/copy-pdfjs-assets.mjs puts PDF.js's runtime data. */
const ASSET_BASE = '/pdfjs/';

/** One rendered page, ready for Excalidraw's `addFiles`. */
export type RenderedPage = {
  /** SHA-1 hex of the encoded bytes: content-addressed like any board file. */
  id: string;
  mimeType: 'image/webp' | 'image/jpeg';
  dataURL: string;
  /** The page's size in PDF units, which is the size it is placed at. */
  width: number;
  height: number;
};

export type OpenResult =
  | {
    ok: true;
    pdf: PDFDocumentProxy;
    /** Frees the parsed file and its worker state; pdf.js 6 destroys through the loading task. */
    destroy: () => Promise<void>;
  }
  | { ok: false; failure: PdfImportFailure };

let workerPort: Worker | null = null;

async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  if (!workerPort) {
    // A same-origin bundle chunk, so `worker-src 'self'` admits it unchanged.
    workerPort = new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), {
      type: 'module',
    });
    pdfjs.GlobalWorkerOptions.workerPort = workerPort;
  }
  return pdfjs;
}

/** Opens a file the user chose. The bytes never leave this browser. */
export async function openPdf(file: File): Promise<OpenResult> {
  if (file.size > MAX_PDF_BYTES) return { ok: false, failure: { kind: 'too-large' } };
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  /*
   * No isEvalSupported here: pdf.js 6 removed the option along with every
   * eval path (CVE-2024-4367 was font code reaching one), and this app's CSP
   * has no 'unsafe-eval' to allow one anyway.
   */
  const task = pdfjs.getDocument({
    data,
    enableXfa: false,
    /*
     * Draw the 14 standard fonts from PDF.js's own data, not the machine's.
     * The browser default substitutes whatever system font is nearest, so the
     * same worksheet came out differently on a Chromebook and on Windows --
     * and the pages are images every student sees exactly as rendered here.
     */
    useSystemFonts: false,
    standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
    cMapUrl: `${ASSET_BASE}cmaps/`,
    cMapPacked: true,
    wasmUrl: `${ASSET_BASE}wasm/`,
  });
  try {
    const pdf = await task.promise;
    return { ok: true, pdf, destroy: () => task.destroy() };
  } catch (error) {
    void task.destroy();
    return { ok: false, failure: classifyPdfError(error) };
  }
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas produced no image'))), type, quality);
  });
}

function blobDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('could not read the page image'));
    reader.readAsDataURL(blob);
  });
}

async function sha1Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Renders one 1-based page to an encoded image on a white background. */
export async function renderPage(pdf: PDFDocumentProxy, pageNumber: number): Promise<RenderedPage> {
  const page = await pdf.getPage(pageNumber);
  const canvas = document.createElement('canvas');
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = rasterScale(base.width, base.height);
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, viewport, background: '#ffffff' }).promise;

    const context = canvas.getContext('2d');
    if (context) {
      const frame = pageFrame(canvas.width, canvas.height, scale);
      context.strokeStyle = PAGE_FRAME_COLOR;
      context.lineWidth = frame.lineWidth;
      context.strokeRect(frame.x, frame.y, frame.width, frame.height);
    }

    // Safari hands back PNG for a WebP request; the produced type decides.
    let blob = await canvasBlob(canvas, 'image/webp', 0.85);
    const mimeType = pageEncodingFor(blob.type);
    if (mimeType === 'image/jpeg') blob = await canvasBlob(canvas, 'image/jpeg', 0.9);

    return {
      id: await sha1Hex(await blob.arrayBuffer()),
      mimeType,
      dataURL: await blobDataURL(blob),
      width: base.width,
      height: base.height,
    };
  } finally {
    // Release the pixels now rather than whenever the collector gets to them:
    // fifty 2000px canvases is a lot to hold on a Chromebook.
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
}
