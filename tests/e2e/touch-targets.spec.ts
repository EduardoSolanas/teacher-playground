import { test, expect, type Page } from '@playwright/test';
import {
  createRoomWithMaxUsers,
  newAuthenticatedContext,
  joinExistingRoom,
  approveFirstWaitingPeer,
  expectWaiting,
  liveKitConfigured,
} from './helpers';

/*
 * Every touch target in the room's own chrome -- top nav, board tab strip,
 * and our floating buttons -- must be reachable with a thumb: at least
 * 44x44 CSS px at a phone width, per the platform's own minimum. Excalidraw's
 * toolbar/island is the fork's own surface and stays out of scope; see
 * AGENTS.md and the standing rule this spec exists to enforce.
 *
 * Run red first: before the room chrome was resized, this failed with a list
 * of offenders (control + measured size) reproduced in the task report.
 */

const MIN = 44;

type Offender = { name: string; width: number; height: number };

async function measureRegion(page: Page, regionSelector: string): Promise<Offender[]> {
  const region = page.locator(regionSelector);
  const controls = region.locator('button, a, [role="button"]');
  const count = await controls.count();
  const offenders: Offender[] = [];
  for (let i = 0; i < count; i += 1) {
    const control = controls.nth(i);
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    if (!box) continue;
    if (box.width < MIN || box.height < MIN) {
      const name = (await control.getAttribute('data-testid'))
        ?? (await control.getAttribute('aria-label'))
        ?? (await control.textContent())?.trim()
        ?? `${regionSelector} control #${i}`;
      offenders.push({ name, width: Math.round(box.width), height: Math.round(box.height) });
    }
  }
  return offenders;
}

function describeOffenders(offenders: Offender[]): string {
  return offenders.map((o) => `${o.name}: ${o.width}x${o.height}`).join('\n');
}

test.describe('Room chrome touch targets at 390px', () => {
  test('every control in the top nav and board tabs is at least 44x44', async ({ page, browser }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const roomId = await createRoomWithMaxUsers(page, 'TouchTargetOwner', 2);

    // A second board, so the tab strip carries the pencil/rename and delete
    // controls the audit flagged, not just the undeletable 'main' tab.
    await page.getByTestId('board-tabs-add').click();
    await expect(page.getByTestId('board-tabs').locator('button[data-testid^="board-tab-"]')).toHaveCount(2);

    // A second participant, so the People button shows peer faces and the
    // presence panel is reachable, the same shape the audit measured.
    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'TouchTargetStudent');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      const navOffenders = await measureRegion(page, '[data-testid="whiteboard-room-top-nav"]');
      expect(navOffenders, `top nav offenders:\n${describeOffenders(navOffenders)}`).toEqual([]);

      const tabOffenders = await measureRegion(page, '[data-testid="board-tabs"]');
      expect(tabOffenders, `board tab offenders:\n${describeOffenders(tabOffenders)}`).toEqual([]);

      // Rename pencil only exists on the non-main board; open it to include
      // the rename input's own hit area too.
      const secondTab = await page
        .getByTestId('board-tabs')
        .locator('button[data-testid^="board-tab-"]')
        .nth(1)
        .getAttribute('data-testid');
      const pencilTestId = secondTab!.replace('board-tab-', 'board-pencil-');
      const pencil = page.getByTestId(pencilTestId);
      await expect(pencil).toBeVisible();
      const pencilBox = await pencil.boundingBox();
      expect(pencilBox?.width ?? 0, `rename pencil width was ${pencilBox?.width}`).toBeGreaterThanOrEqual(MIN);
      expect(pencilBox?.height ?? 0, `rename pencil height was ${pencilBox?.height}`).toBeGreaterThanOrEqual(MIN);

      // Our own floating button outside Excalidraw's island.
      const supportBox = await page.getByTestId('whiteboard-support-btn').boundingBox();
      if (supportBox) {
        expect(supportBox.width, `support button was ${supportBox.width}x${supportBox.height}`).toBeGreaterThanOrEqual(MIN);
        expect(supportBox.height, `support button was ${supportBox.width}x${supportBox.height}`).toBeGreaterThanOrEqual(MIN);
      }

      // No horizontal scroll from the enlarged controls.
      const hasHorizontalScroll = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hasHorizontalScroll).toBe(false);

      // The enlarged nav must not collide with the board tabs beneath it.
      const navBox = await page.getByTestId('whiteboard-room-top-nav').boundingBox();
      const tabsBox = await page.getByTestId('board-tabs').boundingBox();
      expect(navBox && tabsBox && tabsBox.y >= navBox.y + navBox.height - 1).toBe(true);

      // Nor with Excalidraw's own toolbar beneath the tab strip.
      const toolbar = page.locator('.App-toolbar').first();
      if (await toolbar.count()) {
        const toolbarBox = await toolbar.boundingBox();
        expect(tabsBox && toolbarBox && toolbarBox.y >= tabsBox.y + tabsBox.height - 1).toBe(true);
      }

      // The pre-join "Start call" pill, same room -- avoids a second owned
      // room, which the free plan caps at one per account.
      if (await liveKitConfigured(page, roomId)) {
        const startCall = page.getByTestId('av-start-call');
        await expect(startCall).toBeVisible();
        const callBox = await startCall.boundingBox();
        expect(callBox?.width ?? 0, `av-start-call was ${callBox?.width}x${callBox?.height}`).toBeGreaterThanOrEqual(MIN);
        expect(callBox?.height ?? 0, `av-start-call was ${callBox?.width}x${callBox?.height}`).toBeGreaterThanOrEqual(MIN);
      }
    } finally {
      await peerContext.close();
    }
  });
});
