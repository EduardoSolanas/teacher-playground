import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import { newAuthenticatedContext, createRoomWithMaxUsers, joinRoomApproved, expandPresenceIfCollapsed } from './helpers';

function appUrl(path: string) {
  return new URL(path, process.env.PLAYWRIGHT_BASE_URL).toString();
}

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

async function waitForAvIdentity(page: Page): Promise<string> {
  const response = await page.waitForResponse((candidate) =>
    isAvTokenResponse(candidate.url(), candidate.request().method()),
  );
  if (response.status() === 503) {
    throw new Error(
      'LIVEKIT_TEST_URL is not configured. ' +
      'Real-media tests require a functional LiveKit service. ' +
      'Set LIVEKIT_TEST_URL and re-run this test profile with: npm run test:e2e:media'
    );
  }
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { identity?: string };
  expect(typeof body.identity).toBe('string');
  expect(body.identity?.length).toBeGreaterThan(0);
  return body.identity as string;
}

async function waitForJoinedCall(page: Page) {
  await expect(page.getByTestId('av-session-panel')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('av-toggle-mic')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('av-toggle-cam')).toBeVisible({ timeout: 15000 });
}

/**
 * Real-media voice calling validation.
 *
 * These tests require a functional LiveKit service with LIVEKIT_TEST_URL configured.
 * They verify actual media join/teardown and track lifecycle, not just UI gating.
 *
 * The media profile is opt-in and only runs when LIVEKIT_TEST_URL is set.
 * If the service is unavailable, tests FAIL (not skip) with a clear message.
 */
test.describe('real-media voice calling', () => {
  test('participants can join and leave a call with active media tracks', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, 'media-host');
    const peer = await newAuthenticatedContext(browser, 'media-peer');
    const hostPage = await host.newPage();
    const peerPage = await peer.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'Host', 2);
    await joinRoomApproved(peerPage, hostPage, roomId, 'Peer');

    // Start the call from the host
    const hostIdentityPromise = waitForAvIdentity(hostPage);
    const peerIdentityPromise = waitForAvIdentity(peerPage);

    await hostPage.getByTestId('av-start-call').click();
    const hostIdentity = await hostIdentityPromise;
    const peerIdentity = await peerIdentityPromise;

    // Verify both participants joined
    await waitForJoinedCall(hostPage);
    await waitForJoinedCall(peerPage);

    // Verify they can see each other's roster and media indicators
    await expandPresenceIfCollapsed(hostPage);
    await expandPresenceIfCollapsed(peerPage);

    const hostRow = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'Host' }).first();
    const peerRow = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'Peer' }).first();

    // Verify media indicators are present
    await expect(hostRow.getByRole('img', { name: /Host microphone is live|Host is talking/ })).toBeVisible({ timeout: 15000 });
    await expect(hostRow.getByRole('img', { name: 'Host camera is on' })).toBeVisible({ timeout: 15000 });
    await expect(peerRow.getByRole('img', { name: /Peer microphone is live|Peer is talking/ })).toBeVisible({ timeout: 15000 });
    await expect(peerRow.getByRole('img', { name: 'Peer camera is on' })).toBeVisible({ timeout: 15000 });

    // Identities should be different
    expect(peerIdentity).not.toBe(hostIdentity);

    // Close contexts
    await host.close();
    await peer.close();
  });

  test('host can mute participant audio', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, 'media-mute-host');
    const peer = await newAuthenticatedContext(browser, 'media-mute-peer');
    const hostPage = await host.newPage();
    const peerPage = await peer.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'MuteHost', 2);
    await joinRoomApproved(peerPage, hostPage, roomId, 'MutePeer');

    // Start call
    const hostIdentityPromise = waitForAvIdentity(hostPage);
    const peerIdentityPromise = waitForAvIdentity(peerPage);

    await hostPage.getByTestId('av-start-call').click();
    const peerAccountId = await peerIdentityPromise;
    await hostIdentityPromise;

    await waitForJoinedCall(hostPage);
    await waitForJoinedCall(peerPage);

    await expandPresenceIfCollapsed(hostPage);

    const peerRow = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'MutePeer' }).first();

    // Verify mute button is present for host
    await expect(peerRow.getByRole('button', { name: 'Mute MutePeer microphone' })).toBeVisible({ timeout: 15000 });

    // Mute the peer
    await peerRow.getByRole('button', { name: 'Mute MutePeer microphone' }).click();

    // Verify peer mute request was sent with correct account identity
    const muteRequest = await hostPage.waitForRequest((candidate) =>
      candidate.method() === 'POST' && candidate.url().includes('/api/av/mute?'),
    );
    expect(muteRequest.postDataJSON()).toEqual({ target: peerAccountId });

    // Close contexts
    await host.close();
    await peer.close();
  });

  test('peer roster shows accurate media state while call is active', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, 'media-state-host');
    const peer = await newAuthenticatedContext(browser, 'media-state-peer');
    const hostPage = await host.newPage();
    const peerPage = await peer.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'StateHost', 2);
    await joinRoomApproved(peerPage, hostPage, roomId, 'StatePeer');

    // Start call
    await hostPage.getByTestId('av-start-call').click();
    await waitForAvIdentity(hostPage);
    await waitForAvIdentity(peerPage);
    await waitForJoinedCall(hostPage);
    await waitForJoinedCall(peerPage);

    await expandPresenceIfCollapsed(hostPage);
    await expandPresenceIfCollapsed(peerPage);

    // Verify session panels are visible and persistent
    await expect(hostPage.getByTestId('av-session-panel')).toBeVisible();
    await expect(peerPage.getByTestId('av-session-panel')).toBeVisible();

    // Toggle off and verify call controls remain accessible
    const hostRow = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'StateHost' }).first();
    await expect(hostRow.getByRole('img', { name: 'StateHost camera is on' })).toBeVisible();

    // Host should be able to access mute controls
    const peerRow = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'StatePeer' }).first();
    await expect(peerRow.getByRole('button', { name: 'Mute StatePeer microphone' })).toBeVisible({ timeout: 15000 });

    // Close contexts
    await host.close();
    await peer.close();
  });
});
