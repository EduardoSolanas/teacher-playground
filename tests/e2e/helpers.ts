import { expect, Page, Browser } from '@playwright/test';
import { cfAuthorizationCookie } from './origins';

// ── URL Helpers ──────────────────────────────────────────────────────────────

function appUrl(path: string) {
  return new URL(path, process.env.PLAYWRIGHT_BASE_URL).toString();
}

async function expectSessionCookie(page: Page) {
  await expect.poll(
    async () => (await page.context().cookies()).find((cookie) => cookie.name === '__Host-teacher-session'),
    { timeout: 25000, message: 'secure local session bootstrap did not set its cookie' },
  ).toMatchObject({
    name: '__Host-teacher-session',
    secure: true,
    httpOnly: true,
    path: '/',
  });
}

// ── Room Creation & Joining ──────────────────────────────────────────────────

function roomIdFromWhiteboardUrl(url: string): string {
  const match = new URL(url).pathname.match(/^\/whiteboard\/([^/]+)$/);
  const roomId = match?.[1] ? decodeURIComponent(match[1]) : '';
  if (!roomId || roomId === 'undefined' || roomId === '_room') {
    throw new Error(`expected a room URL, got ${url}`);
  }
  return roomId;
}

/** 32 lowercase hex — the only room-page form the Worker host allowlist serves. */
function unusedHexRoomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function roomIdFromPageUrl(page: Page): string {
  return roomIdFromWhiteboardUrl(page.url());
}

async function deleteOwnedRoomsFromLanding(page: Page) {
  const items = page.locator('[data-testid^="whiteboard-room-list-item-"]');
  const count = await items.count();
  for (let i = 0; i < count; i += 1) {
    const testId = await items.nth(0).getAttribute('data-testid');
    const roomId = testId?.replace('whiteboard-room-list-item-', '');
    if (!roomId) continue;
    await page.getByTestId(`whiteboard-room-menu-${roomId}`).click();
    await page.getByTestId(`whiteboard-room-delete-${roomId}`).click();
    await page.getByTestId(`whiteboard-room-delete-confirm-${roomId}`).click();
    await expect(page.getByTestId(`whiteboard-room-list-item-${roomId}`)).toHaveCount(0);
  }
}

async function clickCreateRoom(page: Page) {
  const create = page.getByTestId('whiteboard-create-room-btn');
  await expect(create).toBeVisible({ timeout: 20000 });
  if (await create.isDisabled()) {
    await expect(page.getByTestId('whiteboard-room-list-loading')).toHaveCount(0);
    await deleteOwnedRoomsFromLanding(page);
  }
  await expect(create).toBeEnabled({ timeout: 15000 });
  await create.click({ timeout: 15000 });
}

async function createRoomWithMaxUsers(page: Page, name: string, maxUsers: number) {
  await page.goto(appUrl('/whiteboard'));
  await expectSessionCookie(page);
  await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');

  const maxUsersInput = page.locator('input[type="number"]');
  await maxUsersInput.clear();
  await maxUsersInput.fill(String(maxUsers));

  await clickCreateRoom(page);
  await expect(page.getByTestId('whiteboard-username-input')).toBeVisible();
  await page.getByTestId('whiteboard-username-input').fill(name);
  await page.getByTestId('whiteboard-join-room-btn').click();
  await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(/\/whiteboard\/[A-Za-z0-9_-]{8,}(?:\/)?$/);
  return roomIdFromPageUrl(page);
}

/** Explicit contexts do not inherit Playwright `use` headers. */
async function newAuthenticatedContext(browser: Browser, subject?: string) {
  const issuer = process.env.E2E_ACCESS_ISSUER;
  if (!issuer) throw new Error('E2E_ACCESS_ISSUER is missing; use npm run test:e2e');
  const identity = subject ?? `e2e-peer-${crypto.randomUUID()}`;
  const response = await fetch(`${issuer}/token?sub=${encodeURIComponent(identity)}`);
  if (!response.ok) throw new Error(`E2E local Access token failed: ${response.status}`);
  const token = (await response.json()).token;
  return browser.newContext({
    storageState: {
      cookies: [cfAuthorizationCookie(token)],
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

async function waitForExcalidrawApi(page: Page) {
  await expect
    .poll(async () => page.evaluate(() => !!(window as any).__debugExcalidrawApi), { timeout: 15000 })
    .toBe(true);
}

function excalidrawRectangle(id: string, x: number, y: number, version = 1) {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 100,
    height: 50,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 12345 + version,
    version,
    versionNonce: version,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    index: `a${version}`,
  };
}

async function appendElement(page: Page, element: Record<string, unknown>) {
  await waitForExcalidrawApi(page);
  // Excalidraw's API callback applies a remote snapshot ~100ms after mount and
  // ignores onChange while that flag is set. Wait it out so this local scene
  // write actually reaches Yjs and the room POST.
  await page.waitForTimeout(400);
  await page.evaluate((el) => {
    const api = (window as any).__debugExcalidrawApi;
    api.updateScene({
      elements: [...api.getSceneElements(), el],
      captureUpdate: 'IMMEDIATELY',
    });
  }, element);
}
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
  await expect(page.getByRole('heading', { name: /Room is Full/ })).toBeVisible({ timeout: 15000 });
}

async function expectNotWaiting(page: Page) {
  await expect
    .poll(async () => (await getCollabState(page)).isWaiting, { timeout: 10000 })
    .toBe(false);
}

// ── Peer Approval Helpers ────────────────────────────────────────────────────

async function getFirstWaitingPeerId(hostPage: Page) {
  await expandPresenceIfCollapsed(hostPage);
  const waitingUser = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'Waiting' }).first();
  await expect(waitingUser).toBeVisible({ timeout: 15000 });
  const testId = await waitingUser.getAttribute('data-testid');
  const peerId = testId?.replace('whiteboard-user-', '');
  expect(peerId).toBeTruthy();
  return peerId!;
}

async function expandPresenceIfCollapsed(hostPage: Page) {
  const toggle = hostPage.getByTestId('whiteboard-presence-toggle');
  await toggle.waitFor({ state: 'visible', timeout: 15000 });
  const title = await toggle.getAttribute('title');
  if (title?.includes('Expand')) {
    await toggle.click({ force: true });
  }
}

async function approveFirstWaitingPeer(hostPage: Page) {
  await expandPresenceIfCollapsed(hostPage);
  const waitingUser = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'Waiting' }).first();
  await expect(waitingUser).toBeVisible({ timeout: 15000 });
  const testId = await waitingUser.getAttribute('data-testid');
  const peerId = testId?.replace('whiteboard-user-', '');
  expect(peerId).toBeTruthy();
  await waitingUser.getByRole('button', { name: 'Let in' }).click({ force: true });
  return peerId;
}

async function openFirstWaitingPeerMenu(hostPage: Page) {
  await expandPresenceIfCollapsed(hostPage);
  const waitingUser = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'Waiting' }).first();
  await expect(waitingUser).toBeVisible({ timeout: 15000 });
  const testId = await waitingUser.getAttribute('data-testid');
  const peerId = testId?.replace('whiteboard-user-', '');
  expect(peerId).toBeTruthy();
  await waitingUser.getByRole('button', { name: '...' }).click();
  return peerId!;
}

async function moderateApprovedPeer(
  hostPage: Page,
  peerId: string,
  action: 'kick' | 'suspend',
) {
  await expandPresenceIfCollapsed(hostPage);
  await hostPage.getByTestId(`whiteboard-user-options-${peerId}`).click();
  const testId = action === 'kick' ? 'whiteboard-context-kick' : 'whiteboard-context-suspend';
  await expect(hostPage.getByTestId(testId)).toBeVisible({ timeout: 10000 });
  await hostPage.getByTestId(testId).click();
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
  const roomId = roomIdFromWhiteboardUrl(roomUrl);
  await joinRoomApproved(peerPage, hostPage, roomId, peerName);
}

// ── Waiting Room Test Export ─────────────────────────────────────────────────
// These are exported so waiting-room.spec.ts can continue using them unchanged

export {
  appUrl,
  unusedHexRoomId,
  expectSessionCookie,
  clickCreateRoom,
  newAuthenticatedContext,
  createRoomWithMaxUsers,
  roomIdFromPageUrl,
  joinExistingRoom,
  getCollabState,
  expectWaiting,
  expectPersistedElement,
  expectNotWaiting,
  getFirstWaitingPeerId,
  approveFirstWaitingPeer,
  openFirstWaitingPeerMenu,
  moderateApprovedPeer,
  joinRoomApproved,
  joinRoomApprovedViaUrl,
  expandPresenceIfCollapsed,
  waitForExcalidrawApi,
  excalidrawRectangle,
  appendElement,
};
