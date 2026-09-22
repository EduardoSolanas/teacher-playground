import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import {
  newAuthenticatedContext,
  createRoomWithMaxUsers,
  joinRoomApproved,
  expandPresenceIfCollapsed,
  liveKitConfigured,
  moderateApprovedPeer,
  approveFirstWaitingPeer,
} from './helpers';

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

const LIVEKIT_UNCONFIGURED = 'LiveKit is not configured in this E2E environment.';

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
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { identity?: string };
  expect(typeof body.identity).toBe('string');
  expect(body.identity?.length).toBeGreaterThan(0);
  return body.identity as string;
}

async function startCallAsHost(hostPage: Page) {
  const hostToken = hostPage.waitForResponse((candidate) =>
    isAvTokenResponse(candidate.url(), candidate.request().method()),
  );
  await hostPage.getByTestId('av-start-call').click();
  // The device check stands between the button and the session; confirming
  // is what requests the token.
  await hostPage.getByTestId('av-pre-join').waitFor({ state: 'visible', timeout: 15000 });
  await hostPage.getByTestId('av-pre-join-confirm').click();
  expect((await hostToken).ok()).toBe(true);
}

/**
 * The room's call activation opens the device check on an admitted peer's
 * side; the peer joins by confirming it, exactly like the host does.
 */
async function confirmPeerPreJoin(peerPage: Page) {
  await peerPage.getByTestId('av-pre-join').waitFor({ state: 'visible', timeout: 15000 });
  await peerPage.getByTestId('av-pre-join-confirm').click();
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
 *
 * Each test probes the token route once, before it waits on any response, and
 * skips there when LiveKit is unset (see liveKitConfigured).
 */
test.describe('video calling panel', () => {
  test('an admitted host can hide tiles with Hidden and return to Gallery while call controls remain', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, 'av-layout-host');
    const hostPage = await host.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'AvHost', 1);
    test.skip(!(await liveKitConfigured(hostPage, roomId)), LIVEKIT_UNCONFIGURED);

    await startCallAsHost(hostPage);
    await waitForJoinedCall(hostPage);

    await expect(hostPage.getByRole('radio', { name: 'Gallery' })).toHaveAttribute('aria-checked', 'true');
    const tiles = hostPage.locator('[data-testid^="av-tile-"]');
    await expect(tiles.first()).toBeVisible({ timeout: 15000 });

    await hostPage.getByRole('radio', { name: 'Hidden' }).click();
    await expect(hostPage.getByTestId('av-call-controls')).toBeVisible({ timeout: 15000 });
    await expect(hostPage.getByTestId('av-toggle-mic')).toBeVisible({ timeout: 15000 });
    await expect(hostPage.getByTestId('av-toggle-cam')).toBeVisible({ timeout: 15000 });
    await expect(tiles).toHaveCount(0);

    await hostPage.getByRole('radio', { name: 'Gallery' }).click();
    await expect(hostPage.getByRole('radio', { name: 'Gallery' })).toHaveAttribute('aria-checked', 'true');
    await expect(tiles.first()).toBeVisible({ timeout: 15000 });
  });

  test('an admitted host is offered a call; a peer who is not in gets nothing', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, 'av-host');
    const guest = await newAuthenticatedContext(browser, 'av-guest');
    const hostPage = await host.newPage();
    const guestPage = await guest.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'AvHost', 1);
    test.skip(!(await liveKitConfigured(hostPage, roomId)), LIVEKIT_UNCONFIGURED);

    await expect(hostPage.getByTestId('av-start-call')).toBeVisible({ timeout: 15000 });
    await expect(hostPage.getByTestId('av-session-panel')).toHaveCount(0);

    await startCallAsHost(hostPage);
    await waitForJoinedCall(hostPage);

    await joinExistingRoom(guestPage, roomId, 'AvGuest');
    await expect(guestPage.getByRole('heading', { name: /Room is Full/ })).toBeVisible({
      timeout: 15000,
    });
    await expect(guestPage.getByTestId('av-start-call')).toHaveCount(0);
    await expect(guestPage.getByTestId('av-session-panel')).toHaveCount(0);
  });

  test('host sees admitted peer roster state and owner-only controls while peer sees none, and host mute targets the peer account, not the call identity', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, 'av-owner');
    const peer = await newAuthenticatedContext(browser, 'av-peer');
    const hostPage = await host.newPage();
    const peerPage = await peer.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'Host', 2);
    test.skip(!(await liveKitConfigured(hostPage, roomId)), LIVEKIT_UNCONFIGURED);
    await joinRoomApproved(peerPage, hostPage, roomId, 'Peer');

    await expect(peerPage.getByTestId('av-start-call')).toHaveCount(0);

    const identities = Promise.all([waitForAvIdentity(hostPage), waitForAvIdentity(peerPage)]);
    await startCallAsHost(hostPage);
    await confirmPeerPreJoin(peerPage);
    // Awaited together so a failure on one side does not leave the other wait
    // pending past the end of the test.
    const [hostTokenIdentity, peerTokenIdentity] = await identities;
    await waitForJoinedCall(hostPage);
    await waitForJoinedCall(peerPage);

    await expandPresenceIfCollapsed(hostPage);
    await expandPresenceIfCollapsed(peerPage);

    const hostRow = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'Host' }).first();
    const peerRow = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'Peer' }).first();

    await expect(hostRow).toContainText('Host');
    await expect(hostRow.getByRole('img', { name: /Host microphone is live|Host is talking/ })).toBeVisible({ timeout: 15000 });
    await expect(hostRow.getByRole('img', { name: 'Host camera is on' })).toBeVisible({ timeout: 15000 });
    await expect(peerRow).toContainText('Peer');
    await expect(peerRow.getByRole('img', { name: /Peer microphone is live|Peer is talking/ })).toBeVisible({ timeout: 15000 });
    await expect(peerRow.getByRole('img', { name: 'Peer camera is on' })).toBeVisible({ timeout: 15000 });
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
    // Mute addresses the peer's account from the owner's presence roster,
    // never the opaque per-room LiveKit identity minted for the call (M4).
    const muteTarget = (muteRequest.postDataJSON() as { target: string }).target;
    expect(muteTarget).not.toBe(peerTokenIdentity);
    expect(muteTarget).not.toBe(hostTokenIdentity);

    // Collected through an array so TypeScript does not narrow the
    // closure-assigned variable to null before these assertions run.
    const rosterPeers: Array<{ peerId?: string; userName?: string; accountId?: string }> = [];
    await expect
      .poll(async () => {
        const response = await hostPage.request.get(appUrl(`/api/whiteboard/room/${roomId}/presence`));
        if (!response.ok) return null;
        const body = (await response.json()) as { users?: Array<{ peerId: string; userName: string; accountId?: string }> };
        const found = body.users?.find((user) => user.userName === 'Peer') ?? null;
        if (found) rosterPeers.push(found);
        return found?.accountId ?? null;
      }, { timeout: 15000, message: 'peer never appeared in the host roster payload' })
      .toBe(muteTarget);
    const rosterPeer = rosterPeers[rosterPeers.length - 1] ?? null;
    expect(rosterPeer?.peerId).toBeTruthy();
    expect(rosterPeer?.peerId).not.toBe(muteTarget);
    expect(rosterPeer?.peerId).not.toBe(peerTokenIdentity);
    expect(peerTokenIdentity).not.toBe(muteTarget);
  });

  test('ending the call for everyone tells the peers the teacher ended it', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, 'av-end-host');
    const peer = await newAuthenticatedContext(browser, 'av-end-peer');
    const hostPage = await host.newPage();
    const peerPage = await peer.newPage();

    try {
      const roomId = await createRoomWithMaxUsers(hostPage, 'EndHost', 2);
      test.skip(!(await liveKitConfigured(hostPage, roomId)), LIVEKIT_UNCONFIGURED);
      await joinRoomApproved(peerPage, hostPage, roomId, 'EndPeer');

      await startCallAsHost(hostPage);
      await confirmPeerPreJoin(peerPage);
      await waitForJoinedCall(hostPage);
      await waitForJoinedCall(peerPage);

      await hostPage.getByTestId('av-end-call-everyone').click();
      await hostPage.getByTestId('av-end-call-confirm-confirm-btn').click();

      /*
       * The peer's panel unmounts when the room call ends. Without the notice
       * the call simply vanished with no explanation; the point of this test
       * is that something says so.
       */
      await expect(peerPage.getByTestId('whiteboard-call-ended')).toContainText(
        'The teacher ended the call',
        { timeout: 15000 },
      );
      await expect(peerPage.getByTestId('av-session-panel')).toHaveCount(0);
    } finally {
      await host.close();
      await peer.close();
    }
  });

  /*
   * The pre-join gate: nobody joins the room call without passing through the
   * device check, whichever side of the activation they are on.
   */

  /** Admits the student while no call is live, then starts one from the host. */
  async function admitStudentAndStartCall(
    hostPage: Page,
    studentPage: Page,
    hostName: string,
    studentName: string,
  ): Promise<void> {
    const roomId = await createRoomWithMaxUsers(hostPage, hostName, 2);
    test.skip(!(await liveKitConfigured(hostPage, roomId)), LIVEKIT_UNCONFIGURED);
    await joinRoomApproved(studentPage, hostPage, roomId, studentName);
    await startCallAsHost(hostPage);
    await waitForJoinedCall(hostPage);
  }

  test('a student is asked to check their devices before the call admits them', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, 'prejoin-host');
    const student = await newAuthenticatedContext(browser, 'prejoin-student');
    const hostPage = await host.newPage();
    const studentPage = await student.newPage();

    try {
      await admitStudentAndStartCall(hostPage, studentPage, 'PreJoinHost', 'PreJoinStudent');

      // The room's call activation asks; it does not join.
      await expect(studentPage.getByTestId('av-pre-join')).toBeVisible({ timeout: 15000 });
      await expect(studentPage.getByTestId('av-session-panel')).toHaveCount(0);

      // Confirming is what joins.
      await studentPage.getByTestId('av-pre-join-confirm').click();
      await waitForJoinedCall(studentPage);
    } finally {
      await host.close();
      await student.close();
    }
  });

  test('a student who cancels the device check stays out until they ask again', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, 'prejoin-cancel-host');
    const student = await newAuthenticatedContext(browser, 'prejoin-cancel-student');
    const hostPage = await host.newPage();
    const studentPage = await student.newPage();

    try {
      await admitStudentAndStartCall(hostPage, studentPage, 'PreJoinCancelHost', 'PreJoinCancelStudent');

      await expect(studentPage.getByTestId('av-pre-join')).toBeVisible({ timeout: 15000 });
      await studentPage.getByTestId('av-pre-join-cancel').click();
      await expect(studentPage.getByTestId('av-pre-join')).toHaveCount(0);
      await expect(studentPage.getByTestId('av-session-panel')).toHaveCount(0);

      // Not stranded: the explicit control is the way back in, and pressing
      // it asks again rather than joining silently.
      await expect(studentPage.getByTestId('av-start-call')).toBeVisible({ timeout: 15000 });
      await studentPage.getByTestId('av-start-call').click();
      await expect(studentPage.getByTestId('av-pre-join')).toBeVisible({ timeout: 15000 });
      await studentPage.getByTestId('av-pre-join-confirm').click();
      await waitForJoinedCall(studentPage);
    } finally {
      await host.close();
      await student.close();
    }
  });

  test('a call ending asks the student again the next time it starts', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, 'prejoin-restart-host');
    const student = await newAuthenticatedContext(browser, 'prejoin-restart-student');
    const hostPage = await host.newPage();
    const studentPage = await student.newPage();

    try {
      await admitStudentAndStartCall(hostPage, studentPage, 'PreJoinRestartHost', 'PreJoinRestartStudent');

      await expect(studentPage.getByTestId('av-pre-join')).toBeVisible({ timeout: 15000 });
      await studentPage.getByTestId('av-pre-join-cancel').click();
      await expect(studentPage.getByTestId('av-pre-join')).toHaveCount(0);

      // The teacher ends this call and starts a fresh one.
      await hostPage.getByTestId('av-end-call-everyone').click();
      await hostPage.getByTestId('av-end-call-confirm-confirm-btn').click();
      await startCallAsHost(hostPage);

      // The refusal answered the previous call; the new one asks again.
      await expect(studentPage.getByTestId('av-pre-join')).toBeVisible({ timeout: 15000 });
    } finally {
      await host.close();
      await student.close();
    }
  });

  test('a student who declined is not asked twice by the same call', async ({ browser }) => {
    const host = await newAuthenticatedContext(browser, 'prejoin-stay-host');
    const student = await newAuthenticatedContext(browser, 'prejoin-stay-student');
    const hostPage = await host.newPage();
    const studentPage = await student.newPage();

    try {
      await admitStudentAndStartCall(hostPage, studentPage, 'PreJoinStayHost', 'PreJoinStayStudent');

      await expect(studentPage.getByTestId('av-pre-join')).toBeVisible({ timeout: 15000 });
      await studentPage.getByTestId('av-pre-join-cancel').click();
      await expect(studentPage.getByTestId('av-pre-join')).toHaveCount(0);

      /*
       * Out to the waiting room and back in, while the call never stops. The
       * re-admission re-runs the peer's call-entry decision, which must honour
       * the refusal already given instead of springing the check again.
       */
      await expandPresenceIfCollapsed(hostPage);
      const studentRow = hostPage
        .locator('[data-testid^="whiteboard-user-"]')
        .filter({ hasText: 'PreJoinStayStudent' })
        .first();
      await expect(studentRow).toBeVisible({ timeout: 15000 });
      const rowTestId = await studentRow.getAttribute('data-testid');
      const peerId = rowTestId?.replace('whiteboard-user-', '');
      expect(peerId).toBeTruthy();
      await moderateApprovedPeer(hostPage, peerId!, 'suspend');
      await expect(studentPage.getByTestId('whiteboard-canvas-area')).toHaveCount(0);

      await approveFirstWaitingPeer(hostPage);
      await expect(studentPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      // The refusal stands for the call that is still live; the explicit
      // button remains the way in.
      await expect(studentPage.getByTestId('av-pre-join')).toHaveCount(0);
      await expect(studentPage.getByTestId('av-start-call')).toBeVisible({ timeout: 15000 });
    } finally {
      await host.close();
      await student.close();
    }
  });
});
