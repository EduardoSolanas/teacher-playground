import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { makePdf } from './pdfFixture';
import { dropPdfAt } from './pdfDrop';
import {
  approveFirstWaitingPeer,
  createRoomWithMaxUsers,
  expandPresenceIfCollapsed,
  joinExistingRoom,
  newAuthenticatedContext,
  waitForExcalidrawApi,
} from './helpers';

/*
 * The people/presence panel (PeopleButton / PresencePanel,
 * data-testid="whiteboard-presence-panel") used to be `fixed` clean over the
 * board: at 768x1024 it covered the right end of Excalidraw's toolbar
 * (.App-toolbar, including the image tool -- a tablet's only way to add a
 * PDF), the document pager and, sitting on top of the toolbar, the help/
 * support button. At 1440 it covered the right 220px of the board itself.
 *
 * From 640px up (Tailwind sm:) the panel now docks beside the board instead:
 * the board area narrows by the panel's width (RoomClient.tsx's
 * roomCanvasRightClass/roomCanvasRailStyle), so Excalidraw lays its own
 * toolbar, footer and help out inside what is left. Below 640px the panel
 * keeps its original phone behaviour, a sheet over the board.
 */

type Box = { x: number; y: number; width: number; height: number };

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

type SceneElement = {
  id: string;
  customData: { pdfPage?: { importId: string; index: number; pageCount: number } } | null;
};

async function stackedPages(page: Page): Promise<SceneElement[]> {
  return page.evaluate(() => {
    const api = (window as any).__debugExcalidrawApi;
    return ((api?.getSceneElements?.() ?? []) as any[])
      .filter((element) => !element.isDeleted)
      .filter((element) => element.customData?.pdfPage)
      .map((element) => ({ id: element.id, customData: element.customData }));
  });
}

/** Drops a 3-page PDF at the board's centre and waits for it to stack, returning its importId. */
async function importStackedPdf(page: Page): Promise<string> {
  const box = await page.getByTestId('whiteboard-canvas-area').boundingBox();
  if (!box) throw new Error('no canvas area box');
  await dropPdfAt(page, 'worksheet.pdf', makePdf(3), box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => (await stackedPages(page)).length, { timeout: 30000 }).toBe(3);
  const [first] = await stackedPages(page);
  return first.customData!.pdfPage!.importId;
}

async function boxOf(page: Page, testId: string): Promise<Box> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} has no box`);
  return box;
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
]) {
  test(`at ${viewport.width}x${viewport.height}, the open panel docks beside the board and covers none of its furniture`, async ({ page, browser }) => {
    test.setTimeout(150_000);
    await page.setViewportSize(viewport);
    const roomId = await createRoomWithMaxUsers(page, `PanelDock${viewport.width}`, 3);
    await waitForExcalidrawApi(page);

    // A second peer, so the roster the panel docks is not empty furniture.
    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, `PanelDockStudent${viewport.width}`);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      const importId = await importStackedPdf(page);
      const pager = page.getByTestId(`document-pager-${importId}`);
      await expect(pager).toBeVisible();

      await expandPresenceIfCollapsed(page);
      const panel = page.getByTestId('whiteboard-presence-panel');
      await expect(panel).toBeVisible();
      const panelBox = await boxOf(page, 'whiteboard-presence-panel');

      // .App-toolbar lies entirely left of the panel.
      const toolbarBox = await page.locator('.App-toolbar').first().boundingBox();
      if (!toolbarBox) throw new Error('no toolbar box');
      expect(boxesOverlap(panelBox, toolbarBox)).toBe(false);
      expect(toolbarBox.x + toolbarBox.width).toBeLessThanOrEqual(panelBox.x);

      // The image tool -- a tablet's only route to adding a PDF -- is
      // visible and inside the un-covered board area.
      const imageToolLabel = page.locator('label', { has: page.getByTestId('toolbar-image') }).first();
      await expect(imageToolLabel).toBeVisible();
      const imageToolBox = await imageToolLabel.boundingBox();
      if (!imageToolBox) throw new Error('no image tool box');
      expect(boxesOverlap(panelBox, imageToolBox)).toBe(false);
      expect(imageToolBox.x + imageToolBox.width).toBeLessThanOrEqual(panelBox.x);
      // Clickable: a real click lands on it and actually arms the tool,
      // proving the panel is not silently swallowing the click.
      await imageToolLabel.click();
      await expect.poll(async () => page.evaluate(
        () => (window as any).__debugExcalidrawApi?.getAppState?.().activeTool?.type ?? null,
      )).toBe('image');
      await page.keyboard.press('Escape');

      // The undo button.
      const undoBox = await boxOf(page, 'button-undo');
      expect(boxesOverlap(panelBox, undoBox)).toBe(false);

      // The help/support button.
      const supportBox = await boxOf(page, 'whiteboard-support-btn');
      expect(boxesOverlap(panelBox, supportBox)).toBe(false);

      // The document pager.
      const pagerBox = await boxOf(page, `document-pager-${importId}`);
      expect(boxesOverlap(panelBox, pagerBox)).toBe(false);

      // A visible board notice (the PDF import progress line).
      const canvasBox = await boxOf(page, 'whiteboard-canvas-area');
      await dropPdfAt(page, 'long.pdf', makePdf(50), canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
      const notice = page.getByTestId('whiteboard-pdf-import-notice');
      await expect(notice).toBeVisible();
      const noticeBox = await notice.boundingBox();
      if (!noticeBox) throw new Error('no notice box');
      expect(boxesOverlap(panelBox, noticeBox)).toBe(false);
      await page.getByTestId('pdf-import-cancel').click();
    } finally {
      await peerContext.close();
    }
  });
}

test('at 390x844, the panel stays a sheet whose close control is a full touch target, and closing it restores the pager', async ({ browser }) => {
  test.setTimeout(120_000);
  const base = await newAuthenticatedContext(browser, `e2e-panel-phone-${crypto.randomUUID()}`);
  const storageState = await base.storageState();
  await base.close();
  const context = await browser.newContext({
    storageState,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await createRoomWithMaxUsers(page, 'PanelPhone', 2);
    await waitForExcalidrawApi(page);
    const importId = await importStackedPdf(page);
    const pager = page.getByTestId(`document-pager-${importId}`);
    await expect(pager).toBeVisible();

    await expandPresenceIfCollapsed(page);
    const panel = page.getByTestId('whiteboard-presence-panel');
    await expect(panel).toBeVisible();

    const closeControl = page.getByTestId('whiteboard-presence-toggle');
    await expect(closeControl).toBeVisible();
    const closeBox = await closeControl.boundingBox();
    if (!closeBox) throw new Error('no close control box');
    expect(closeBox.width).toBeGreaterThanOrEqual(44);
    expect(closeBox.height).toBeGreaterThanOrEqual(44);

    await closeControl.tap();
    await expect(panel).not.toBeVisible();
    // Closing the sheet must not have knocked the pager off the board.
    await expect(pager).toBeVisible();
  } finally {
    await context.close();
  }
});
