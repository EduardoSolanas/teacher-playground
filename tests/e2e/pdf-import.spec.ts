import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { makeNotAPdf, makePdf } from './pdfFixture';
import {
  appUrl,
  approveFirstWaitingPeer,
  createRoomWithMaxUsers,
  expectWaiting,
  joinExistingRoom,
  newAuthenticatedContext,
  waitForExcalidrawApi,
} from './helpers';

/*
 * Insert PDF (spec/PDF_IMPORT_SPEC.md). The PDF is rendered by PDF.js in the
 * teacher's browser and only page images reach the room, so the whole feature
 * has to be proved in a real browser: jsdom has no canvas, and the parts that
 * break in practice -- the PDF.js worker loading under this app's CSP, the
 * standard fonts arriving from our own origin, the images travelling to a peer
 * -- only exist here.
 */

type SceneImage = {
  fileId: string;
  y: number;
  locked: boolean;
  isDeleted: boolean;
  stamp: { importId?: unknown; index?: unknown } | null;
};

async function sceneImages(page: Page): Promise<SceneImage[]> {
  return page.evaluate(() => {
    const api = (window as any).__debugExcalidrawApi;
    const elements = (api?.getSceneElements?.() ?? []) as any[];
    return elements
      .filter((element) => element.type === 'image' && !element.isDeleted)
      .map((element) => ({
        fileId: element.fileId,
        y: element.y,
        locked: element.locked === true,
        isDeleted: element.isDeleted === true,
        stamp: element.customData?.pdfPage ?? null,
      }))
      .sort((a, b) => a.y - b.y);
  });
}

/** Records every CSP refusal on the page, which is how a blocked worker or font shows up. */
async function recordCspViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    (window as any).__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as any).__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return () => page.evaluate(() => (window as any).__cspViolations as string[]);
}

async function choosePdf(page: Page, name: string, bytes: Buffer): Promise<void> {
  await page.getByTestId('whiteboard-insert-pdf-input').setInputFiles({
    name,
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await expect(page.getByTestId('pdf-import-dialog')).toBeVisible();
}

test.describe('PDF import', () => {
  test('a teacher inserts a PDF and a student sees one locked page per image, in order', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const roomId = await createRoomWithMaxUsers(page, 'PdfHost', 2);
    await waitForExcalidrawApi(page);
    const violations = await recordCspViolations(page);
    // PDF.js's own data must come from this origin and actually arrive: a
    // refused or missing font makes PDF.js fall back without failing.
    const pdfjsResponses: string[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/pdfjs/')) {
        pdfjsResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
      }
    });

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'PdfPeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await waitForExcalidrawApi(peerPage);

      // Only the owner's footer carries the action.
      await expect(peerPage.getByTestId('whiteboard-insert-pdf')).toHaveCount(0);

      await choosePdf(page, 'worksheet.pdf', makePdf(3));
      await expect(page.getByTestId('pdf-import-range')).toHaveValue('1-3');
      /*
       * The room's remaining space, read from the owner-only settings surface.
       * Without it the 250 MB cap announced itself as an upload failing in the
       * middle of an import.
       */
      await expect(page.getByTestId('pdf-import-storage')).toHaveText(/free in this room$/);
      await page.getByTestId('pdf-import-insert').click();
      await expect(page.getByTestId('pdf-import-dialog')).toHaveCount(0, { timeout: 30000 });

      const hostImages = await sceneImages(page);
      expect(hostImages).toHaveLength(3);
      expect(hostImages.every((image) => image.locked)).toBe(true);
      expect(new Set(hostImages.map((image) => image.fileId)).size).toBe(3);

      /*
       * Each page carries the import it came from and its place in it, which is
       * what Download as PDF reads back (spec/PDF_EXPORT_SPEC.md §3).
       */
      const stamps = hostImages.map((image) => image.stamp as { importId: string; index: number });
      expect(stamps.map((stamp) => stamp.index)).toEqual([0, 1, 2]);
      expect(new Set(stamps.map((stamp) => stamp.importId)).size).toBe(1);

      // Each page reaches the room's file store as an image, never as a PDF.
      for (const image of hostImages) {
        await expect
          .poll(async () => {
            const response = await page.request.get(appUrl(`/api/whiteboard/room/${roomId}/files/${image.fileId}`));
            return response.ok() ? response.headers()['content-type'] : String(response.status());
          }, { timeout: 30000, message: `page ${image.fileId} never reached the room store` })
          .toMatch(/^image\/(webp|jpeg)/);
      }

      // The student gets the same three pages in the same order.
      await expect
        .poll(async () => (await sceneImages(peerPage)).map((image) => image.fileId), { timeout: 30000 })
        .toEqual(hostImages.map((image) => image.fileId));

      expect(await violations()).toEqual([]);
      // The fixture names Helvetica without embedding it, so a standard font is fetched.
      expect(pdfjsResponses.some((line) => line.includes('/pdfjs/standard_fonts/'))).toBe(true);
      expect(pdfjsResponses.filter((line) => !line.startsWith('200 '))).toEqual([]);
    } finally {
      await peerPage.close();
      await peerContext.close();
    }
  });

  test('at phone width the owner inserts from the title menu', async ({ page }) => {
    // Excalidraw draws no footer at this width, so the footer's button is gone.
    await page.setViewportSize({ width: 390, height: 844 });
    await createRoomWithMaxUsers(page, 'PdfPhone', 2);
    await waitForExcalidrawApi(page);
    await expect(page.getByTestId('whiteboard-insert-pdf')).toHaveCount(0);

    await page.getByTestId('room-title-trigger').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('room-menu-insert-pdf').click(),
    ]);
    await chooser.setFiles({ name: 'worksheet.pdf', mimeType: 'application/pdf', buffer: makePdf(2) });
    await expect(page.getByTestId('pdf-import-dialog')).toBeVisible();
    await page.getByTestId('pdf-import-insert').click();
    await expect.poll(async () => (await sceneImages(page)).length, { timeout: 30000 }).toBe(2);
  });

  test('one undo takes the whole import away', async ({ page }) => {
    await createRoomWithMaxUsers(page, 'PdfUndo', 2);
    await waitForExcalidrawApi(page);

    await choosePdf(page, 'worksheet.pdf', makePdf(3));
    await page.getByTestId('pdf-import-insert').click();
    await expect.poll(async () => (await sceneImages(page)).length, { timeout: 30000 }).toBe(3);

    await page.locator('canvas.excalidraw__canvas.interactive').first().click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await sceneImages(page)).length, { timeout: 10000 }).toBe(0);
  });

  test('a page range inserts only the chosen pages and refuses a bad one', async ({ page }) => {
    await createRoomWithMaxUsers(page, 'PdfRange', 2);
    await waitForExcalidrawApi(page);

    await choosePdf(page, 'worksheet.pdf', makePdf(5));
    const range = page.getByTestId('pdf-import-range');
    await expect(range).toHaveValue('1-5');

    await range.fill('4-9');
    await page.getByTestId('pdf-import-insert').click();
    await expect(page.getByTestId('pdf-import-range-error')).toHaveText('This PDF has pages 1 to 5.');

    await range.fill('2, 4');
    await page.getByTestId('pdf-import-insert').click();
    await expect.poll(async () => (await sceneImages(page)).length, { timeout: 30000 }).toBe(2);
  });

  test('a file that is not a PDF shows the message and changes nothing', async ({ page }) => {
    await createRoomWithMaxUsers(page, 'PdfBroken', 2);
    await waitForExcalidrawApi(page);

    await choosePdf(page, 'lesson.pdf', makeNotAPdf());
    await expect(page.getByTestId('pdf-import-error')).toHaveText("This file isn't a PDF we can open.");
    await page.getByTestId('pdf-import-close').click();
    await expect(page.getByTestId('pdf-import-dialog')).toHaveCount(0);
    expect(await sceneImages(page)).toEqual([]);
  });

  test('cancelling while pages render inserts nothing', async ({ page }) => {
    await createRoomWithMaxUsers(page, 'PdfCancel', 2);
    await waitForExcalidrawApi(page);

    await choosePdf(page, 'long.pdf', makePdf(50));
    await page.getByTestId('pdf-import-insert').click();
    await expect(page.getByTestId('pdf-import-progress')).toBeVisible();
    await page.getByTestId('pdf-import-cancel').click();
    await expect(page.getByTestId('pdf-import-dialog')).toHaveCount(0);

    // Proving it stays empty needs a moment for any late render to land.
    await page.waitForTimeout(2000);
    expect(await sceneImages(page)).toEqual([]);
  });
});
