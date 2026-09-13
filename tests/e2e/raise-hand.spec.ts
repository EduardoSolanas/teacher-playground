// @ts-nocheck
import { test, expect } from './fixtures';
import {
  newAuthenticatedContext,
  createRoomWithMaxUsers,
  joinRoomApproved,
  expandPresenceIfCollapsed,
} from './helpers';

test.describe('raise hand', () => {
  test('admitted peer raises and host sees the hand label', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, `raise-host-${crypto.randomUUID()}`);
    const guest = await newAuthenticatedContext(browser, `raise-guest-${crypto.randomUUID()}`);
    const hostPage = await host.newPage();
    const guestPage = await guest.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'RaiseHost', 2);
    await joinRoomApproved(guestPage, hostPage, roomId, 'RaisePeer');

    await expandPresenceIfCollapsed(guestPage);
    await expect(guestPage.getByTestId('whiteboard-raise-hand')).toBeVisible({ timeout: 15000 });
    await guestPage.getByTestId('whiteboard-raise-hand').click();

    await expandPresenceIfCollapsed(hostPage);
    await expect(hostPage.getByTestId('whiteboard-raised-hand-cue')).toBeVisible({ timeout: 15000 });
    await expect(hostPage.locator('[data-testid^="whiteboard-user-hand-"]')).toContainText(
      /Hand raised/i,
      { timeout: 15000 },
    );

    await host.close();
    await guest.close();
  });

  test('host lowers a raised hand from the raised-hands section', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, `lower-host-${crypto.randomUUID()}`);
    const guest = await newAuthenticatedContext(browser, `lower-guest-${crypto.randomUUID()}`);
    const hostPage = await host.newPage();
    const guestPage = await guest.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'LowerHost', 2);
    await joinRoomApproved(guestPage, hostPage, roomId, 'LowerPeer');

    await expandPresenceIfCollapsed(guestPage);
    await guestPage.getByTestId('whiteboard-raise-hand').click();
    await expect(guestPage.getByTestId('whiteboard-raise-hand')).toContainText(/lower hand/i, {
      timeout: 15000,
    });

    await expandPresenceIfCollapsed(hostPage);
    await expect(hostPage.getByTestId('whiteboard-raised-hands-count')).toHaveText('1', {
      timeout: 15000,
    });
    await hostPage.locator('[data-testid^="whiteboard-lower-hand-"]').first().click();

    await expect(hostPage.getByTestId('whiteboard-raised-hands')).toHaveCount(0, {
      timeout: 15000,
    });
    await expect(guestPage.getByTestId('whiteboard-raise-hand')).toContainText(/raise hand/i, {
      timeout: 15000,
    });

    await host.close();
    await guest.close();
  });
});
