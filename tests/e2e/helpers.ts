import { test, expect, Page, Browser } from '@playwright/test';

// ── URL Helpers ──────────────────────────────────────────────────────────────

function appUrl(path: string) {
  return new URL(path, process.env.PLAYWRIGHT_BASE_URL).toString();
}

async function expectSessionCookie(page: Page) {
  await expect.poll(
    async () => (await page.context().cookies()).find((cookie) => cookie.name === '__Host-teacher-session'),
    { timeout: 15000, message: 'secure local session bootstrap did not set its cookie' },
  ).toMatchObject({
    name: '__Host-teacher-session',
    secure: true,
    httpOnly: true,
    path: '/',
  });
}

// ── Room Creation & Joining ──────────────────────────────────────────────────

async function createRoomWithMaxUsers(page: Page, name: string, maxUsers: number) {
  await page.goto(appUrl('/whiteboard'));
  await expectSessionCookie(page);
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

let contextSubject = 0;

/** Explicit contexts do not inherit Playwright `use` headers. */
async function newAuthenticatedContext(browser: Browser, subject?: string) {
  const issuer = process.env.E2E_ACCESS_ISSUER;
  if (!issuer) throw new Error('E2E_ACCESS_ISSUER is missing; use npm run test:e2e');
  const identity = subject ?? `e2e-peer-${contextSubject++}`;
  const response = await fetch(`${issuer}/token?sub=${encodeURIComponent(identity)}`);
  if (!response.ok) throw new Error(`E2E local Access token failed: ${response.status}`);
  const token = (await response.json()).token;
  return browser.newContext({
    storageState: {
      cookies: [{
        name: 'CF_Authorization',
        value: token,
        domain: 'localhost',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3_600,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      }],
      origins: [],
    },
  });
}

async function joinExistingRoom(page: Page, roomId: string, name = 'Peer') {
  await page.goto(`/whiteboard/${roomId}`);
  await expectSessionCookie(page);

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

/** Waits until the room API actually holds `elementId`, past the save debounce. */
async function expectPersistedElement(page: Page, roomId: string, elementId: string) {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(appUrl(`/api/whiteboard/room/${roomId}`));
        if (!response.ok()) return [];
        const body = await response.json();
        return (body.elements ?? []).map((element: { id: string }) => element.id);
      },
      { timeout: 20000, message: 'room state was never persisted' },
    )
    .toContain(elementId);
}

// ── Waiting Room State Helpers ───────────────────────────────────────────────

async function getCollabState(page: Page) {
  // Requires debug globals: development, NEXT_PUBLIC_WHITEBOARD_DEBUG=1, or NEXT_PUBLIC_E2E=1.
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
  expectSessionCookie,
  newAuthenticatedContext,
  createRoomWithMaxUsers,
  joinExistingRoom,
  getCollabState,
  expectWaiting,
  expectPersistedElement,
  expectNotWaiting,
  getFirstWaitingPeerId,
  approveFirstWaitingPeer,
  openFirstWaitingPeerMenu,
  joinRoomApproved,
  joinRoomApprovedViaUrl,
};
