import { test, expect, Page, Browser } from '@playwright/test';

// ── URL Helpers ──────────────────────────────────────────────────────────────

function appUrl(path: string) {
  return new URL(path, process.env.PLAYWRIGHT_BASE_URL).toString();
}

// ── Room Creation & Joining ──────────────────────────────────────────────────

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

// ── Waiting Room State Helpers ───────────────────────────────────────────────

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

// ── Peer Approval Helpers ────────────────────────────────────────────────────

async function getFirstWaitingPeerId(hostPage: Page) {
  const waitingUser = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'Waiting' }).first();
  await expect(waitingUser).toBeVisible({ timeout: 15000 });
  const testId = await waitingUser.getAttribute('data-testid');
  const peerId = testId?.replace('whiteboard-user-', '');
  expect(peerId).toBeTruthy();
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

async function openFirstWaitingPeerMenu(hostPage: Page) {
  const waitingUser = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'Waiting' }).first();
  await expect(waitingUser).toBeVisible({ timeout: 15000 });
  const testId = await waitingUser.getAttribute('data-testid');
  const peerId = testId?.replace('whiteboard-user-', '');
  expect(peerId).toBeTruthy();
  await waitingUser.getByRole('button', { name: '...' }).click();
  return peerId!;
}

// ── Combined Approval Flow ───────────────────────────────────────────────────

/**
 * Join a room as a peer and wait for the host to approve the join.
 * Asserts that whiteboard-canvas-area becomes visible after approval.
 */
async function joinRoomApproved(peerPage: Page, hostPage: Page, roomId: string, peerName: string) {
  await joinExistingRoom(peerPage, roomId, peerName);
  await expectWaiting(peerPage);
  await approveFirstWaitingPeer(hostPage);
  await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
  await expectNotWaiting(peerPage);
}

/**
 * Join an existing room from a URL and wait for host approval.
 * Similar to joinRoomApproved but takes a full URL instead of roomId.
 */
async function joinRoomApprovedViaUrl(peerPage: Page, hostPage: Page, roomUrl: string, peerName: string) {
  const roomId = new URL(roomUrl).pathname.split('/').pop()!;
  await joinRoomApproved(peerPage, hostPage, roomId, peerName);
}

// ── Waiting Room Test Export ─────────────────────────────────────────────────
// These are exported so waiting-room.spec.ts can continue using them unchanged

export {
  appUrl,
  createRoomWithMaxUsers,
  joinExistingRoom,
  getCollabState,
  expectWaiting,
  expectNotWaiting,
  getFirstWaitingPeerId,
  approveFirstWaitingPeer,
  openFirstWaitingPeerMenu,
  joinRoomApproved,
  joinRoomApprovedViaUrl,
};
