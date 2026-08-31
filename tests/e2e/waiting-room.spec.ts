import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import { newAuthenticatedContext, expandPresenceIfCollapsed, createRoomWithMaxUsers } from './helpers';

function appUrl(path: string) {
  return new URL(path, process.env.PLAYWRIGHT_BASE_URL).toString();
}

async function joinExistingRoom(page: Page, roomId: string, name = 'Peer') {
  await page.goto(`/whiteboard/${roomId}`);
  await expect
    .poll(
      async () => (await page.context().cookies()).some((cookie) => cookie.name === '__Host-teacher-session'),
      { timeout: 25000, message: 'secure local session bootstrap did not set its cookie' },
    )
    .toBe(true);
  // Wait for the prompt rather than sampling isVisible() immediately after
  // navigation: the page has not rendered yet at that point, so the check
  // returned false and the peer silently never joined the room.
  const usernameInput = page.getByTestId('whiteboard-username-input');
  const arrived = await Promise.race([
    usernameInput.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'prompt' as const).catch(() => null),
    page.getByTestId('whiteboard-canvas-area').waitFor({ state: 'visible', timeout: 15000 }).then(() => 'canvas' as const).catch(() => null),
  ]);

  if (arrived === 'prompt') {
    await usernameInput.fill(name);
    await page.getByTestId('whiteboard-join-room-btn').click();
  }
}

async function getCollabState(page: Page) {
  return page.evaluate(() => {
    const collab = (window as any).__whiteboardCollab;
    return { isWaiting: collab?.isWaiting ?? false };
  });
}

async function expectWaiting(page: Page) {
  await expect
    .poll(async () => (await getCollabState(page)).isWaiting, { timeout: 15000 })
    .toBe(true);
  await expect(page.getByRole('heading', { name: /Room is Full/ })).toBeVisible({ timeout: 15000 });
}

async function expectNotWaiting(page: Page) {
  await expect
    .poll(async () => (await getCollabState(page)).isWaiting, { timeout: 10000 })
    .toBe(false);
}

async function getFirstWaitingPeerId(hostPage: Page) {
  await expandPresenceIfCollapsed(hostPage);
  const waitingUser = hostPage.locator('[data-testid="whiteboard-waiting-section"] [data-testid^="whiteboard-user-"]').first();
  await expect(waitingUser).toBeVisible({ timeout: 15000 });
  const testId = await waitingUser.getAttribute('data-testid');
  const peerId = testId?.replace('whiteboard-user-', '');
  expect(peerId).toBeTruthy();
  return peerId!;
}

async function openFirstWaitingPeerMenu(hostPage: Page) {
  await expandPresenceIfCollapsed(hostPage);
  const waitingUser = hostPage.locator('[data-testid="whiteboard-waiting-section"] [data-testid^="whiteboard-user-"]').first();
  await expect(waitingUser).toBeVisible({ timeout: 15000 });
  const testId = await waitingUser.getAttribute('data-testid');
  const peerId = testId?.replace('whiteboard-user-', '');
  expect(peerId).toBeTruthy();
  await waitingUser.getByTestId(`whiteboard-user-options-${peerId}`).click();
  return peerId!;
}

async function approveFirstWaitingPeer(hostPage: Page) {
  await expandPresenceIfCollapsed(hostPage);
  const waitingUser = hostPage.locator('[data-testid="whiteboard-waiting-section"] [data-testid^="whiteboard-user-"]').first();
  await expect(waitingUser).toBeVisible({ timeout: 15000 });
  const testId = await waitingUser.getAttribute('data-testid');
  const peerId = testId?.replace('whiteboard-user-', '');
  expect(peerId).toBeTruthy();
  await waitingUser.getByRole('button', { name: 'Let in' }).click({ force: true });
  return peerId;
}

test.describe('Waiting Room', () => {
  test('presence list labels only the server-verified owner as Host', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);
    const hostPage = await context1.newPage();
    const peerPage = await context2.newPage();

    try {
      const roomId = await createRoomWithMaxUsers(hostPage, 'HostBadgeHost', 2);
      await expect(hostPage.locator('[data-testid^="whiteboard-user-host-"]')).toBeVisible({
        timeout: 15000,
      });
      await expect(hostPage.locator('[data-testid^="whiteboard-user-host-"]')).toHaveText('Host');

      await joinExistingRoom(peerPage, roomId, 'HostBadgePeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(hostPage);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await expect(peerPage.locator('[data-testid^="whiteboard-user-host-"]')).toHaveCount(1);
      await expect(hostPage.locator('[data-testid^="whiteboard-user-host-"]')).toHaveCount(1);
    } finally {
      await context1.close();
      await context2.close();
    }
  });

  test('peer always starts in waiting room even when room has spare capacity', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(page1, 'CapacityHost', 2);

    await joinExistingRoom(page2, roomId, 'CapacityPeer');
    await expectWaiting(page2);
    await expect(page2.getByTestId('whiteboard-canvas-area')).toHaveCount(0);

    await approveFirstWaitingPeer(page1);
    await expect(page2.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await expectNotWaiting(page2);

    await context1.close();
    await context2.close();
  });

  test('peer goes to waiting room when room is full, host can approve them', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(page1, 'HostUser', 1);

    await joinExistingRoom(page2, roomId);
    await expectWaiting(page2);
    await approveFirstWaitingPeer(page1);

    // Peer should now see the canvas
    await expect(page2.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await expectNotWaiting(page2);

    await context1.close();
    await context2.close();
  });

  test('a student knocking opens the roster the host had collapsed', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(page1, 'AutoExpandHost', 1);

    // Collapse before anyone knocks: the arrival is what has to reopen it, so
    // a panel that was already open would prove nothing.
    const toggle = page1.getByTestId('whiteboard-presence-toggle');
    await toggle.click({ force: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false', { timeout: 15000 });

    await joinExistingRoom(page2, roomId);
    await expectWaiting(page2);

    await expect(page1.getByTestId('whiteboard-presence-toggle'))
      .toHaveAttribute('aria-expanded', 'true', { timeout: 15000 });
    await expect(page1.getByTestId('whiteboard-waiting-section')).toBeVisible({ timeout: 15000 });

    await context1.close();
    await context2.close();
  });

  test('the host can collapse the roster again while a student is still waiting', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(page1, 'ReCollapseHost', 1);

    await joinExistingRoom(page2, roomId);
    await expectWaiting(page2);

    const toggle = page1.getByTestId('whiteboard-presence-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 15000 });

    // Deriving the panel's state from "someone is waiting" would pin it open
    // here and leave the host no way out of it.
    await toggle.click({ force: true });
    await expect(page1.getByTestId('whiteboard-presence-toggle'))
      .toHaveAttribute('aria-expanded', 'false', { timeout: 15000 });

    await context1.close();
    await context2.close();
  });

  test('a peer stuck in the waiting room can still reach their account', async ({ browser }) => {
    // The waiting room is the screen someone is most likely to be stranded on,
    // and for a long time it was the screen with no way out of the account.
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(page1, 'StrandedHost', 1);

    await joinExistingRoom(page2, roomId);
    await expectWaiting(page2);

    await page2.getByTestId('whiteboard-room-top-nav').getByTestId('whiteboard-profile-btn').click();
    await expect(page2.getByTestId('whiteboard-logout-btn')).toBeVisible({ timeout: 15000 });

    await context1.close();
    await context2.close();
  });

  test('host can reject a waiting peer', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(page1, 'RejectHost', 1);

    await joinExistingRoom(page2, roomId);
    await expectWaiting(page2);

    await openFirstWaitingPeerMenu(page1);
    await expect(page1.getByTestId('whiteboard-context-reject')).toBeVisible({ timeout: 10000 });
    await page1.getByTestId('whiteboard-context-reject').click();

    await expectNotWaiting(page2);
    await expect(page2.getByTestId('whiteboard-username-input')).toBeVisible({ timeout: 10000 });

    // No more Accept/Reject buttons for the rejected peer
    await expect(page1.locator('[data-testid^="whiteboard-approve-"]')).toHaveCount(0);

    await context1.close();
    await context2.close();
  });

  test('waiting peer can leave the waiting room themselves', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(page1, 'LeaveHost', 1);

    await joinExistingRoom(page2, roomId);
    await expectWaiting(page2);

    await expect(page2.getByTestId('whiteboard-leave-waiting-btn')).toBeVisible();
    await page2.getByTestId('whiteboard-leave-waiting-btn').click();

    await expectNotWaiting(page2);
    await expect(page2.getByTestId('whiteboard-username-input')).toBeVisible({ timeout: 10000 });

    // Host should see no approve buttons
    await expect(page1.locator('[data-testid^="whiteboard-approve-"]')).toHaveCount(0);

    await context1.close();
    await context2.close();
  });

  test('a peer keeps one peer id across admission', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(page1, 'StableHost', 1);

    await joinExistingRoom(page2, roomId);
    await expectWaiting(page2);
    const queuedId = await page2.evaluate(() => (window as any).__whiteboardCollab?.localPeerId);
    const approvedId = await approveFirstWaitingPeer(page1);
    expect(approvedId).toBe(queuedId);

    await expect(page2.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await expectNotWaiting(page2);

    // The presence row must survive admission: deleting it makes the next
    // heartbeat mint a fresh id, stranding every id the host already holds.
    await expect
      .poll(
        async () => page2.evaluate(() => (window as any).__whiteboardCollab?.localPeerId),
        { timeout: 15000, message: 'peer id changed after admission' },
      )
      .toBe(queuedId);
    await expect(page1.getByTestId(`whiteboard-user-${queuedId}`)).toBeVisible({ timeout: 10000 });

    await context1.close();
    await context2.close();
  });

  test('host can kick an accepted peer', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(page1, 'KickHost', 1);

    await joinExistingRoom(page2, roomId);
    await expectWaiting(page2);
    const peerId = await approveFirstWaitingPeer(page1);

    await expect(page2.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

    await page1.getByTestId(`whiteboard-user-options-${peerId}`).click();
    await expect(page1.getByTestId('whiteboard-context-kick')).toBeVisible();
    await page1.getByRole('button', { name: 'Kick from Room' }).click({ force: true });

    await expectNotWaiting(page2);
    await expect(page2.getByTestId('whiteboard-username-input')).toBeVisible({ timeout: 10000 });

    // No approve buttons should remain for this peer
    const leftoverApprove = page1.locator(`[data-testid="whiteboard-approve-${peerId}"]`);
    await expect(leftoverApprove).toHaveCount(0);

    await context1.close();
    await context2.close();
  });

  test('host can send an accepted peer back to waiting room', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(page1, 'SuspendHost', 1);

    await joinExistingRoom(page2, roomId);
    await expectWaiting(page2);
    const peerId = await approveFirstWaitingPeer(page1);

    await expect(page2.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

    await page1.getByTestId(`whiteboard-user-options-${peerId}`).click();
    await expect(page1.getByTestId('whiteboard-context-suspend')).toBeVisible();
    await page1.getByRole('button', { name: 'Send to Waiting Room' }).click({ force: true });

    await expectWaiting(page2);

    await expect(page1.getByTestId(`whiteboard-user-${peerId}`)).toContainText('Waiting', { timeout: 10000 });
    await expect(page1.getByTestId(`whiteboard-user-options-${peerId}`)).toBeVisible();

    await context1.close();
    await context2.close();
  });

  test('kicked account is banned and cannot re-queue', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(page1, 'CycleHost', 1);

    await joinExistingRoom(page2, roomId);
    await expectWaiting(page2);
    const peerId = await approveFirstWaitingPeer(page1);
    await expect(page2.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

    await page1.getByTestId(`whiteboard-user-options-${peerId}`).click();
    await expect(page1.getByTestId('whiteboard-context-kick')).toBeVisible();
    await page1.getByRole('button', { name: 'Kick from Room' }).click({ force: true });

    await expectNotWaiting(page2);

    await expect
      .poll(
        async () =>
          page2.evaluate(async (id) => {
            const room = await fetch(`/api/whiteboard/room/${id}`);
            const request = await fetch(`/api/whiteboard/room/${id}/requests`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ userName: 'Peer' }),
            });
            return { room: room.status, request: request.status };
          }, roomId),
        { timeout: 15000 },
      )
      .toEqual({ room: 403, request: 403 });

    await joinExistingRoom(page2, roomId, 'Peer');
    await expect(page2.getByTestId('whiteboard-canvas-area')).toHaveCount(0);
    await expect(page2.getByRole('heading', { name: /Room is Full/ })).toHaveCount(0);
    await expect(page1.getByTestId('whiteboard-waiting-section')).toHaveCount(0);

    await context1.close();
    await context2.close();
  });

  test('approved non-host cannot approve or moderate another waiting peer', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);
    const context3 = await newAuthenticatedContext(browser);

    const hostPage = await context1.newPage();
    const approvedPeerPage = await context2.newPage();
    const waitingPeerPage = await context3.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'OnlyHost', 2);

    await joinExistingRoom(approvedPeerPage, roomId, 'ApprovedPeer');
    await expectWaiting(approvedPeerPage);
    await approveFirstWaitingPeer(hostPage);
    await expect(approvedPeerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await expectNotWaiting(approvedPeerPage);

    await joinExistingRoom(waitingPeerPage, roomId, 'WaitingPeer');
    await expectWaiting(waitingPeerPage);

    await expect(hostPage.locator('[data-testid="whiteboard-waiting-section"] [data-testid^="whiteboard-user-"]').first()).toBeVisible({
      timeout: 15000,
    });
    await expect(approvedPeerPage.locator('[data-testid^="whiteboard-approve-"]')).toHaveCount(0);
    await expect(approvedPeerPage.locator('[data-testid^="whiteboard-reject-"]')).toHaveCount(0);

    const waitingUserOnPeerPanel = approvedPeerPage.locator('[data-testid^="whiteboard-user-"]').last();
    await waitingUserOnPeerPanel.click({ button: 'right' });
    await expect(approvedPeerPage.getByTestId('whiteboard-context-kick')).toHaveCount(0);
    await expect(approvedPeerPage.getByTestId('whiteboard-context-suspend')).toHaveCount(0);

    await context1.close();
    await context2.close();
    await context3.close();
  });

  test('presence panel collapses and expands from the top toggle', async ({ browser }) => {
    const context = await newAuthenticatedContext(browser);
    const page = await context.newPage();

    await createRoomWithMaxUsers(page, 'CollapseHost', 2);
    await expect(page.getByTestId('whiteboard-presence-panel')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('whiteboard-presence-toggle')).toHaveAttribute('aria-expanded', 'true');

    await page.getByTestId('whiteboard-presence-toggle').click();
    await expect(page.getByTestId('whiteboard-presence-panel')).toHaveCount(0);
    await expect(page.getByTestId('whiteboard-presence-toggle')).toHaveAttribute('aria-expanded', 'false');

    await page.getByTestId('whiteboard-presence-toggle').click();
    await expect(page.getByTestId('whiteboard-presence-panel')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('whiteboard-presence-toggle')).toHaveAttribute('aria-expanded', 'true');

    await context.close();
  });

  test('host can open peer moderation menu with left click', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const hostPage = await context1.newPage();
    const peerPage = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'LeftClickHost', 2);

    await joinExistingRoom(peerPage, roomId, 'LeftClickPeer');
    await expectWaiting(peerPage);
    const peerId = await approveFirstWaitingPeer(hostPage);
    await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await expectNotWaiting(peerPage);

    await hostPage.getByTestId(`whiteboard-user-${peerId}`).click({ position: { x: 12, y: 12 } });
    await expect(hostPage.getByTestId('whiteboard-context-kick')).toBeVisible({ timeout: 10000 });
    await expect(hostPage.getByTestId('whiteboard-context-suspend')).toBeVisible();
    await expect(hostPage.getByTestId('whiteboard-context-let-in')).toHaveCount(0);

    await context1.close();
    await context2.close();
  });

  test('host can open peer moderation menu from the visible options button', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const hostPage = await context1.newPage();
    const peerPage = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'OptionsHost', 2);

    await joinExistingRoom(peerPage, roomId, 'OptionsPeer');
    await expectWaiting(peerPage);
    const peerId = await approveFirstWaitingPeer(hostPage);
    await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await expectNotWaiting(peerPage);

    await hostPage.getByTestId(`whiteboard-user-options-${peerId}`).click();
    await expect(hostPage.getByTestId('whiteboard-context-kick')).toBeVisible({ timeout: 10000 });
    await expect(hostPage.getByTestId('whiteboard-context-suspend')).toBeVisible();

    await context1.close();
    await context2.close();
  });

  test('host only sees moderation actions through the context menu for an approved peer', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const hostPage = await context1.newPage();
    const peerPage = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'InlineKickHost', 2);

    await joinExistingRoom(peerPage, roomId, 'InlineKickPeer');
    await expectWaiting(peerPage);
    const peerId = await approveFirstWaitingPeer(hostPage);
    await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await expectNotWaiting(peerPage);

    await expect(hostPage.getByTestId(`whiteboard-inline-kick-${peerId}`)).toHaveCount(0);
    await expect(hostPage.getByTestId(`whiteboard-inline-wait-${peerId}`)).toHaveCount(0);

    await hostPage.getByTestId(`whiteboard-user-options-${peerId}`).click();
    await expect(hostPage.getByTestId('whiteboard-context-let-in')).toHaveCount(0);
    await expect(hostPage.getByTestId('whiteboard-context-kick')).toBeVisible({ timeout: 10000 });
    await hostPage.getByRole('button', { name: 'Kick from Room' }).click({ force: true });
    await expectNotWaiting(peerPage);
    await expect(peerPage.getByTestId('whiteboard-username-input')).toBeVisible({ timeout: 10000 });

    await context1.close();
    await context2.close();
  });

  test('host only sees let in and reject actions for a waiting peer context menu', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const hostPage = await context1.newPage();
    const peerPage = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'WaitingMenuHost', 2);

    await joinExistingRoom(peerPage, roomId, 'WaitingMenuPeer');
    await expectWaiting(peerPage);
    await openFirstWaitingPeerMenu(hostPage);
    await expect(hostPage.getByTestId('whiteboard-context-let-in')).toBeVisible({ timeout: 10000 });
    await expect(hostPage.getByTestId('whiteboard-context-reject')).toBeVisible();
    await expect(hostPage.getByTestId('whiteboard-context-kick')).toHaveCount(0);
    await expect(hostPage.getByTestId('whiteboard-context-suspend')).toHaveCount(0);

    await context1.close();
    await context2.close();
  });

  test('host can see an approved peer cursor on the whiteboard', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const hostPage = await context1.newPage();
    const peerPage = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'CursorHost', 2);

    await joinExistingRoom(peerPage, roomId, 'CursorPeer');
    await expectWaiting(peerPage);
    const peerId = await approveFirstWaitingPeer(hostPage);
    await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await expectNotWaiting(peerPage);

    const peerCanvasArea = peerPage.getByTestId('whiteboard-canvas-area');
    await expect(peerCanvasArea).toBeVisible();
    const peerBox = await peerCanvasArea.boundingBox();
    expect(peerBox).not.toBeNull();

    await peerPage.mouse.move(peerBox!.x + 240, peerBox!.y + 180);
    await peerPage.mouse.move(peerBox!.x + 250, peerBox!.y + 190);

    const readCollaborator = () => hostPage.evaluate((id) => {
      const collaborators = (window as any).__debugExcalidrawApi?.getAppState?.().collaborators;
      const direct = collaborators?.get?.(id);
      const entries = Array.from(
        (collaborators?.entries?.() ?? []) as Iterable<[string, any]>,
      );
      const entry = direct ?? entries.find(([key, value]) => key === id || value?.id === id)?.[1];
      return entry
        ? {
            username: entry.username,
            pointer: entry.pointer,
            button: entry.button,
          }
        : null;
    }, peerId);

    await expect.poll(readCollaborator, { timeout: 15000 }).toMatchObject({
      username: 'CursorPeer',
      pointer: { tool: 'pointer' },
      button: 'up',
    });
    await expect(hostPage.locator('[data-testid^="whiteboard-peer-cursor-"]')).toHaveCount(0);

    const firstX = (await readCollaborator())?.pointer?.x ?? -1;
    expect(firstX).not.toBe(-1);

    await peerPage.mouse.move(peerBox!.x + 520, peerBox!.y + 300);

    await expect
      .poll(
        async () => (await readCollaborator())?.pointer?.x ?? firstX,
        { timeout: 15000, message: 'the peer cursor did not follow them across the canvas' },
      )
      .toBeGreaterThan(firstX + 100);

    await peerPage.mouse.down();
    await expect.poll(readCollaborator, { timeout: 15000 }).toMatchObject({ button: 'down' });
    await peerPage.mouse.up();
    await expect.poll(readCollaborator, { timeout: 15000 }).toMatchObject({ button: 'up' });

    await context1.close();
    await context2.close();
  });

  test('only host can open library and help containers', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const hostPage = await context1.newPage();
    const peerPage = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'ToolsHost', 2);

    await joinExistingRoom(peerPage, roomId, 'ToolsPeer');
    await expectWaiting(peerPage);
    await approveFirstWaitingPeer(hostPage);
    await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await expectNotWaiting(peerPage);

    /*
     * The room's own host tools live in Excalidraw's footer now, beside its
     * zoom: guiding the class, and clearing the board. This application's
     * library and help buttons went with the tool rail -- Excalidraw carries
     * both, and its library is still the host's alone.
     */
    await expect(hostPage.getByTestId('whiteboard-tool-guide')).toBeVisible();
    await expect(hostPage.getByTestId('whiteboard-clear-btn')).toBeVisible();
    await expect(peerPage.getByTestId('whiteboard-tool-guide')).toHaveCount(0);
    await expect(peerPage.getByTestId('whiteboard-clear-btn')).toHaveCount(0);
    await expect(peerPage.locator('.layer-ui__wrapper__footer-right.zen-mode-transition')).toBeHidden();
    await expect(peerPage.locator('[data-whiteboard-role="peer"] [title="Library"]')).toBeHidden();

    // The shortcuts sheet has no button of its own now; "?" is how it opens.
    await hostPage.keyboard.press('?');
    await expect(hostPage.getByTestId('whiteboard-shortcuts-help')).toBeVisible();
    await hostPage.getByTestId('whiteboard-shortcuts-close').click();
    await expect(hostPage.getByTestId('whiteboard-shortcuts-help')).toHaveCount(0);

    await context1.close();
    await context2.close();
  });
});
