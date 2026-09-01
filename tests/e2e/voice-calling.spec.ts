import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import { newAuthenticatedContext, createRoomWithMaxUsers, joinRoomApproved, expandPresenceIfCollapsed } from './helpers';

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

function isAvTokenResponse(url: string, method: string): boolean {
  return method === 'POST' && url.includes('/api/av/token?');
}

function isAvMuteRequest(url: string, method: string): boolean {
  return method === 'POST' && url.includes('/api/av/mute?');
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
    test.skip(true, 'LiveKit is not configured in this E2E environment.');
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

    await expect(hostPage.getByTestId('av-start-call')).toBeVisible({ timeout: 15000 });
    await expect(hostPage.getByTestId('av-session-panel')).toHaveCount(0);

    const hostToken = hostPage.waitForResponse((candidate) =>
      isAvTokenResponse(candidate.url(), candidate.request().method()),
    );
    await hostPage.getByTestId('av-start-call').click();
    const tokenResponse = await hostToken;
    if (tokenResponse.status() === 503) {
      test.skip(true, 'LiveKit is not configured in this E2E environment.');
    }
    await waitForJoinedCall(hostPage);

    await joinExistingRoom(guestPage, roomId, 'AvGuest');
    await expect(guestPage.getByRole('heading', { name: /Room is Full/ })).toBeVisible({
      timeout: 15000,
    });
    await expect(guestPage.getByTestId('av-start-call')).toHaveCount(0);
    await expect(guestPage.getByTestId('av-session-panel')).toHaveCount(0);
  });

  test('host sees admitted peer roster state and owner-only controls while peer sees none, and host mute targets the peer account identity', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, 'av-owner');
    const peer = await newAuthenticatedContext(browser, 'av-peer');
    const hostPage = await host.newPage();
    const peerPage = await peer.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'Host', 2);
    await joinRoomApproved(peerPage, hostPage, roomId, 'Peer');

    const hostIdentityResponse = waitForAvIdentity(hostPage);
    await hostPage.getByTestId('av-start-call').click();
    const hostAccountId = await hostIdentityResponse;
    await waitForJoinedCall(hostPage);

    const peerIdentityResponse = waitForAvIdentity(peerPage);
    await peerPage.getByTestId('av-start-call').click();
    const peerAccountId = await peerIdentityResponse;
    await waitForJoinedCall(peerPage);

    await expandPresenceIfCollapsed(hostPage);
    await expandPresenceIfCollapsed(peerPage);

    const hostRow = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'Host' }).first();
    const peerRow = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'Peer' }).first();

    await expect(hostRow).toContainText('Host');
    await expect(hostRow).toContainText('Mic on');
    await expect(hostRow).toContainText('Camera on');
    await expect(peerRow).toContainText('Peer');
    await expect(peerRow).toContainText('Mic on');
    await expect(peerRow).toContainText('Camera on');
    await expect(peerRow.getByRole('button', { name: 'Mute Peer microphone' })).toBeVisible({ timeout: 15000 });
    await expect(peerRow.getByRole('button', { name: 'Mute Peer camera' })).toBeVisible({ timeout: 15000 });

    await expect(peerPage.getByRole('button', { name: 'Mute Host microphone' })).toHaveCount(0);
    await expect(peerPage.getByRole('button', { name: 'Mute Host camera' })).toHaveCount(0);
    await expect(peerPage.getByRole('button', { name: 'Mute Peer microphone' })).toHaveCount(0);
    await expect(peerPage.getByRole('button', { name: 'Mute Peer camera' })).toHaveCount(0);

    const muteRequestPromise = hostPage.waitForRequest((candidate) =>
      isAvMuteRequest(candidate.url(), candidate.method()),
    );
    await peerRow.getByRole('button', { name: 'Mute Peer microphone' }).click();
    const muteRequest = await muteRequestPromise;
    expect(muteRequest.postDataJSON()).toEqual({ target: peerAccountId });
    expect(peerAccountId).not.toBe(hostAccountId);

    await expect
      .poll(async () => {
        const response = await hostPage.request.get(appUrl(`/api/whiteboard/room/${roomId}/presence`));
        if (!response.ok()) return null;
        const body = (await response.json()) as { users?: Array<{ peerId: string; userName: string }> };
        const peerUser = body.users?.find((user) => user.userName === 'Peer');
        return peerUser?.peerId ?? null;
      }, { timeout: 15000, message: 'peer never appeared in the host roster payload' })
      .not.toBe(peerAccountId);
  });
});
