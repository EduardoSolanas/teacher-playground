import { test, expect } from './fixtures';
import { newAuthenticatedContext, createRoomWithMaxUsers, expandPresenceIfCollapsed } from './helpers';
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
      await createRoomWithMaxUsers(page, 'CallHost', 1);
      const boardColor = await page.evaluate(() => localStorage.getItem('whiteboard_user_color'));
      expect(boardColor).toMatch(/^#[0-9a-f]{6}$/i);
      if (!boardColor) throw new Error('board colour was not assigned on room join');

      const tokenResponse = page.waitForResponse((response) =>
        isAvTokenResponse(response.url(), response.request().method()),
      );
      await page.getByTestId('av-start-call').click();
      const token = await tokenResponse;
      if (token.status() === 503) {
        test.skip(true, 'LiveKit is not configured in this E2E environment.');
      }
      expect(token.ok()).toBe(true);
      await waitForJoinedCall(page);

      const tile = page.locator('[data-testid^="av-tile-"]').first();
      const video = tile.locator('[data-testid^="av-video-track-"]');
      await expect(video).toBeAttached({ timeout: 15000 });
      const nameLabel = tile.getByTestId('av-participant-name');
      await expect(nameLabel).toContainText('CallHost');
      await expect(nameLabel.getByRole('img', { name: 'Host' })).toBeVisible();

      await expandPresenceIfCollapsed(page);
      await page.getByTestId('whiteboard-raise-hand').click();
      await expect(tile.locator('[data-testid^="av-hand-raised-"]')).toBeVisible({ timeout: 15000 });
      await expect(nameLabel.getByRole('img', { name: 'Host' })).toBeVisible();

      await page.getByTestId('av-toggle-cam').click();

      const avatar = tile.locator('[data-testid^="av-avatar-"]');
      await expect(avatar).toBeVisible({ timeout: 15000 });
      await expect(avatar).toHaveText('C');
      const expectedColor = await page.evaluate((color) => {
        const probe = document.createElement('span');
        probe.style.color = color;
        return probe.style.color;
      }, boardColor);
      await expect.poll(() => avatar.evaluate((element) => element.style.color)).toBe(expectedColor);
      await expect.poll(() => avatar.evaluate((element) => element.style.borderColor)).toBe(expectedColor);
      await expect(video).toHaveCount(0);
      await expect(nameLabel.getByRole('img', { name: 'Host' })).toBeVisible();
    } finally {
      await host.close();
    }
  });
});
