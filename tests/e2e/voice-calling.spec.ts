import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import { newAuthenticatedContext } from './helpers';

function appUrl(path: string) {
  return new URL(path, process.env.PLAYWRIGHT_BASE_URL).toString();
}

async function createRoomWithMaxUsers(page: Page, name: string, maxUsers: number) {
  await page.goto(appUrl('/whiteboard'));
  await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');

  const maxUsersInput = page.locator('input[type="number"]');
  await maxUsersInput.clear();
  await maxUsersInput.fill(String(maxUsers));

  await page.getByTestId('whiteboard-create-room-btn').click();
  await expect(page.getByTestId('whiteboard-username-input')).toBeVisible();
  await page.getByTestId('whiteboard-username-input').fill(name);
  await page.getByTestId('whiteboard-join-room-btn').click();
  await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(/\/whiteboard\/[A-Za-z0-9_-]{8,}(?:\/)?$/);
  const roomId = new URL(page.url()).pathname.split('/').pop()!;
  expect(roomId).not.toBe('_room');
  expect(roomId).not.toBe('undefined');
  return roomId;
}

async function joinExistingRoom(page: Page, roomId: string, name: string) {
  await page.goto(appUrl(`/whiteboard/${roomId}`));
  const usernameInput = page.getByTestId('whiteboard-username-input');
  await usernameInput.waitFor({ state: 'visible', timeout: 15000 });
  await usernameInput.fill(name);
  await page.getByTestId('whiteboard-join-room-btn').click();
}

/**
 * A/V panel smoke (no LiveKit secrets required):
 * - admitted host sees the Call panel (unconfigured UX without LIVEKIT_*)
 * - waiting peer does not mount the Call panel
 */
test.describe('video calling panel', () => {
  test('admitted host sees call panel; waiting peer does not', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, 'av-host');
    const guest = await newAuthenticatedContext(browser, 'av-guest');
    const hostPage = await host.newPage();
    const guestPage = await guest.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'AvHost', 1);
    await expect(hostPage.getByTestId('av-session-panel')).toBeVisible({ timeout: 15000 });
    await expect(hostPage.getByTestId('av-status-message')).toContainText(/not configured/i);
    await expect(hostPage.getByTestId('av-toggle-mic')).toBeVisible();
    await expect(hostPage.getByTestId('av-toggle-cam')).toBeVisible();

    await joinExistingRoom(guestPage, roomId, 'AvGuest');
    await expect(guestPage.getByRole('heading', { name: /Room is Full/ })).toBeVisible({
      timeout: 15000,
    });
    await expect(guestPage.getByTestId('av-session-panel')).toHaveCount(0);
  });
});
