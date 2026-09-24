import { exportToCanvas } from '@teacher-playground/excalidraw';
import {
  EXPORT_JPEG_QUALITY,
  boundingBox,
  cropInCanvas,
  exportRenderScale,
  leftoverElements,
  pageElements,
  worksheetPages,
  type ExportFailure,
  type Rect,
  type SceneElement,
} from '@/lib/documents/pdfExport';

/**
 * Building the PDF (spec/PDF_EXPORT_SPEC.md).
 *
 * Needs a real canvas and the editor's own renderer, so it is proved by
 * tests/e2e/pdf-export.spec.ts; what belongs on which page is decided in
 * src/lib/documents/pdfExport.ts and unit-tested there.
 *
 * jsPDF is imported on first use: only a teacher downloading a lesson should
 * pay for it.
 */

export type ExportScene = {
  elements: readonly SceneElement[];
  files: Record<string, unknown>;
};

export type ExportResult = { ok: true; blob: Blob } | { ok: false; failure: ExportFailure };

/** A page of the file: the region to draw, and the elements that appear on it. */
type PlannedPage = { box: Rect; elements: readonly SceneElement[] };

function plan(elements: readonly SceneElement[]): PlannedPage[] {
  const pages = worksheetPages(elements);
  const planned: PlannedPage[] = pages.map((page) => ({
    // Rendered from the page's own rectangle, so the PDF page is the worksheet
    // page: an annotation hanging off the edge is cropped, as it looks on the
    // board. The bounding box of the drawn elements would grow the page instead.
    box: page.rect,
    elements: pageElements(elements, page.rect),
  }));

  const leftover = leftoverElements(elements, pages.map((page) => page.rect));
  const box = boundingBox(leftover);
  if (box) planned.push({ box, elements: leftover });
  return planned;
}

/**
 * Whether every image on the board has its bytes. An element whose file has
 * not arrived renders as a placeholder, and a PDF of placeholders is worse
 * than being told to wait.
 */
function filesReady(elements: readonly SceneElement[], files: Record<string, unknown>): boolean {
  return elements.every((element) => {
    if (element.type !== 'image' || element.isDeleted === true) return true;
    const fileId = element.fileId;
    return typeof fileId === 'string' && files[fileId] !== undefined;
  });
}

async function renderRegion(
  scene: ExportScene,
  page: PlannedPage,
): Promise<{ dataUrl: string; box: Rect }> {
  const scale = exportRenderScale(page.box.width, page.box.height);
  const canvas = await exportToCanvas({
    elements: page.elements as never,
    files: scene.files as never,
    appState: { exportBackground: true, viewBackgroundColor: '#ffffff' } as never,
    exportPadding: 0,
    getDimensions: (width: number, height: number) => ({ width, height, scale }),
  } as never) as HTMLCanvasElement;

  /*
   * exportToCanvas sizes the canvas to the elements it was given, which is not
   * the page: an annotation inside the page shrinks it, one crossing the edge
   * grows it. Draw it into a canvas that is exactly the page instead, so every
   * PDF page is the worksheet page at its own size.
   */
  const target = document.createElement('canvas');
  target.width = Math.round(page.box.width * scale);
  target.height = Math.round(page.box.height * scale);
  const context = target.getContext('2d');
  if (!context) throw new Error('no 2d context for the export canvas');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, target.width, target.height);

  const drawn = boundingBox(page.elements, 0);
  if (drawn) {
    // exportToCanvas renders the elements' own region with no padding, so the
    // canvas holds `drawn`, not the page. Place it where it belongs inside the
    // page and let anything outside fall off the edge.
    const rendered = cropInCanvas(page.box, drawn, scale);
    context.drawImage(canvas, rendered.x, rendered.y, rendered.width, rendered.height);
  }

  const dataUrl = target.toDataURL('image/jpeg', EXPORT_JPEG_QUALITY);
  canvas.width = 0;
  canvas.height = 0;
  target.width = 0;
  target.height = 0;
  return { dataUrl, box: page.box };
}

function orientationOf(box: Rect): 'landscape' | 'portrait' {
  return box.width > box.height ? 'landscape' : 'portrait';
}

/** Builds the whole file, or fails without writing anything. */
export async function buildBoardPdf(scene: ExportScene): Promise<ExportResult> {
  const pages = plan(scene.elements);
  if (pages.length === 0) return { ok: false, failure: 'empty' };
  if (!filesReady(scene.elements, scene.files)) return { ok: false, failure: 'files-pending' };

  try {
    const { jsPDF } = await import('jspdf');
    const first = await renderRegion(scene, pages[0]);
    // One board unit is one PDF point, so an imported Letter page comes out
    // Letter and an A4 page comes out A4.
    const file = new jsPDF({
      orientation: orientationOf(first.box),
      unit: 'pt',
      format: [first.box.width, first.box.height],
    });
    file.addImage(first.dataUrl, 'JPEG', 0, 0, first.box.width, first.box.height);

    for (const page of pages.slice(1)) {
      const { dataUrl, box } = await renderRegion(scene, page);
      file.addPage([box.width, box.height], orientationOf(box));
      file.addImage(dataUrl, 'JPEG', 0, 0, box.width, box.height);
    }
    return { ok: true, blob: file.output('blob') };
  } catch {
    return { ok: false, failure: 'failed' };
  }
}
