import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import { newAuthenticatedContext, createRoomWithMaxUsers } from './helpers';

function appUrl(path: string) {
  return new URL(path, process.env.PLAYWRIGHT_BASE_URL).toString();
}

async function joinExistingRoom(page: Page, roomId: string, name: string) {
  await page.goto(appUrl(`/whiteboard/${roomId}`));
  const usernameInput = page.getByTestId('whiteboard-username-input');
  await usernameInput.waitFor({ state: 'visible', timeout: 15000 });
  await usernameInput.fill(name);
  await page.getByTestId('whiteboard-join-room-btn').click();
}

/**
 * A/V gating smoke, and deliberately nothing about LiveKit itself.
 *
 * A room no longer takes the camera on admission: it offers to, and waits. So
 * what an admitted peer sees first is the invitation, not the call -- and what
 * a peer who was never admitted sees is neither.
 *
 * The panel's contents are left alone here on purpose. Whether it says the
 * call is unconfigured depends on whether the machine running this has
 * LIVEKIT_* set, and a test that passes only on an unconfigured checkout is
 * worse than one that asks a smaller question honestly.
 */
test.describe('video calling panel', () => {
  test('an admitted host is offered a call; a peer who is not in gets nothing', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, 'av-host');
    const guest = await newAuthenticatedContext(browser, 'av-guest');
    const hostPage = await host.newPage();
    const guestPage = await guest.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'AvHost', 1);

    // Offered, not started: no camera is taken until this is pressed.
    await expect(hostPage.getByTestId('av-start-call')).toBeVisible({ timeout: 15000 });
    await expect(hostPage.getByTestId('av-session-panel')).toHaveCount(0);

    await hostPage.getByTestId('av-start-call').click();
    await expect(hostPage.getByTestId('av-session-panel')).toBeVisible({ timeout: 15000 });
    await expect(hostPage.getByTestId('av-toggle-mic')).toBeVisible();
    await expect(hostPage.getByTestId('av-toggle-cam')).toBeVisible();

    await joinExistingRoom(guestPage, roomId, 'AvGuest');
    await expect(guestPage.getByRole('heading', { name: /Room is Full/ })).toBeVisible({
      timeout: 15000,
    });
    await expect(guestPage.getByTestId('av-start-call')).toHaveCount(0);
    await expect(guestPage.getByTestId('av-session-panel')).toHaveCount(0);
  });
});
