import { test, expect, Page } from '@playwright/test';
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

  return new URL(page.url()).pathname.split('/').pop()!;
}

async function joinExistingRoom(page: Page, roomId: string, name: string) {
  await page.goto(appUrl(`/whiteboard/${roomId}`));
  const usernameInput = page.getByTestId('whiteboard-username-input');
  await usernameInput.waitFor({ state: 'visible', timeout: 15000 });
  await usernameInput.fill(name);
  await page.getByTestId('whiteboard-join-room-btn').click();
}

/**
 * Voice wiring smoke (no LiveKit secrets required):
 * - admitted host sees the Voice panel (unconfigured UX without LIVEKIT_*)
 * - waiting peer does not mount the Voice panel
 */
test.describe('voice calling panel', () => {
  test('admitted host sees voice panel; waiting peer does not', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, 'voice-host');
    const guest = await newAuthenticatedContext(browser, 'voice-guest');
    const hostPage = await host.newPage();
    const guestPage = await guest.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'VoiceHost', 1);
    await expect(hostPage.getByTestId('av-voice-panel')).toBeVisible({ timeout: 15000 });
    await expect(hostPage.getByTestId('av-status-message')).toContainText(/not configured/i);
    await expect(hostPage.getByTestId('av-toggle-mic')).toBeVisible();

    await joinExistingRoom(guestPage, roomId, 'VoiceGuest');
    await expect(guestPage.getByRole('heading', { name: /Room is Full/ })).toBeVisible({
      timeout: 15000,
    });
    await expect(guestPage.getByTestId('av-voice-panel')).toHaveCount(0);
  });
});
