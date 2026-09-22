import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { makePdf } from './pdfFixture';
import {
  appendElement,
  approveFirstWaitingPeer,
  createRoomWithMaxUsers,
  excalidrawRectangle,
  expectWaiting,
  joinExistingRoom,
  newAuthenticatedContext,
  waitForExcalidrawApi,
} from './helpers';

/*
 * Download as PDF (spec/PDF_EXPORT_SPEC.md). The file is built from the scene
 * in the teacher's browser with the editor's own renderer and jsPDF, so the
 * only honest proof is downloading one and reading it back: the page count, the
 * page sizes and their order are the contract a parent opening the file sees.
 */

type PdfFacts = { pages: { width: number; height: number }[] };

/** Reads a downloaded PDF with PDF.js, which the app already depends on. */
async function readPdf(path: string): Promise<PdfFacts> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(path));
  const task = pdfjs.getDocument({ data, useSystemFonts: false });
  const pdf = await task.promise;
  const pages: { width: number; height: number }[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    pages.push({ width: Math.round(viewport.width), height: Math.round(viewport.height) });
  }
  await task.destroy();
  return { pages };
}

async function importPdf(page: Page, pageCount: number): Promise<void> {
  await page.getByTestId('whiteboard-insert-pdf-input').setInputFiles({
    name: 'worksheet.pdf',
    mimeType: 'application/pdf',
    buffer: makePdf(pageCount),
  });
  await expect(page.getByTestId('pdf-import-dialog')).toBeVisible();
  await page.getByTestId('pdf-import-insert').click();
  await expect(page.getByTestId('pdf-import-dialog')).toHaveCount(0, { timeout: 30000 });
}

async function downloadPdf(page: Page): Promise<string> {
  await page.getByTestId('room-title-trigger').click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.getByTestId('room-menu-download-pdf').click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error('the browser kept no file for the download');
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  return path;
}

/** The board rectangle of the first imported page, to write on top of it. */
async function firstPageRect(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate(() => {
    const api = (window as any).__debugExcalidrawApi;
    const pages = (api.getSceneElements() as any[])
      .filter((element) => element.customData?.pdfPage)
      .sort((a, b) => a.customData.pdfPage.index - b.customData.pdfPage.index);
    const first = pages[0];
    return { x: first.x, y: first.y, width: first.width, height: first.height };
  });
}

test.describe('Download as PDF', () => {
  test('a worksheet comes back as one PDF page per page, with the writing on it', async ({ page }) => {
    test.setTimeout(180_000);
    await createRoomWithMaxUsers(page, 'PdfExport', 2);
    await waitForExcalidrawApi(page);

    await importPdf(page, 2);
    const first = await firstPageRect(page);

    // Before any writing, so the difference afterwards is the annotation.
    const clean = await readPdf(await downloadPdf(page));
    expect(clean.pages).toHaveLength(2);
    // The fixture is US Letter, and one board unit is one PDF point.
    expect(clean.pages[0]).toEqual({ width: 612, height: 792 });
    expect(clean.pages[1]).toEqual({ width: 612, height: 792 });

    // Something written on page 1, and something drawn well away from both.
    await appendElement(page, excalidrawRectangle('on-page-1', first.x + 80, first.y + 120));
    await appendElement(page, excalidrawRectangle('far-away', first.x + 4000, first.y - 3000));

    const marked = await readPdf(await downloadPdf(page));
    expect(marked.pages).toHaveLength(3);
    expect(marked.pages[0]).toEqual({ width: 612, height: 792 });
    expect(marked.pages[1]).toEqual({ width: 612, height: 792 });
    // The stray drawing is its own last page, fitted to a 100x50 rectangle
    // plus the export margin on each side.
    expect(marked.pages[2]).toEqual({ width: 148, height: 98 });

    const sizes = await readFile(await downloadPdf(page));
    expect(sizes.byteLength).toBeGreaterThan(1000);
  });

  test('a board with no import exports as one fitted page', async ({ page }) => {
    test.setTimeout(120_000);
    await createRoomWithMaxUsers(page, 'PdfExportPlain', 2);
    await waitForExcalidrawApi(page);
    await appendElement(page, excalidrawRectangle('lonely', 0, 0));

    const file = await readPdf(await downloadPdf(page));
    expect(file.pages).toEqual([{ width: 148, height: 98 }]);
  });

  test('an empty board says so instead of writing a file', async ({ page }) => {
    await createRoomWithMaxUsers(page, 'PdfExportEmpty', 2);
    await waitForExcalidrawApi(page);

    await page.getByTestId('room-title-trigger').click();
    await page.getByTestId('room-menu-download-pdf').click();
    await expect(page.getByTestId('whiteboard-pdf-export-notice'))
      .toHaveText('Nothing on this board yet.');
  });

  test('a student has no way to download the lesson', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const roomId = await createRoomWithMaxUsers(page, 'PdfExportPeer', 2);
    await waitForExcalidrawApi(page);

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'ExportPeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await waitForExcalidrawApi(peerPage);

      await expect(peerPage.getByTestId('room-menu-download-pdf')).toHaveCount(0);
    } finally {
      await peerPage.close();
      await peerContext.close();
    }
  });
});
