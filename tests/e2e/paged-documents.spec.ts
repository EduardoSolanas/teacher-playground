import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { makePdf } from './pdfFixture';
import { dropPdfAt } from './pdfDrop';
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
 * Paged documents, slice A (spec/PAGED_DOCUMENTS_SPEC.md §3, §4, §6.1, §6.2):
 * a stacked PDF import places every page on one rectangle and only the
 * showing page renders and can be interacted with. Slice B builds the pager
 * UI; until then, a page is turned the same owner-only way the pager will --
 * through `BoardActions.turnPage`, reached in tests via the same kind of
 * gated debug handle `window.__debugExcalidrawApi` already is
 * (`window.__debugBoardActions`, ExcalidrawWrapper.tsx).
 */

type SceneElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted: boolean;
  locked: boolean;
  customData: { pdfPage?: { importId: string; index: number; pageCount: number; stacked?: boolean }; onPage?: { importId: string; index: number } } | null;
};

async function sceneElements(page: Page): Promise<SceneElement[]> {
  return page.evaluate(() => {
    const api = (window as any).__debugExcalidrawApi;
    return ((api?.getSceneElements?.() ?? []) as any[])
      .filter((element) => !element.isDeleted)
      .map((element) => ({
        id: element.id,
        type: element.type,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        isDeleted: element.isDeleted === true,
        locked: element.locked === true,
        customData: element.customData ?? null,
      }));
  });
}

async function stackedPages(page: Page): Promise<SceneElement[]> {
  return (await sceneElements(page))
    .filter((element) => element.customData?.pdfPage)
    .sort((a, b) => (a.customData!.pdfPage!.index - b.customData!.pdfPage!.index));
}

/** Drops a 3-page PDF at the board's centre and waits for all three pages. */
async function importStackedPdf(page: Page): Promise<{ importId: string; rect: { x: number; y: number; width: number; height: number } }> {
  const box = await page.getByTestId('whiteboard-canvas-area').boundingBox();
  if (!box) throw new Error('no canvas area box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await dropPdfAt(page, 'worksheet.pdf', makePdf(3), x, y);

  await expect.poll(async () => (await stackedPages(page)).length, { timeout: 30000 }).toBe(3);
  const pages = await stackedPages(page);
  const first = pages[0];
  return {
    importId: first.customData!.pdfPage!.importId,
    rect: { x: first.x, y: first.y, width: first.width, height: first.height },
  };
}

/** A scene point converted to this page's own on-screen pixel, via the real canvas element. */
async function clientPointFor(page: Page, sceneX: number, sceneY: number): Promise<{ x: number; y: number }> {
  const canvas = page.locator('canvas.excalidraw__canvas.interactive').first();
  await canvas.waitFor({ state: 'attached', timeout: 15000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no interactive canvas box');
  const { x: relX, y: relY } = await page.evaluate(({ sceneX, sceneY }) => {
    const api = (window as any).__debugExcalidrawApi;
    const appState = api.getAppState();
    const zoom = appState.zoom.value;
    return { x: (sceneX + appState.scrollX) * zoom, y: (sceneY + appState.scrollY) * zoom };
  }, { sceneX, sceneY });
  return { x: box.x + relX, y: box.y + relY };
}

/**
 * Selects whatever sits at a scene point with a marquee (drag), not a single
 * click: `board-tools.spec.ts`'s own selection tests only ever prove a
 * selection through a drag (`selection picks a shape up with a marquee`),
 * never a bare click, and the fork's own hidden-element table lists box
 * selection, not click, as the seam `isElementHidden` covers (spec §4) -- a
 * marquee is the more direct proof for exactly that reason. The box is small
 * enough (110x60 around the point) to stay clear of anything else nearby.
 */
async function boxSelectScenePoint(page: Page, sceneX: number, sceneY: number): Promise<void> {
  const from = await clientPointFor(page, sceneX - 55, sceneY - 30);
  const to = await clientPointFor(page, sceneX + 55, sceneY + 30);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

/** The real click target for a toolbar tool is its wrapping <label>, not the testid'd input itself. */
async function chooseSelectionTool(page: Page): Promise<void> {
  const label = page.locator('label', { has: page.getByTestId('toolbar-selection') }).first();
  await expect(label).toBeVisible();
  await label.click();
  await expect
    .poll(async () => page.evaluate(
      () => (window as any).__debugExcalidrawApi?.getAppState?.().activeTool?.type ?? null,
    ))
    .toBe('selection');
}

async function selectedIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const api = (window as any).__debugExcalidrawApi;
    const ids: Record<string, boolean> = api?.getAppState?.().selectedElementIds ?? {};
    return Object.keys(ids).filter((id) => ids[id]);
  });
}

/** Owner-only: turns a page through BoardActions, the way the pager (slice B) will. */
async function turnPage(page: Page, importId: string, index: number): Promise<void> {
  await page.evaluate(({ importId, index }) => {
    (window as any).__debugBoardActions.turnPage(importId, index);
  }, { importId, index });
}

/*
 * Slice B: the pager UI itself (spec §6.3). `importStackedPdf` above already
 * gives every test the import's rectangle in scene coordinates and its
 * importId; these helpers are the pager's own surface -- its container
 * (`data-testid="document-pager-<importId>"`, ExcalidrawWrapper.tsx /
 * DocumentPager.tsx), its Previous/Next buttons and its "Page n of m" text.
 */
function pagerLocator(page: Page, importId: string) {
  return page.getByTestId(`document-pager-${importId}`);
}

/** Whether two Playwright bounding boxes share any area. Touching edges do not count. */
function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Sets the board's scroll/zoom directly, the way a pan or a pinch would (whiteboard.spec.ts uses the same seam). */
async function setBoardView(
  page: Page,
  view: { scrollX?: number; scrollY?: number; zoom?: number },
): Promise<void> {
  await page.evaluate((view) => {
    const api = (window as any).__debugExcalidrawApi;
    const current = api.getAppState();
    api.updateScene({
      appState: {
        scrollX: view.scrollX ?? current.scrollX,
        scrollY: view.scrollY ?? current.scrollY,
        zoom: { value: view.zoom ?? current.zoom.value },
      },
      captureUpdate: 'IMMEDIATELY',
    });
  }, view);
}

test.describe('Paged documents', () => {
  test('a stacked import shares one rectangle across every page and carries the stacked stamp', async ({ page }) => {
    test.setTimeout(120_000);
    await createRoomWithMaxUsers(page, 'PagedStack', 2);
    await waitForExcalidrawApi(page);

    const { rect } = await importStackedPdf(page);
    const pages = await stackedPages(page);

    expect(pages).toHaveLength(3);
    for (const [index, image] of pages.entries()) {
      expect(image.x).toBe(rect.x);
      expect(image.y).toBe(rect.y);
      expect(image.width).toBe(rect.width);
      expect(image.height).toBe(rect.height);
      expect(image.locked).toBe(true);
      expect(image.customData?.pdfPage).toMatchObject({ index, pageCount: 3, stacked: true });
    }
  });

  test('a page turn hides an annotation on the page turned away from and shows it again on return, for a second participant too', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const roomId = await createRoomWithMaxUsers(page, 'PagedTurn', 2);
    await waitForExcalidrawApi(page);
    const { importId, rect } = await importStackedPdf(page);

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'PagedStudent');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await waitForExcalidrawApi(peerPage);
      await expect.poll(async () => (await stackedPages(peerPage)).length, { timeout: 30000 }).toBe(3);

      // The student draws on the showing page (index 0).
      const markX = rect.x + rect.width / 2 - 50;
      const markY = rect.y + rect.height / 2 - 25;
      await appendElement(peerPage, excalidrawRectangle('student-stroke', markX, markY));
      await expect
        .poll(async () => (await sceneElements(page)).some((e) => e.id === 'student-stroke'), { timeout: 15000 })
        .toBe(true);
      // Finished (nothing is mid-draw here), overlapping the showing page:
      // both browsers' own onChange stamps it onPage index 0.
      await expect
        .poll(async () => (await sceneElements(peerPage)).find((e) => e.id === 'student-stroke')?.customData?.onPage,
          { timeout: 15000 })
        .toEqual({ importId, index: 0 });

      const markCentreX = markX + 50;
      const markCentreY = markY + 25;
      await chooseSelectionTool(peerPage);

      // Owner turns to page 2 (index 1): the stroke, stamped for page 0, is
      // hidden for everyone -- a marquee over it selects nothing. The page
      // frame reaches the student over the socket, slightly after the
      // owner's own call returns, so the marquee is retried inside the poll
      // rather than dragged once against whatever page was showing at that
      // instant.
      await turnPage(page, importId, 1);
      await expect.poll(async () => {
        await boxSelectScenePoint(peerPage, markCentreX, markCentreY);
        return selectedIds(peerPage);
      }, { timeout: 15000 }).toEqual([]);
      await expect.poll(async () => selectedIds(page), { timeout: 10000 }).toEqual([]);

      // Turning back to page 1 (index 0) makes it hittable again.
      await turnPage(page, importId, 0);
      await expect.poll(async () => {
        await boxSelectScenePoint(peerPage, markCentreX, markCentreY);
        return selectedIds(peerPage);
      }, { timeout: 15000 }).toEqual(['student-stroke']);
    } finally {
      await peerPage.close();
      await peerContext.close();
    }
  });

  test('a student has no page controls and cannot turn a page', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const roomId = await createRoomWithMaxUsers(page, 'PagedNoControl', 2);
    await waitForExcalidrawApi(page);
    const { importId, rect } = await importStackedPdf(page);

    // Stamped for page 2 (index 1) directly, rather than drawn -- if page 1
    // (index 0) is still showing, as it should be, this stays hidden.
    const markX = rect.x + rect.width / 2 - 50;
    const markY = rect.y + rect.height / 2 - 25;
    await appendElement(page, {
      ...excalidrawRectangle('would-show-on-page-2', markX, markY),
      customData: { onPage: { importId, index: 1 } },
    });
    await expect
      .poll(async () => (await sceneElements(page)).some((e) => e.id === 'would-show-on-page-2'), { timeout: 15000 })
      .toBe(true);

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'PagedGuest');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await waitForExcalidrawApi(peerPage);
      await expect.poll(async () => (await stackedPages(peerPage)).length, { timeout: 30000 }).toBe(3);

      // A non-owner's turnPage is a no-op: the local pageState is untouched
      // and no frame reaches the owner (useCollaboration.turnPage, gated on
      // isRoomOwner). Page 1 stays showing for both, so the page-2 mark stays
      // unselectable for the owner throughout.
      await turnPage(peerPage, importId, 2);
      await peerPage.waitForTimeout(1000);
      await chooseSelectionTool(page);
      await boxSelectScenePoint(page, markX + 50, markY + 25);
      await expect.poll(async () => selectedIds(page), { timeout: 10000 }).toEqual([]);
    } finally {
      await peerPage.close();
      await peerContext.close();
    }
  });

  test('a late joiner receives the page the owner is already on', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const roomId = await createRoomWithMaxUsers(page, 'PagedLateJoin', 2);
    await waitForExcalidrawApi(page);
    const { importId, rect } = await importStackedPdf(page);

    // An annotation on page 2 (index 1), added before the turn so it is
    // already stamped when the late joiner connects.
    await turnPage(page, importId, 1);
    const markX = rect.x + rect.width / 2 - 50;
    const markY = rect.y + rect.height / 2 - 25;
    await appendElement(page, excalidrawRectangle('page-2-mark', markX, markY));
    await expect
      .poll(async () => (await sceneElements(page)).find((e) => e.id === 'page-2-mark')?.customData?.onPage,
        { timeout: 15000 })
      .toEqual({ importId, index: 1 });

    const lateContext = await newAuthenticatedContext(browser);
    const latePage = await lateContext.newPage();
    try {
      await joinExistingRoom(latePage, roomId, 'PagedLate');
      await expectWaiting(latePage);
      await approveFirstWaitingPeer(page);
      await expect(latePage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await waitForExcalidrawApi(latePage);
      await expect.poll(async () => (await stackedPages(latePage)).length, { timeout: 30000 }).toBe(3);

      // The connect replay itself (spec §5.2), reached first and on its own:
      // it does not depend on the mark having synced.
      await expect
        .poll(async () => latePage.evaluate(() => (window as any).__debugPageState), { timeout: 15000 })
        .toEqual({ [importId]: 1 });

      await expect
        .poll(async () => (await sceneElements(latePage)).some((e) => e.id === 'page-2-mark'), { timeout: 20000 })
        .toBe(true);
      await expect
        .poll(async () => (await sceneElements(latePage)).find((e) => e.id === 'page-2-mark')?.customData?.onPage,
          { timeout: 15000 })
        .toEqual({ importId, index: 1 });

      // The replayed page state (spec §5.2 "on connect ... sends one page
      // frame per stored entry") means page 2's own mark is hittable right
      // away, with no page turn from the late joiner. The element itself is
      // already in the initial scene, but the replay frame that tells this
      // browser page 2 is showing is a separate, slightly later message, so
      // the marquee is retried inside the poll rather than dragged once and
      // then waited on -- a drag while still on the (empty) default page 1
      // never becomes a selection just because the frame lands afterwards.
      await chooseSelectionTool(latePage);
      await expect.poll(async () => {
        await boxSelectScenePoint(latePage, markX + 50, markY + 25);
        return selectedIds(latePage);
      }, { timeout: 15000 }).toEqual(['page-2-mark']);
    } finally {
      await latePage.close();
      await lateContext.close();
    }
  });

  test('an import stamped without stacked still shows every page', async ({ page }) => {
    await createRoomWithMaxUsers(page, 'PagedLegacy', 2);
    await waitForExcalidrawApi(page);

    // A board imported before this shipped (spec §3.1): the same importId,
    // but no `stacked: true`. `stackedDocuments` ignores an element with no
    // `stacked: true` entirely, so `isElementHidden` never hides it, however
    // its index compares to any pageState -- unlike a real stacked page,
    // which would hide every index but the showing one. Left unlocked (a
    // real column page is locked, but only that -- not stacked -- decides
    // hiding), so a click is the direct proof.
    const importId = '0123456789abcdef';
    await appendElement(page, {
      ...excalidrawRectangle('legacy-page-0', 100, 100),
      customData: { pdfPage: { importId, index: 0 } },
    });
    await appendElement(page, {
      ...excalidrawRectangle('legacy-page-5', 100, 260),
      customData: { pdfPage: { importId, index: 5 } },
    });

    await expect
      .poll(async () => (await sceneElements(page)).filter((e) => e.id.startsWith('legacy-page-')).length, { timeout: 15000 })
      .toBe(2);

    // One marquee spanning both: if hiding applied the way it does to a real
    // stacked page, at most one of these -- whichever some pageState entry
    // for this importId happened to match -- would ever be selectable at
    // once. Both landing in the same drag is the proof neither is hidden.
    await chooseSelectionTool(page);
    const from = await clientPointFor(page, 80, 80);
    const to = await clientPointFor(page, 220, 330);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();
    await expect
      .poll(async () => (await selectedIds(page)).slice().sort(), { timeout: 10000 })
      .toEqual(['legacy-page-0', 'legacy-page-5']);
  });

  test('a PDF picked in the image tool becomes a stacked document, at the view centre', async ({ page }) => {
    test.setTimeout(120_000);
    // Chromium has the File System Access picker, which Playwright cannot
    // drive; removing it is what board-tools.spec.ts's `openBoard` does too,
    // so the editor takes the <input type="file"> fallback path instead --
    // the same one Safari, Firefox and every iPhone browser take.
    await page.addInitScript(() => {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker;
      delete (Window.prototype as { showOpenFilePicker?: unknown }).showOpenFilePicker;
    });
    await createRoomWithMaxUsers(page, 'PagedPicker', 2);
    await waitForExcalidrawApi(page);

    // spec/PAGED_DOCUMENTS_SPEC.md §4.1: the fork's image tool picker also
    // offers PDFs when `onDocumentFile` is set (ExcalidrawWrapper passes it
    // through to RoomClient's own drop/paste queue). board-tools.spec.ts's
    // own "insert image" test clicks the <label> wrapping the toolbar
    // testid (the real click target for a radio-styled tool button), not
    // the input itself.
    const imageToolLabel = page.locator('label', { has: page.getByTestId('toolbar-image') }).first();
    await expect(imageToolLabel).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await imageToolLabel.click();
    await (await chooser).setFiles({
      name: 'worksheet.pdf',
      mimeType: 'application/pdf',
      buffer: makePdf(2),
    });

    await expect.poll(async () => (await stackedPages(page)).length, { timeout: 30000 }).toBe(2);
    // No image element was added for the picked file itself -- only the
    // rendered PDF pages, which are images too, so the only honest count is
    // that every image in the scene is one of the two stacked pages.
    const images = (await sceneElements(page)).filter((e) => e.type === 'image');
    expect(images).toHaveLength(2);
    // The fork returns to the selection tool after handing the PDF over
    // (spec §4.1), rather than leaving the image tool armed for a click.
    await expect.poll(async () => page.evaluate(
      () => (window as any).__debugExcalidrawApi?.getAppState?.().activeTool?.type ?? null,
    )).toBe('selection');
  });
});

/*
 * Slice B: the pager UI (spec §6.3). Previous/"Page n of m"/Next for the
 * owner, "Page n of m" only for everyone else; positioned under the
 * document, clamped inside the viewport, never overlapping the room's
 * furniture, at every width.
 */
test.describe('Paged documents pager', () => {
  test('the owner turns pages with the pager buttons, the matching button disables at each end, and a student follows', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const roomId = await createRoomWithMaxUsers(page, 'PagerButtons', 2);
    await waitForExcalidrawApi(page);
    const { importId } = await importStackedPdf(page);

    const pager = pagerLocator(page, importId);
    await expect(pager).toBeVisible();
    const previous = pager.getByRole('button', { name: 'Previous page' });
    const next = pager.getByRole('button', { name: 'Next page' });
    await expect(pager).toContainText('Page 1 of 3');
    await expect(previous).toBeDisabled();
    await expect(next).toBeEnabled();

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'PagerStudent');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await waitForExcalidrawApi(peerPage);
      const studentPager = pagerLocator(peerPage, importId);
      await expect(studentPager).toBeVisible({ timeout: 15000 });
      // A student sees the page label only -- no Previous/Next of its own.
      await expect(studentPager.getByRole('button')).toHaveCount(0);
      await expect(studentPager).toContainText('Page 1 of 3');

      await next.click();
      await expect(pager).toContainText('Page 2 of 3');
      await expect(previous).toBeEnabled();
      await expect(next).toBeEnabled();
      await expect(studentPager).toContainText('Page 2 of 3', { timeout: 15000 });

      await next.click();
      await expect(pager).toContainText('Page 3 of 3');
      await expect(next).toBeDisabled();
      await expect(previous).toBeEnabled();
      await expect(studentPager).toContainText('Page 3 of 3', { timeout: 15000 });

      await previous.click();
      await expect(pager).toContainText('Page 2 of 3');
      await expect(previous).toBeEnabled();
      await expect(next).toBeEnabled();
      await expect(studentPager).toContainText('Page 2 of 3', { timeout: 15000 });
    } finally {
      await peerPage.close();
      await peerContext.close();
    }
  });

  test('a late joiner\'s pager shows the page the owner already turned to', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const roomId = await createRoomWithMaxUsers(page, 'PagerLateJoin', 2);
    await waitForExcalidrawApi(page);
    const { importId } = await importStackedPdf(page);

    const pager = pagerLocator(page, importId);
    await pager.getByRole('button', { name: 'Next page' }).click();
    await expect(pager).toContainText('Page 2 of 3');

    const lateContext = await newAuthenticatedContext(browser);
    const latePage = await lateContext.newPage();
    try {
      await joinExistingRoom(latePage, roomId, 'PagerLate');
      await expectWaiting(latePage);
      await approveFirstWaitingPeer(page);
      await expect(latePage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await waitForExcalidrawApi(latePage);
      await expect(pagerLocator(latePage, importId)).toContainText('Page 2 of 3', { timeout: 15000 });
      await expect(pagerLocator(latePage, importId).getByRole('button')).toHaveCount(0);
    } finally {
      await latePage.close();
      await lateContext.close();
    }
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    test(`the pager's box stays inside the viewport and clear of the room's furniture, at ${viewport.width}px`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(viewport);
      await createRoomWithMaxUsers(page, `PagerFit${viewport.width}`, 2);
      await waitForExcalidrawApi(page);
      const { importId } = await importStackedPdf(page);

      const pager = pagerLocator(page, importId);
      await expect(pager).toBeVisible();
      const box = await pager.boundingBox();
      if (!box) throw new Error('pager has no box');

      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

      const obstacles = [
        page.getByTestId('board-tabs'),
        page.locator('.App-toolbar').first(),
        page.getByTestId('button-undo'),
        page.locator('.help-icon').first(),
      ];
      for (const obstacle of obstacles) {
        if (!(await obstacle.isVisible().catch(() => false))) continue;
        const other = await obstacle.boundingBox();
        if (!other) continue;
        expect(boxesOverlap(box, other)).toBe(false);
      }

      if (viewport.width === 390) {
        for (const name of ['Previous page', 'Next page']) {
          const buttonBox = await pager.getByRole('button', { name }).boundingBox();
          if (!buttonBox) throw new Error(`${name} has no box`);
          expect(buttonBox.width).toBeGreaterThanOrEqual(44);
          expect(buttonBox.height).toBeGreaterThanOrEqual(44);
        }
      }
    });
  }

  test('at 390x844, a touch tap on Next turns the page', async ({ browser }) => {
    test.setTimeout(120_000);
    const base = await newAuthenticatedContext(browser, `e2e-pager-touch-${crypto.randomUUID()}`);
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
      await createRoomWithMaxUsers(page, 'PagerTouch', 2);
      await waitForExcalidrawApi(page);
      const { importId } = await importStackedPdf(page);

      const pager = pagerLocator(page, importId);
      await expect(pager).toContainText('Page 1 of 3');
      await pager.getByRole('button', { name: 'Next page' }).tap();
      await expect(pager).toContainText('Page 2 of 3');
    } finally {
      await context.close();
    }
  });

  test('the pager hides once the document pans fully off screen, and pins above the bottom bar when only the top of the page is on screen', async ({ page }) => {
    test.setTimeout(120_000);
    await createRoomWithMaxUsers(page, 'PagerPan', 2);
    await waitForExcalidrawApi(page);
    const { importId, rect } = await importStackedPdf(page);

    const pager = pagerLocator(page, importId);
    await expect(pager).toBeVisible();
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('no viewport size');

    // Zoomed well in and panned so the document's top sits just under the
    // top chrome: at this zoom the document is certainly taller than the
    // viewport, so its bottom edge is off screen and the pager must pin
    // above the bottom instead of trying to sit under a bottom edge nobody
    // can see.
    const zoom = 6;
    await setBoardView(page, { zoom, scrollX: -rect.x + 40 / zoom, scrollY: -rect.y + 140 / zoom });
    await expect.poll(async () => pager.boundingBox()).not.toBeNull();
    const pinnedBox = await pager.boundingBox();
    if (!pinnedBox) throw new Error('pager has no box while pinned');
    expect(pinnedBox.y + pinnedBox.height).toBeLessThanOrEqual(viewport.height);
    expect(pinnedBox.y).toBeGreaterThan(0);

    // Panning further still -- the whole document well past the bottom of
    // the viewport -- hides the pager entirely.
    await setBoardView(page, { scrollY: -rect.y - 100000 });
    await expect(pager).not.toBeVisible();
  });
});

/*
 * Slice C: the owner's Move and Remove controls (spec §6.3 Move/Remove). The
 * grip drags with pointer events -- a mouse drag here, a real touch drag in
 * the 390x844 test below -- and moves every page plus every onPage-stamped
 * annotation of the import by the same delta, live for the owner and, once
 * committed, for every peer. Remove deletes the same set in one undoable
 * step, no confirmation dialog.
 */
test.describe('Paged documents move and remove', () => {
  /** Drags the grip by a pixel delta with a synthetic PointerEvent sequence, the same technique whiteboard.spec.ts uses for a canvas drag. */
  async function dragGrip(
    page: Page,
    importId: string,
    deltaPx: { x: number; y: number },
    pointerType: 'mouse' | 'touch' = 'mouse',
  ): Promise<void> {
    await page.evaluate(({ importId, deltaPx, pointerType }) => {
      const pager = document.querySelector(`[data-testid="document-pager-${importId}"]`);
      const grip = pager?.querySelector('[aria-label="Move document"]') as HTMLElement | null;
      if (!grip) throw new Error('no move grip');
      const box = grip.getBoundingClientRect();
      const startX = box.left + box.width / 2;
      const startY = box.top + box.height / 2;
      const fire = (type: string, x: number, y: number) => grip.dispatchEvent(new PointerEvent(type, {
        clientX: x, clientY: y, bubbles: true, cancelable: true,
        pointerId: 1, pointerType, button: 0, buttons: 1,
      }));
      fire('pointerdown', startX, startY);
      fire('pointermove', startX + deltaPx.x / 2, startY + deltaPx.y / 2);
      fire('pointermove', startX + deltaPx.x, startY + deltaPx.y);
      fire('pointerup', startX + deltaPx.x, startY + deltaPx.y);
    }, { importId, deltaPx, pointerType });
  }

  async function currentZoom(page: Page): Promise<number> {
    return page.evaluate(() => (window as any).__debugExcalidrawApi.getAppState().zoom.value as number);
  }

  test('the teacher drags the grip and a page-stamped annotation moves by the same delta for a student too; one undo reverts both', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const roomId = await createRoomWithMaxUsers(page, 'PagerMove', 2);
    await waitForExcalidrawApi(page);
    const { importId, rect } = await importStackedPdf(page);

    const markX = rect.x + rect.width / 2 - 50;
    const markY = rect.y + rect.height / 2 - 25;
    await appendElement(page, excalidrawRectangle('move-mark', markX, markY));
    await expect
      .poll(async () => (await sceneElements(page)).find((e) => e.id === 'move-mark')?.customData?.onPage, { timeout: 15000 })
      .toEqual({ importId, index: 0 });

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'PagerMoveStudent');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await waitForExcalidrawApi(peerPage);
      await expect.poll(async () => (await stackedPages(peerPage)).length, { timeout: 30000 }).toBe(3);

      const zoom = await currentZoom(page);
      const deltaPx = { x: 80, y: 40 };
      const expectedDx = Math.round(deltaPx.x / zoom);
      const expectedDy = Math.round(deltaPx.y / zoom);

      await dragGrip(page, importId, deltaPx);

      await expect.poll(async () => {
        const pages = await stackedPages(page);
        return pages.length === 3 ? Math.round(pages[0].x - rect.x) : null;
      }, { timeout: 15000 }).toBe(expectedDx);
      await expect.poll(async () => {
        const pages = await stackedPages(page);
        return pages.length === 3 ? Math.round(pages[0].y - rect.y) : null;
      }).toBe(expectedDy);
      await expect.poll(async () => {
        const mark = (await sceneElements(page)).find((e) => e.id === 'move-mark');
        return mark ? Math.round(mark.x - markX) : null;
      }).toBe(expectedDx);

      // The same move reaches the student once it is committed.
      await expect.poll(async () => {
        const pages = await stackedPages(peerPage);
        return pages.length === 3 ? Math.round(pages[0].x - rect.x) : null;
      }, { timeout: 15000 }).toBe(expectedDx);
      await expect.poll(async () => {
        const mark = (await sceneElements(peerPage)).find((e) => e.id === 'move-mark');
        return mark ? Math.round(mark.x - markX) : null;
      }, { timeout: 15000 }).toBe(expectedDx);

      // One undo reverts the whole move -- every page and the annotation --
      // for both, in a single step.
      await page.locator('canvas.excalidraw__canvas.interactive').first().click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('Control+z');
      await expect.poll(async () => {
        const pages = await stackedPages(page);
        return pages.length === 3 ? pages[0].x : null;
      }, { timeout: 15000 }).toBe(rect.x);
      await expect.poll(async () => (await sceneElements(page)).find((e) => e.id === 'move-mark')?.x).toBe(markX);
      await expect.poll(async () => {
        const pages = await stackedPages(peerPage);
        return pages.length === 3 ? pages[0].x : null;
      }, { timeout: 15000 }).toBe(rect.x);
      await expect
        .poll(async () => (await sceneElements(peerPage)).find((e) => e.id === 'move-mark')?.x, { timeout: 15000 })
        .toBe(markX);
    } finally {
      await peerPage.close();
      await peerContext.close();
    }
  });

  test('an arrow-key nudge on the focused grip moves the document by one undoable step', async ({ page }) => {
    test.setTimeout(120_000);
    await createRoomWithMaxUsers(page, 'PagerNudge', 2);
    await waitForExcalidrawApi(page);
    const { importId, rect } = await importStackedPdf(page);

    const grip = pagerLocator(page, importId).getByRole('button', { name: 'Move document', exact: true });
    await grip.focus();
    await grip.press('ArrowRight');
    await expect.poll(async () => {
      const pages = await stackedPages(page);
      return pages.length === 3 ? pages[0].x : null;
    }, { timeout: 15000 }).toBe(rect.x + 10);
    await expect.poll(async () => {
      const pages = await stackedPages(page);
      return pages.length === 3 ? pages[0].y : null;
    }).toBe(rect.y);

    // One undo takes back exactly this one nudge. Excalidraw's own undo
    // shortcut is keyed off the canvas, not the currently focused element,
    // so focus moves there first -- the same thing every other undo
    // assertion in this file does before pressing Control+z.
    await page.locator('canvas.excalidraw__canvas.interactive').first().click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    await expect.poll(async () => {
      const pages = await stackedPages(page);
      return pages.length === 3 ? pages[0].x : null;
    }, { timeout: 15000 }).toBe(rect.x);
  });

  test('Remove deletes the document and its annotations for both, and undo restores them', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const roomId = await createRoomWithMaxUsers(page, 'PagerRemove', 2);
    await waitForExcalidrawApi(page);
    const { importId, rect } = await importStackedPdf(page);

    const markX = rect.x + rect.width / 2 - 50;
    const markY = rect.y + rect.height / 2 - 25;
    await appendElement(page, excalidrawRectangle('remove-mark', markX, markY));
    await expect
      .poll(async () => (await sceneElements(page)).find((e) => e.id === 'remove-mark')?.customData?.onPage, { timeout: 15000 })
      .toEqual({ importId, index: 0 });

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'PagerRemoveStudent');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await waitForExcalidrawApi(peerPage);
      await expect.poll(async () => (await stackedPages(peerPage)).length, { timeout: 30000 }).toBe(3);

      await pagerLocator(page, importId).getByRole('button', { name: 'Remove document' }).click();

      await expect.poll(async () => (await stackedPages(page)).length, { timeout: 15000 }).toBe(0);
      await expect.poll(async () => (await sceneElements(page)).some((e) => e.id === 'remove-mark')).toBe(false);
      await expect.poll(async () => (await stackedPages(peerPage)).length, { timeout: 15000 }).toBe(0);
      await expect.poll(async () => (await sceneElements(peerPage)).some((e) => e.id === 'remove-mark'), { timeout: 15000 }).toBe(false);

      await page.locator('canvas.excalidraw__canvas.interactive').first().click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('Control+z');
      await expect.poll(async () => (await stackedPages(page)).length, { timeout: 15000 }).toBe(3);
      await expect.poll(async () => (await sceneElements(page)).some((e) => e.id === 'remove-mark')).toBe(true);
      await expect.poll(async () => (await stackedPages(peerPage)).length, { timeout: 15000 }).toBe(3);
      await expect.poll(async () => (await sceneElements(peerPage)).some((e) => e.id === 'remove-mark'), { timeout: 15000 }).toBe(true);
    } finally {
      await peerPage.close();
      await peerContext.close();
    }
  });

  test('a student has no Move or Remove controls', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const roomId = await createRoomWithMaxUsers(page, 'PagerMoveNoControl', 2);
    await waitForExcalidrawApi(page);
    const { importId } = await importStackedPdf(page);

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'PagerMoveNoControlStudent');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await waitForExcalidrawApi(peerPage);
      const studentPager = pagerLocator(peerPage, importId);
      await expect(studentPager).toBeVisible({ timeout: 15000 });
      await expect(studentPager.getByRole('button', { name: 'Move document', exact: true })).toHaveCount(0);
      await expect(studentPager.getByRole('button', { name: 'Remove document' })).toHaveCount(0);
      await expect(studentPager.getByRole('button', { name: 'More actions' })).toHaveCount(0);
    } finally {
      await peerPage.close();
      await peerContext.close();
    }
  });

  test('at 390x844, the grip drags with real touch pointer events, Remove/overflow is >=44x44, and the row still fits with no overlap', async ({ browser }) => {
    test.setTimeout(120_000);
    const base = await newAuthenticatedContext(browser, `e2e-move-touch-${crypto.randomUUID()}`);
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
      await createRoomWithMaxUsers(page, 'PagerMoveTouch', 2);
      await waitForExcalidrawApi(page);
      const { importId, rect } = await importStackedPdf(page);

      await dragGrip(page, importId, { x: 40, y: 20 }, 'touch');
      await expect.poll(async () => {
        const pages = await stackedPages(page);
        return pages.length === 3 ? pages[0].x !== rect.x : null;
      }, { timeout: 15000 }).toBe(true);

      const pager = pagerLocator(page, importId);
      const moreButton = pager.getByRole('button', { name: 'More actions' });
      const removeButton = pager.getByRole('button', { name: 'Remove document' });
      const target = (await moreButton.count()) > 0 ? moreButton : removeButton;
      const targetBox = await target.boundingBox();
      if (!targetBox) throw new Error('no Remove/More box');
      expect(targetBox.width).toBeGreaterThanOrEqual(44);
      expect(targetBox.height).toBeGreaterThanOrEqual(44);

      const pagerBox = await pager.boundingBox();
      if (!pagerBox) throw new Error('pager has no box');
      expect(pagerBox.x).toBeGreaterThanOrEqual(0);
      expect(pagerBox.x + pagerBox.width).toBeLessThanOrEqual(390);
      expect(pagerBox.y).toBeGreaterThanOrEqual(0);
      expect(pagerBox.y + pagerBox.height).toBeLessThanOrEqual(844);

      const obstacles = [
        page.getByTestId('board-tabs'),
        page.locator('.App-toolbar').first(),
        page.getByTestId('button-undo'),
        page.locator('.help-icon').first(),
      ];
      for (const obstacle of obstacles) {
        if (!(await obstacle.isVisible().catch(() => false))) continue;
        const other = await obstacle.boundingBox();
        if (!other) continue;
        expect(boxesOverlap(pagerBox, other)).toBe(false);
      }
    } finally {
      await context.close();
    }
  });
});
