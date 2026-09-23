import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { makeNotAPdf, makePdf } from './pdfFixture';
import { makePhotoPng } from './pngFixture';
import { dropMixedOnBoard, dropPdfAt, dropPdfOnBoard, dropPdfsOnBoard, dropPictureOnBoard, pastePdfOnBoard } from './pdfDrop';
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
 * A PDF comes in by drop or paste, with no menu item, footer button or file
 * picker (spec/PDF_IMPORT_SPEC.md §3). The PDF is rendered by PDF.js in the
 * teacher's browser and only page images reach the room, so the whole feature
 * has to be proved in a real browser: jsdom has no canvas, and the parts that
 * break in practice -- the PDF.js worker loading under this app's CSP, the
 * standard fonts arriving from our own origin, the images travelling to a peer
 * -- only exist here.
 */

type SceneImage = {
  fileId: string;
  x: number;
  y: number;
  width: number;
  height: number;
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
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        locked: element.locked === true,
        isDeleted: element.isDeleted === true,
        stamp: element.customData?.pdfPage ?? null,
      }))
      .sort((a, b) => a.y - b.y);
  });
}

/** The scene point a viewport point maps to right now, using the app's own formula. */
async function expectedSceneCentre(page: Page, clientX: number, clientY: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ clientX, clientY }) => {
    const api = (window as any).__debugExcalidrawApi;
    const appState = api.getAppState();
    const zoom = appState.zoom.value;
    return {
      x: (clientX - appState.offsetLeft) / zoom - appState.scrollX,
      y: (clientY - appState.offsetTop) / zoom - appState.scrollY,
    };
  }, { clientX, clientY });
}

test.describe('PDF import', () => {
  test('a teacher drops a PDF and a student sees one locked page per image, in order, near the drop point', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const roomId = await createRoomWithMaxUsers(page, 'PdfHost', 2);
    await waitForExcalidrawApi(page);
    const cspViolations: string[] = [];
    await page.evaluate(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        (window as any).__cspViolations = (window as any).__cspViolations ?? [];
        (window as any).__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
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

      // No menu item, footer button or file picker exists for PDFs any more.
      await expect(page.getByTestId('whiteboard-insert-pdf')).toHaveCount(0);
      await expect(page.getByTestId('whiteboard-insert-pdf-input')).toHaveCount(0);
      await page.getByTestId('room-title-trigger').click();
      await expect(page.getByTestId('room-menu-insert-pdf')).toHaveCount(0);
      await page.keyboard.press('Escape');

      const box = await page.getByTestId('whiteboard-canvas-area').boundingBox();
      if (!box) throw new Error('no canvas area box');
      const dropX = box.x + box.width / 2 + 120;
      const dropY = box.y + box.height / 2 - 80;
      const expected = await expectedSceneCentre(page, dropX, dropY);

      await dropPdfAt(page, 'worksheet.pdf', makePdf(3), dropX, dropY);

      await expect
        .poll(async () => (await sceneImages(page)).length, { timeout: 30000 })
        .toBe(3);

      const hostImages = await sceneImages(page);
      expect(hostImages.every((image) => image.locked)).toBe(true);
      expect(new Set(hostImages.map((image) => image.fileId)).size).toBe(3);

      // The first page is centred near the drop point.
      const first = hostImages[0];
      expect(first.x + first.width / 2).toBeCloseTo(expected.x, 0);
      expect(first.y + first.height / 2).toBeCloseTo(expected.y, 0);

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

      expect((await page.evaluate(() => (window as any).__cspViolations ?? []))).toEqual([]);
      // The fixture names Helvetica without embedding it, so a standard font is fetched.
      expect(pdfjsResponses.some((line) => line.includes('/pdfjs/standard_fonts/'))).toBe(true);
      expect(pdfjsResponses.filter((line) => !line.startsWith('200 '))).toEqual([]);
    } finally {
      await peerPage.close();
      await peerContext.close();
    }
  });

  test('one undo takes the whole import away', async ({ page }) => {
    await createRoomWithMaxUsers(page, 'PdfUndo', 2);
    await waitForExcalidrawApi(page);

    await dropPdfOnBoard(page, 'worksheet.pdf', makePdf(3));
    await expect.poll(async () => (await sceneImages(page)).length, { timeout: 30000 }).toBe(3);

    await page.locator('canvas.excalidraw__canvas.interactive').first().click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await sceneImages(page)).length, { timeout: 10000 }).toBe(0);
  });

  test('cancelling while pages render inserts nothing', async ({ page }) => {
    await createRoomWithMaxUsers(page, 'PdfCancel', 2);
    await waitForExcalidrawApi(page);

    // A 50-page PDF does not ask for a range, so it renders straight away.
    await dropPdfOnBoard(page, 'long.pdf', makePdf(50));
    await expect(page.getByTestId('whiteboard-pdf-import-notice')).toBeVisible();
    await page.getByTestId('pdf-import-cancel').click();

    // Proving it stays empty needs a moment for any late render to land.
    await page.waitForTimeout(2000);
    expect(await sceneImages(page)).toEqual([]);
  });

  test('a corrupt .pdf shows the message and changes nothing', async ({ page }) => {
    await createRoomWithMaxUsers(page, 'PdfBroken', 2);
    await waitForExcalidrawApi(page);

    await dropPdfOnBoard(page, 'lesson.pdf', makeNotAPdf());
    await expect(page.getByTestId('whiteboard-pdf-import-notice'))
      .toHaveText("This file isn't a PDF we can open.");
    expect(await sceneImages(page)).toEqual([]);
  });

  test('a 61-page PDF asks which pages, and the default adds the first 50', async ({ page }) => {
    test.setTimeout(180_000);
    await createRoomWithMaxUsers(page, 'PdfLong', 2);
    await waitForExcalidrawApi(page);

    await dropPdfOnBoard(page, 'big.pdf', makePdf(61));
    await expect(page.getByTestId('pdf-import-dialog')).toBeVisible();
    await expect(page.getByTestId('pdf-import-range')).toHaveValue('1-50');
    await page.getByTestId('pdf-import-insert').click();
    await expect(page.getByTestId('pdf-import-dialog')).toHaveCount(0);

    await expect.poll(async () => (await sceneImages(page)).length, { timeout: 60000 }).toBe(50);
  });

  test('a student who drops a PDF adds nothing and sees the owner-only message', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'PdfStudent', 2);
    await waitForExcalidrawApi(page);

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'PdfNotOwner');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await waitForExcalidrawApi(peerPage);

      await dropPdfOnBoard(peerPage, 'worksheet.pdf', makePdf(2));
      await expect(peerPage.getByTestId('whiteboard-pdf-import-notice'))
        .toHaveText('Only the teacher can add a PDF.');

      // Give any wrongly-started render a moment, then confirm nothing landed
      // on either browser -- the server refuses these elements in any case.
      await page.waitForTimeout(1500);
      expect(await sceneImages(peerPage)).toEqual([]);
      expect(await sceneImages(page)).toEqual([]);
    } finally {
      await peerPage.close();
      await peerContext.close();
    }
  });

  test('a drop of only a picture still adds the picture', async ({ page }) => {
    await createRoomWithMaxUsers(page, 'PdfPicture', 2);
    await waitForExcalidrawApi(page);

    await dropPictureOnBoard(page, 'photo.png', makePhotoPng(40, 30), 'image/png');

    await expect.poll(async () => (await sceneImages(page)).length, { timeout: 15000 }).toBe(1);
    // An ordinary picture, not a PDF page: unlocked and carrying no page stamp.
    const [picture] = await sceneImages(page);
    expect(picture.locked).toBe(false);
    expect(picture.stamp).toBeNull();
  });

  test('a mixed drop adds only the PDF and says so', async ({ page }) => {
    test.setTimeout(120_000);
    await createRoomWithMaxUsers(page, 'PdfMixed', 2);
    await waitForExcalidrawApi(page);

    await dropMixedOnBoard(
      page,
      { name: 'worksheet.pdf', bytes: makePdf(1) },
      { name: 'photo.png', bytes: makePhotoPng(40, 30), mimeType: 'image/png' },
    );

    await expect(page.getByTestId('whiteboard-pdf-import-notice')).toBeVisible();
    await expect.poll(async () => (await sceneImages(page)).length, { timeout: 30000 }).toBe(1);
    // The picture was left for Excalidraw to skip -- only the PDF's page landed.
    const files = await page.evaluate(() => Object.keys((window as any).__debugExcalidrawApi?.getFiles?.() ?? {}));
    expect(files).toHaveLength(1);
  });

  test('two PDFs dropped together each get their own place, beside the other', async ({ page }) => {
    test.setTimeout(180_000);
    await createRoomWithMaxUsers(page, 'PdfMulti', 2);
    await waitForExcalidrawApi(page);

    await dropPdfsOnBoard(page, [
      { name: 'a.pdf', bytes: makePdf(1) },
      { name: 'b.pdf', bytes: makePdf(1) },
    ]);

    await expect.poll(async () => (await sceneImages(page)).length, { timeout: 30000 }).toBe(2);
    const images = await sceneImages(page);
    const importIds = new Set(images.map((image) => (image.stamp as { importId: string }).importId));
    // Two separate documents -- two imports, each its own undo step -- placed
    // apart from each other rather than stacked on the same point.
    expect(importIds.size).toBe(2);
    expect(Math.abs(images[0].x - images[1].x)).toBeGreaterThan(0);
  });

  test('a second PDF that arrives mid-render waits its turn', async ({ page }) => {
    test.setTimeout(180_000);
    await createRoomWithMaxUsers(page, 'PdfQueue', 2);
    await waitForExcalidrawApi(page);

    await dropPdfOnBoard(page, 'first.pdf', makePdf(10));
    await expect(page.getByTestId('whiteboard-pdf-import-notice')).toBeVisible();
    await dropPdfOnBoard(page, 'second.pdf', makePdf(2));

    await expect.poll(async () => (await sceneImages(page)).length, { timeout: 60000 }).toBe(12);
    const images = await sceneImages(page);
    expect(new Set(images.map((image) => (image.stamp as { importId: string }).importId)).size).toBe(2);
  });

  test('a teacher pastes a PDF, which lands at the centre of the view', async ({ page }) => {
    await createRoomWithMaxUsers(page, 'PdfPaste', 2);
    await waitForExcalidrawApi(page);

    await pastePdfOnBoard(page, 'worksheet.pdf', makePdf(2));

    await expect.poll(async () => (await sceneImages(page)).length, { timeout: 30000 }).toBe(2);
  });
});
