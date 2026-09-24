import { test, expect } from './fixtures';
import {
  createRoomWithMaxUsers,
  newAuthenticatedContext,
  joinExistingRoom,
  approveFirstWaitingPeer,
  expectWaiting,
  appendElement,
  excalidrawRectangle,
  waitForExcalidrawApi,
} from './helpers';

/*
 * Below 640px the room's own footer (Guide class / Clear board) is hidden --
 * globals.css's UX-V8 rule hands the bottom edge to Excalidraw's own toolbar
 * there -- so the title menu is the phone's only route to either control.
 * These specs prove the phone route actually reaches the same behaviour the
 * footer specs already cover (multi-peer.spec.ts's clear-board propagation,
 * whiteboard.spec.ts's guide/follow), not just that the menu items render.
 */

async function sceneElementIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const api = (window as any).__debugExcalidrawApi;
    return api ? api.getSceneElements().map((el: { id: string }) => el.id) : [];
  });
}

test.describe('Room phone controls', () => {
  test('the owner clears the board from the phone title menu', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createRoomWithMaxUsers(page, 'PhoneClearOwner', 2);

    await appendElement(page, excalidrawRectangle('phone-clear-rect-1', 100, 100));
    await expect.poll(() => sceneElementIds(page), { timeout: 10000 }).toContain('phone-clear-rect-1');

    await page.getByTestId('room-title-trigger').click();
    const clearItem = page.getByTestId('room-menu-clear');
    await expect(clearItem).toBeVisible();
    await clearItem.click();

    await expect(page.getByTestId('whiteboard-clear-confirm-btn')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('whiteboard-clear-confirm-btn').click();

    await expect.poll(() => sceneElementIds(page), { timeout: 10000 }).toEqual([]);
  });

  test('the owner guides a second participant from the phone title menu', async ({ page, browser }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const roomId = await createRoomWithMaxUsers(page, 'PhoneGuideOwner', 2);

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'PhoneGuideStudent');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await waitForExcalidrawApi(page);
      await waitForExcalidrawApi(peerPage);

      await page.getByTestId('room-title-trigger').click();
      const guideItem = page.getByTestId('room-menu-guide');
      await expect(guideItem).toHaveText('Guide class');
      await guideItem.click();

      // The menu closes on click, the same as every other item; reopen it to
      // read the flipped label.
      await page.getByTestId('room-title-trigger').click();
      await expect(page.getByTestId('room-menu-guide')).toHaveText('Stop guiding');
      await page.getByTestId('room-title-trigger').click();

      await page.evaluate(() => {
        (window as any).__debugExcalidrawApi.updateScene({
          appState: { scrollX: -410, scrollY: 275, zoom: { value: 1.35 } },
        });
      });

      await expect
        .poll(
          async () => peerPage.evaluate(() => {
            const state = (window as any).__debugExcalidrawApi?.getAppState?.();
            return state ? { x: state.scrollX, y: state.scrollY, zoom: state.zoom.value } : null;
          }),
          { timeout: 15000, message: 'student never followed the teacher viewport' },
        )
        .toMatchObject({ x: -410, y: 275, zoom: 1.35 });
    } finally {
      await peerContext.close();
    }
  });

  test("a student's phone title menu has neither Guide class nor Clear board", async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'PhoneStudentGateOwner', 2);

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await peerPage.setViewportSize({ width: 390, height: 844 });
      await joinExistingRoom(peerPage, roomId, 'PhoneStudentGate');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      // A non-owner gets no title menu at all (RoomTitleMenu's canManage
      // gate), so neither phone-only item can be reached.
      await expect(peerPage.getByTestId('room-title-trigger')).toHaveCount(0);
      await expect(peerPage.getByTestId('room-menu-guide')).toHaveCount(0);
      await expect(peerPage.getByTestId('room-menu-clear')).toHaveCount(0);
    } finally {
      await peerContext.close();
    }
  });

  test('at 1440x900 the title menu does not show Guide class or Clear board; the footer does', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await createRoomWithMaxUsers(page, 'DesktopFooterOwner', 2);

    await expect(page.getByTestId('whiteboard-tool-guide')).toBeVisible();
    await expect(page.getByTestId('whiteboard-clear-btn')).toBeVisible();

    await page.getByTestId('room-title-trigger').click();
    await expect(page.getByTestId('room-menu-guide')).toBeHidden();
    await expect(page.getByTestId('room-menu-clear')).toBeHidden();
  });

  test('each phone-only item is at least 44px tall at 390px wide', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createRoomWithMaxUsers(page, 'PhoneHeightOwner', 2);

    await page.getByTestId('room-title-trigger').click();
    const guideBox = await page.getByTestId('room-menu-guide').boundingBox();
    const clearBox = await page.getByTestId('room-menu-clear').boundingBox();

    expect(guideBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(clearBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});
