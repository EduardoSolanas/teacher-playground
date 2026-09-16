import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import {
  createRoomWithMaxUsers,
  expandPresenceIfCollapsed,
  joinRoomApproved,
  liveKitConfigured,
  newAuthenticatedContext,
} from './helpers';

test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

async function waitForJoinedCall(page: Page) {
  await expect(page.getByTestId('av-session-panel')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('av-call-status')).toContainText('live', { timeout: 20000 });
}

/*
 * Phase 10: screen share is the owner's by right and a participant's only while
 * the owner allows it. The permission is enforced by LiveKit itself -- the
 * student's token names camera and microphone only -- so this runs against a
 * real LiveKit server and reads the button state that permission produces.
 */
test.describe('screen share control', () => {
  test('a student shares only while the teacher allows it', async ({ browser }) => {
    test.setTimeout(120_000);
    const host = await newAuthenticatedContext(browser, `share-host-${Date.now()}`);
    const peer = await newAuthenticatedContext(browser, `share-peer-${Date.now()}`);
    const hostPage = await host.newPage();
    const peerPage = await peer.newPage();

    try {
      const roomId = await createRoomWithMaxUsers(hostPage, 'ShareHost', 2);
      test.skip(!(await liveKitConfigured(hostPage, roomId)), 'LiveKit is not configured in this E2E environment.');
      await joinRoomApproved(peerPage, hostPage, roomId, 'SharePeer');

      await hostPage.getByTestId('av-start-call').click();
      await hostPage.getByTestId('av-pre-join-confirm').click();
      // The room's call activation opens the check on the peer's side too.
      await peerPage.getByTestId('av-pre-join').waitFor({ state: 'visible', timeout: 15000 });
      await peerPage.getByTestId('av-pre-join-confirm').click();
      await waitForJoinedCall(hostPage);
      await waitForJoinedCall(peerPage);

      const peerShare = peerPage.getByTestId('av-toggle-screen');
      const hostShare = hostPage.getByTestId('av-toggle-screen');
      await expect(peerShare).toBeDisabled({ timeout: 15000 });
      await expect(peerShare).toHaveAttribute('title', 'Your teacher can let you share your screen');
      await expect(hostShare).toBeEnabled();

      await expandPresenceIfCollapsed(hostPage);
      const allow = hostPage.getByRole('button', { name: 'Allow SharePeer to share their screen' });
      await expect(allow).toBeVisible({ timeout: 20000 });
      await allow.click();

      await expect(peerShare).toBeEnabled({ timeout: 15000 });
      const stop = hostPage.getByRole('button', { name: 'Stop SharePeer sharing their screen' });
      await expect(stop).toBeVisible({ timeout: 15000 });

      await stop.click();
      await expect(peerShare).toBeDisabled({ timeout: 15000 });
      await expect(hostPage.getByRole('button', { name: 'Allow SharePeer to share their screen' })).toBeVisible({ timeout: 15000 });
    } finally {
      await host.close();
      await peer.close();
    }
  });
});
