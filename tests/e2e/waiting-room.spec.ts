import { test, expect, Page } from '@playwright/test';

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

async function joinExistingRoom(page: Page, roomId: string, name = 'Peer') {
  await page.goto(`/whiteboard/${roomId}`);

  const isPromptVisible = await page.getByTestId('whiteboard-username-input').isVisible().catch(() => false);
  if (isPromptVisible) {
    await page.getByTestId('whiteboard-username-input').fill(name);
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
  await expect(page.getByRole('heading', { name: /Room is Full/ })).toBeVisible();
}

async function expectNotWaiting(page: Page) {
  await expect
    .poll(async () => (await getCollabState(page)).isWaiting, { timeout: 10000 })
    .toBe(false);
}

async function getFirstWaitingPeerId(hostPage: Page) {
  const waitingUser = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'Waiting' }).first();
  await expect(waitingUser).toBeVisible({ timeout: 15000 });
  const testId = await waitingUser.getAttribute('data-testid');
  const peerId = testId?.replace('whiteboard-user-', '');
  expect(peerId).toBeTruthy();
  return peerId!;
}

async function openFirstWaitingPeerMenu(hostPage: Page) {
  const waitingUser = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'Waiting' }).first();
  await expect(waitingUser).toBeVisible({ timeout: 15000 });
  const testId = await waitingUser.getAttribute('data-testid');
  const peerId = testId?.replace('whiteboard-user-', '');
  expect(peerId).toBeTruthy();
  await waitingUser.getByRole('button', { name: '...' }).click();
  return peerId!;
}

async function approveFirstWaitingPeer(hostPage: Page) {
  const waitingUser = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'Waiting' }).first();
  await expect(waitingUser).toBeVisible({ timeout: 15000 });
  const testId = await waitingUser.getAttribute('data-testid');
  const peerId = testId?.replace('whiteboard-user-', '');
  expect(peerId).toBeTruthy();
  await waitingUser.getByRole('button', { name: 'Let in' }).click();
  return peerId;
}

test.describe('Waiting Room', () => {
  test('peer always starts in waiting room even when room has spare capacity', async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(page1, 'CapacityHost', 3);

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
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

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

  test('host can reject a waiting peer', async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

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
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

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

  test('host can kick an accepted peer', async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(page1, 'KickHost', 1);

    await joinExistingRoom(page2, roomId);
    await expectWaiting(page2);
    const peerId = await approveFirstWaitingPeer(page1);

    await expect(page2.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

    // Host right-clicks on peer to open context menu
    const userItem = page1.locator(`[data-testid="whiteboard-user-${peerId}"]`);
    await userItem.click({ button: 'right' });
    await page1.waitForTimeout(300);

    await expect(page1.getByTestId('whiteboard-context-kick')).toBeVisible();
    await page1.getByTestId('whiteboard-context-kick').click();

    await expectNotWaiting(page2);
    await expect(page2.getByTestId('whiteboard-username-input')).toBeVisible({ timeout: 10000 });

    // No approve buttons should remain for this peer
    const leftoverApprove = page1.locator(`[data-testid="whiteboard-approve-${peerId}"]`);
    await expect(leftoverApprove).toHaveCount(0);

    await context1.close();
    await context2.close();
  });

  test('host can send an accepted peer back to waiting room', async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(page1, 'SuspendHost', 1);

    await joinExistingRoom(page2, roomId);
    await expectWaiting(page2);
    const peerId = await approveFirstWaitingPeer(page1);

    await expect(page2.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

    // Host right-clicks on peer
    const userItem = page1.locator(`[data-testid="whiteboard-user-${peerId}"]`);
    await userItem.click({ button: 'right' });
    await page1.waitForTimeout(300);

    await expect(page1.getByTestId('whiteboard-context-suspend')).toBeVisible();
    await page1.getByTestId('whiteboard-context-suspend').click();

    await expectWaiting(page2);

    await expect(page1.getByTestId(`whiteboard-user-${peerId}`)).toContainText('Waiting', { timeout: 10000 });
    await expect(page1.getByTestId(`whiteboard-user-options-${peerId}`)).toBeVisible();

    await context1.close();
    await context2.close();
  });

  test('host can approve, kick, and re-approve a peer', async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(page1, 'CycleHost', 1);

    await joinExistingRoom(page2, roomId);
    await expectWaiting(page2);
    const peerId = await approveFirstWaitingPeer(page1);
    await expect(page2.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

    // Kick
    const userItem = page1.locator(`[data-testid="whiteboard-user-${peerId}"]`);
    await userItem.click({ button: 'right' });
    await page1.waitForTimeout(300);
    await page1.getByTestId('whiteboard-context-kick').click();

    await expectNotWaiting(page2);

    // Peer joins again -> waiting room
    await page2.goto(`/whiteboard/${roomId}`);
    const isPrompt = await page2.getByTestId('whiteboard-username-input').isVisible().catch(() => false);
    if (isPrompt) {
      await page2.getByTestId('whiteboard-username-input').fill('Peer');
      await page2.getByTestId('whiteboard-join-room-btn').click();
    }

    await expectWaiting(page2);

    await approveFirstWaitingPeer(page1);
    await expect(page2.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

    await expectNotWaiting(page2);

    await context1.close();
    await context2.close();
  });

  test('approved non-host cannot approve or moderate another waiting peer', async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    const context3 = await browser.newContext();

    const hostPage = await context1.newPage();
    const approvedPeerPage = await context2.newPage();
    const waitingPeerPage = await context3.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'OnlyHost', 3);

    await joinExistingRoom(approvedPeerPage, roomId, 'ApprovedPeer');
    await expectWaiting(approvedPeerPage);
    await approveFirstWaitingPeer(hostPage);
    await expect(approvedPeerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await expectNotWaiting(approvedPeerPage);

    await joinExistingRoom(waitingPeerPage, roomId, 'WaitingPeer');
    await expectWaiting(waitingPeerPage);

    await expect(hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'Waiting' }).first()).toBeVisible({
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
    const context = await browser.newContext();
    const page = await context.newPage();

    await createRoomWithMaxUsers(page, 'CollapseHost', 3);
    await expect(page.getByText(/users online/)).toBeVisible({ timeout: 15000 });

    await page.getByTestId('whiteboard-presence-toggle').click();
    await expect(page.getByText(/users online/)).toHaveCount(0);
    await expect(page.getByTestId('whiteboard-presence-toggle')).toHaveText('>');

    await page.getByTestId('whiteboard-presence-toggle').click();
    await expect(page.getByText(/users online/)).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('whiteboard-presence-toggle')).toHaveText('<');

    await context.close();
  });

  test('host can open peer moderation menu with left click', async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const hostPage = await context1.newPage();
    const peerPage = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'LeftClickHost', 3);

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
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const hostPage = await context1.newPage();
    const peerPage = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'OptionsHost', 3);

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
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const hostPage = await context1.newPage();
    const peerPage = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'InlineKickHost', 3);

    await joinExistingRoom(peerPage, roomId, 'InlineKickPeer');
    await expectWaiting(peerPage);
    const peerId = await approveFirstWaitingPeer(hostPage);
    await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await expectNotWaiting(peerPage);

    await expect(hostPage.getByTestId(`whiteboard-inline-kick-${peerId}`)).toHaveCount(0);
    await expect(hostPage.getByTestId(`whiteboard-inline-wait-${peerId}`)).toHaveCount(0);

    await hostPage.getByTestId(`whiteboard-user-${peerId}`).click({ position: { x: 12, y: 12 } });
    await expect(hostPage.getByTestId('whiteboard-context-let-in')).toHaveCount(0);
    await expect(hostPage.getByTestId('whiteboard-context-kick')).toBeVisible({ timeout: 10000 });
    await hostPage.getByTestId('whiteboard-context-kick').click();
    await expectNotWaiting(peerPage);
    await expect(peerPage.getByTestId('whiteboard-username-input')).toBeVisible({ timeout: 10000 });

    await context1.close();
    await context2.close();
  });

  test('host only sees let in and reject actions for a waiting peer context menu', async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const hostPage = await context1.newPage();
    const peerPage = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'WaitingMenuHost', 3);

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
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const hostPage = await context1.newPage();
    const peerPage = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'CursorHost', 3);

    await joinExistingRoom(peerPage, roomId, 'CursorPeer');
    await expectWaiting(peerPage);
    const peerId = await approveFirstWaitingPeer(hostPage);
    await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await expectNotWaiting(peerPage);

    const peerCanvasArea = peerPage.getByTestId('whiteboard-canvas-area');
    const peerBox = await peerCanvasArea.boundingBox();
    expect(peerBox).not.toBeNull();

    await peerPage.mouse.move(peerBox!.x + 240, peerBox!.y + 180);

    const peerCursor = hostPage.getByTestId(`whiteboard-peer-cursor-${peerId}`);
    await expect(peerCursor).toBeVisible({ timeout: 15000 });
    await expect(peerCursor).toContainText('CursorPeer');

    const peerPenTool = peerPage.getByTestId('whiteboard-tool-pen');
    const toolBox = await peerPenTool.boundingBox();
    expect(toolBox).not.toBeNull();
    await peerPage.mouse.move(toolBox!.x + toolBox!.width / 2, toolBox!.y + toolBox!.height / 2);

    await expect
      .poll(
        async () => {
          const box = await peerCursor.boundingBox();
          return box?.x ?? Number.POSITIVE_INFINITY;
        },
        { timeout: 15000 },
      )
      .toBeLessThan(80);

    await context1.close();
    await context2.close();
  });

  test('only host can open library and help containers', async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const hostPage = await context1.newPage();
    const peerPage = await context2.newPage();

    const roomId = await createRoomWithMaxUsers(hostPage, 'ToolsHost', 3);

    await joinExistingRoom(peerPage, roomId, 'ToolsPeer');
    await expectWaiting(peerPage);
    await approveFirstWaitingPeer(hostPage);
    await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await expectNotWaiting(peerPage);

    await expect(hostPage.getByTestId('whiteboard-tool-library')).toBeVisible();
    await expect(hostPage.getByTestId('whiteboard-tool-help')).toBeVisible();
    await expect(peerPage.getByTestId('whiteboard-tool-library')).toHaveCount(0);
    await expect(peerPage.getByTestId('whiteboard-tool-help')).toHaveCount(0);
    await expect(peerPage.locator('.layer-ui__wrapper__footer-right.zen-mode-transition')).toBeHidden();
    await expect(peerPage.locator('[data-whiteboard-role="peer"] [title="Library"]')).toBeHidden();

    await hostPage.getByTestId('whiteboard-tool-library').click();
    await expect(hostPage.getByTestId('whiteboard-library-panel')).toBeVisible();
    await hostPage.getByTestId('whiteboard-library-close').click();
    await expect(hostPage.getByTestId('whiteboard-library-panel')).toHaveCount(0);

    await hostPage.getByTestId('whiteboard-tool-help').click();
    await expect(hostPage.getByTestId('whiteboard-shortcuts-help')).toBeVisible();
    await hostPage.getByTestId('whiteboard-shortcuts-close').click();
    await expect(hostPage.getByTestId('whiteboard-shortcuts-help')).toHaveCount(0);

    await context1.close();
    await context2.close();
  });
});
