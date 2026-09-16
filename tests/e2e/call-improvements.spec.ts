import { test, expect } from './fixtures';
import { newAuthenticatedContext, createRoomWithMaxUsers, liveKitConfigured } from './helpers';
import { contrastTextOn } from '../../src/lib/whiteboard/userColor';
import type { Page } from '@playwright/test';

function isAvTokenResponse(url: string, method: string): boolean {
  return method === 'POST' && url.includes('/api/av/token?');
}

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

async function waitForJoinedCall(page: Page) {
  await expect(page.getByTestId('av-session-panel')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('av-toggle-cam')).toBeVisible({ timeout: 15000 });
}

test.describe('call identity presentation', () => {
  test('camera off keeps the board colour, first initial, and host marker', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, `call-identity-${Date.now()}`);
    const page = await host.newPage();

    try {
      const roomId = await createRoomWithMaxUsers(page, 'CallHost', 1);
      // Decided before any response wait exists; see liveKitConfigured.
      test.skip(!(await liveKitConfigured(page, roomId)), 'LiveKit is not configured in this E2E environment.');
      const boardColor = await page.evaluate(() => localStorage.getItem('whiteboard_user_color'));
      expect(boardColor).toMatch(/^#[0-9a-f]{6}$/i);
      if (!boardColor) throw new Error('board colour was not assigned on room join');

      const tokenResponse = page.waitForResponse((response) =>
        isAvTokenResponse(response.url(), response.request().method()),
      );
      await page.getByTestId('av-start-call').click();
      // The device check stands between the button and the session.
      await page.getByTestId('av-pre-join-confirm').click();
      expect((await tokenResponse).ok()).toBe(true);
      await waitForJoinedCall(page);

      const tile = page.locator('[data-testid^="av-tile-"]').first();
      const video = tile.locator('[data-testid^="av-video-track-"]');
      await expect(video).toBeAttached({ timeout: 15000 });
      const nameLabel = tile.getByTestId('av-participant-name');
      await expect(nameLabel).toContainText('CallHost');
      await expect(nameLabel.getByRole('img', { name: 'Host' })).toBeVisible();

      /*
       * No raise-hand step here. A host has no such control -- PresencePanel
       * renders it only for a non-host, and PresencePanel.test.tsx asserts its
       * absence for a host -- so a host raising their own hand is unreachable
       * and this test used to fail trying. The host marker sits with the name
       * rather than in the transient badge cluster, so it cannot be crowded out
       * by a badge in any case.
       */

      await page.getByTestId('av-toggle-cam').click();

      const avatar = tile.locator('[data-testid^="av-avatar-"]');
      await expect(avatar).toBeVisible({ timeout: 15000 });
      await expect(avatar).toHaveText('C');
      const expectedColor = await page.evaluate((color) => {
        const probe = document.createElement('span');
        probe.style.color = color;
        return probe.style.color;
      }, boardColor);
      await expect.poll(() => avatar.evaluate((element) => element.style.borderColor)).toBe(expectedColor);
      /*
       * The ring is the board colour; the initial is the ink that reads on it.
       * White failed contrast on most of the palette, yellow worst of all, so
       * the foreground is computed rather than fixed.
       */
      const expectedInk = await page.evaluate((color) => {
        const probe = document.createElement('span');
        probe.style.color = color;
        return probe.style.color;
      }, contrastTextOn(boardColor));
      await expect.poll(() => avatar.evaluate((element) => element.style.color)).toBe(expectedInk);
      await expect(video).toHaveCount(0);
      await expect(nameLabel.getByRole('img', { name: 'Host' })).toBeVisible();
    } finally {
      await host.close();
    }
  });
});

test.describe('call panel on a phone', () => {
  test('shows the whole camera tile rather than a squashed sliver', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, `call-phone-${Date.now()}`);
    const page = await host.newPage();
    await page.setViewportSize({ width: 390, height: 844 });

    try {
      const roomId = await createRoomWithMaxUsers(page, 'PhoneHost', 1);
      test.skip(!(await liveKitConfigured(page, roomId)), 'LiveKit is not configured in this E2E environment.');

      await page.getByTestId('av-start-call').click();
      await page.getByTestId('av-pre-join-confirm').click();
      await waitForJoinedCall(page);

      /*
       * The sheet is capped at 40dvh and the controls below the faces outgrow
       * it, so flexbox used to take the shortfall out of the tile strip: the
       * tile kept its 16:9 box while the strip around it was 35px tall.
       */
      const rail = page.getByTestId('av-tiles-rail');
      const tile = rail.locator('[data-testid^="av-tile-"]').first();
      await expect(tile).toBeVisible();
      await expect.poll(async () => {
        const [railBox, tileBox] = await Promise.all([rail.boundingBox(), tile.boundingBox()]);
        if (!railBox || !tileBox) return false;
        return railBox.height >= tileBox.height && tileBox.height >= (tileBox.width * 9) / 16 - 1;
      }).toBe(true);
    } finally {
      await host.close();
    }
  });

  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 640 }]) {
    test(`fits the face and the mic and camera in the sheet without scrolling at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
      const host = await newAuthenticatedContext(browser, `call-phone-fit-${viewport.height}-${Date.now()}`);
      const page = await host.newPage();
      await page.setViewportSize(viewport);

      try {
        const roomId = await createRoomWithMaxUsers(page, 'PhoneHost', 1);
        test.skip(!(await liveKitConfigured(page, roomId)), 'LiveKit is not configured in this E2E environment.');

        await page.getByTestId('av-start-call').click();
        await page.getByTestId('av-pre-join-confirm').click();
        await waitForJoinedCall(page);

        /*
         * A lone tile ran the full width of the phone, which at 16:9 is over half
         * the 40dvh sheet, and pushed mute below the fold. Mute is the control
         * somebody needs without hunting for it.
         */
        const panel = page.getByTestId('av-session-panel');
        const tile = page.getByTestId('av-tiles-rail').locator('[data-testid^="av-tile-"]').first();
        const mic = page.getByTestId('av-toggle-mic');
        await expect(tile).toBeVisible();
        await expect.poll(async () => {
          const [panelBox, tileBox, micBox, scrollTop] = await Promise.all([
            panel.boundingBox(),
            tile.boundingBox(),
            mic.boundingBox(),
            panel.evaluate((element) => element.scrollTop),
          ]);
          if (!panelBox || !tileBox || !micBox) return false;
          return scrollTop === 0
            && tileBox.y >= panelBox.y
            && micBox.y + micBox.height <= panelBox.y + panelBox.height;
        }).toBe(true);
      } finally {
        await host.close();
      }
    });
  }
});

test.describe('call rail header at the rail floor', () => {
  test('keeps every layout option inside the rail at its narrowest', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, `call-rail-floor-${Date.now()}`);
    const page = await host.newPage();
    // 18vw of 700px is 126px, under the 11rem floor, so the docked rail is
    // pinned to exactly 176px -- the width where the header used to clip.
    await page.setViewportSize({ width: 700, height: 900 });

    try {
      const roomId = await createRoomWithMaxUsers(page, 'RailHost', 1);
      test.skip(!(await liveKitConfigured(page, roomId)), 'LiveKit is not configured in this E2E environment.');

      await page.getByTestId('av-start-call').click();
      await page.getByTestId('av-pre-join-confirm').click();
      await waitForJoinedCall(page);

      const panel = page.getByTestId('av-session-panel');
      const group = page.getByRole('radiogroup', { name: 'Video layout' });
      for (const name of ['Gallery', 'Focus', 'Hidden']) {
        await expect(group.getByRole('radio', { name })).toBeVisible();
      }

      /*
       * The overflow lives one level above the radios: flexbox floors the
       * picker at its own min-content width rather than squeezing it, so the
       * radiogroup's own scroll box never overflows -- the group as a whole
       * spills past the panel edge and gets clipped there. The panel-wide
       * scroll box is no good as a yardstick either: the end-call button in
       * the controls cluster already pokes ~8px past it on its own. So the
       * group is measured where it sits -- against the panel edge -- and the
       * header's own scroll boxes are measured for internal fit.
       */
      await expect.poll(async () => {
        const [groupBox, panelBox] = await Promise.all([group.boundingBox(), panel.boundingBox()]);
        if (!groupBox || !panelBox) return Number.POSITIVE_INFINITY;
        return groupBox.x + groupBox.width - (panelBox.x + panelBox.width);
      }).toBeLessThanOrEqual(1);
      await expect.poll(() => group.evaluate((el) => {
        const headerRow = el.parentElement?.parentElement;
        const boxes = [el, headerRow].map((box) => (box ? box.scrollWidth - box.clientWidth : Number.POSITIVE_INFINITY));
        return Math.max(...boxes);
      })).toBeLessThanOrEqual(1);

      await group.getByRole('radio', { name: 'Hidden' }).click();
      await expect(group.getByRole('radio', { name: 'Hidden' })).toHaveAttribute('aria-checked', 'true');
      await expect(group.getByRole('radio', { name: 'Gallery' })).toHaveAttribute('aria-checked', 'false');
    } finally {
      await host.close();
    }
  });
});
