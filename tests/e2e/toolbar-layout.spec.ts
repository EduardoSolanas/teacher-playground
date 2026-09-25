import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import {
  approveFirstWaitingPeer,
  createRoomWithMaxUsers,
  expandPresenceIfCollapsed,
  joinExistingRoom,
  newAuthenticatedContext,
  waitForExcalidrawApi,
} from './helpers';

/*
 * Regression coverage for the bottom toolbar island
 * (globals.css's `.App-toolbar-container` rule) never overlapping the
 * room's own furniture, at every width the room supports.
 *
 * 90e7a6b centred the toolbar on the board area instead of the window, so
 * the people panel docking (RoomClient's roomCanvasRightClass) would no
 * longer drag the toolbar behind it. But board-centred collides with the
 * *other* side instead once the board is wide enough that a toolbar
 * centred on it still reaches back over the room's own bottom-left footer
 * (Excalidraw's zoom/undo islands plus .tp-board-footer -- Guide class,
 * Clear board) -- up to roughly 1450px with the panel open. Proven by
 * whiteboard.spec.ts's "the host can guide the class..." and "clearing
 * board removes all elements..." both failing at HEAD with
 * "FixedSideContainer_side_top ... intercepts pointer events" on the
 * Guide/Clear click.
 *
 * Neither a window-centred nor a board-centred toolbar works at every
 * width on its own, so ExcalidrawWrapper.tsx now measures the real
 * geometry (a ResizeObserver on its own root) and calls
 * `toolbarPlacement` (src/lib/whiteboard/toolbarPlacement.ts) to centre it
 * when that is clear, slide it between the obstacles when centring is not,
 * or hand it back to Excalidraw's own native (top-of-board) placement when
 * even sliding does not fit on the bottom row at all.
 */

type Box = { x: number; y: number; width: number; height: number };

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function boxOf(page: Page, testId: string): Promise<Box> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} has no box`);
  return box;
}

async function toolbarButtonBoxes(page: Page): Promise<Box[]> {
  const toolbar = page.locator('.App-toolbar').first();
  await expect(toolbar).toBeVisible();
  const buttons = toolbar.locator('button, label:has(input[type="radio"])');
  const count = await buttons.count();
  const boxes: Box[] = [];
  for (let i = 0; i < count; i += 1) {
    const box = await buttons.nth(i).boundingBox();
    if (box) boxes.push(box);
  }
  return boxes;
}

/**
 * Checks the toolbar (a) never overlaps the given obstacles, (b) keeps
 * every one of its own buttons inside both the viewport and the board
 * area, for the page's current panel/viewport state.
 */
async function assertToolbarClear(
  page: Page,
  viewport: { width: number; height: number },
  isOwner: boolean,
) {
  const canvasBox = await boxOf(page, 'whiteboard-canvas-area');
  const undoBox = await boxOf(page, 'button-undo');
  const supportBox = await boxOf(page, 'whiteboard-support-btn').catch(() => null);
  const panelVisible = await page.getByTestId('whiteboard-presence-panel').isVisible().catch(() => false);
  const panelBox = panelVisible ? await boxOf(page, 'whiteboard-presence-panel') : null;

  const toolbar = page.locator('.App-toolbar').first();
  await expect(toolbar).toBeVisible();
  const toolbarBoxReal = await toolbar.boundingBox();
  if (!toolbarBoxReal) throw new Error('no toolbar box');

  expect(boxesOverlap(toolbarBoxReal, undoBox)).toBe(false);
  if (supportBox) expect(boxesOverlap(toolbarBoxReal, supportBox)).toBe(false);
  if (panelBox) expect(boxesOverlap(toolbarBoxReal, panelBox)).toBe(false);

  if (isOwner) {
    const footerVisible = await page.getByTestId('whiteboard-clear-btn').isVisible().catch(() => false);
    if (footerVisible) {
      const footerBox = await boxOf(page, 'whiteboard-clear-btn');
      expect(boxesOverlap(toolbarBoxReal, footerBox)).toBe(false);
      const guideBox = await boxOf(page, 'whiteboard-tool-guide');
      expect(boxesOverlap(toolbarBoxReal, guideBox)).toBe(false);
    }
  }

  // Every button on the toolbar is fully inside the viewport and the board.
  const buttonBoxes = await toolbarButtonBoxes(page);
  expect(buttonBoxes.length).toBeGreaterThan(0);
  for (const box of buttonBoxes) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(box.x).toBeGreaterThanOrEqual(canvasBox.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(canvasBox.x + canvasBox.width + 1);
  }
}

async function closePanelIfOpen(page: Page) {
  const panel = page.getByTestId('whiteboard-presence-panel');
  if (await panel.isVisible().catch(() => false)) {
    await page.getByTestId('whiteboard-people-button').click({ force: true });
    await expect(panel).not.toBeVisible();
  }
  await waitForSupportButtonSettled(page);
}

/**
 * The support button (SupportButton.tsx) animates its own `right` over
 * 150ms whenever the panel/rail it steps clear of opens or closes
 * (`transition-all duration-150`) -- so a box read the instant after the
 * toggle can still be mid-slide. Polled, not slept on (AGENTS.md): waits
 * until two reads 60ms apart agree, i.e. the transition has actually
 * finished, rather than assuming a fixed delay is long enough.
 */
async function waitForSupportButtonSettled(page: Page) {
  const button = page.getByTestId('whiteboard-support-btn');
  if (!(await button.isVisible().catch(() => false))) return;
  await expect
    .poll(async () => {
      const before = await button.boundingBox();
      await page.waitForTimeout(60);
      const after = await button.boundingBox();
      return before && after && before.x === after.x ? 'settled' : 'moving';
    }, { timeout: 5000 })
    .toBe('settled');
}

const VIEWPORTS = [
  { width: 1024, height: 720 },
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 900 },
];

for (const viewport of VIEWPORTS) {
  test(`at ${viewport.width}x${viewport.height}, the toolbar never overlaps the room's furniture, panel open or closed, owner or student`, async ({ page, browser }) => {
    test.setTimeout(150_000);
    await page.setViewportSize(viewport);

    const roomId = await createRoomWithMaxUsers(page, `ToolbarLayout${viewport.width}x${viewport.height}`, 2);
    await waitForExcalidrawApi(page);

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await peerPage.setViewportSize(viewport);
      await joinExistingRoom(peerPage, roomId, `ToolbarStudent${viewport.width}`);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await waitForExcalidrawApi(peerPage);

      // Owner, panel closed.
      await closePanelIfOpen(page);
      await assertToolbarClear(page, viewport, true);

      // Owner, panel open.
      await expandPresenceIfCollapsed(page);
      await waitForSupportButtonSettled(page);
      await assertToolbarClear(page, viewport, true);

      // Student, panel closed.
      await closePanelIfOpen(peerPage);
      await assertToolbarClear(peerPage, viewport, false);

      // Student, panel open.
      await expandPresenceIfCollapsed(peerPage);
      await waitForSupportButtonSettled(peerPage);
      await assertToolbarClear(peerPage, viewport, false);

      // The owner's Clear board control is clickable through the toolbar,
      // wherever it landed -- the concrete regression this whole spec
      // guards (whiteboard.spec.ts's "clearing board removes all
      // elements..." failed here with the toolbar intercepting the click).
      await closePanelIfOpen(page);
      await page.getByTestId('whiteboard-clear-btn').click();
      await expect(page.getByTestId('whiteboard-clear-confirm-btn')).toBeVisible();
      await page.getByTestId('whiteboard-clear-cancel-btn').click();
      await expect(page.getByTestId('whiteboard-clear-confirm-btn')).not.toBeVisible();
    } finally {
      await peerPage.close();
      await peerContext.close();
    }
  });
}
