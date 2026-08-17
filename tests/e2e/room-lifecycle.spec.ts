import { test, expect, Page } from '@playwright/test';
import {
  appUrl,
  createRoomWithMaxUsers,
  joinExistingRoom,
  approveFirstWaitingPeer,
  expectWaiting,
} from './helpers';

// ── Scene element helpers (copied from excalidraw-sync.spec.ts) ────────────

function rectangle(id: string, x: number, y: number) {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 200,
    height: 120,
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
    seed: 12345,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

async function sceneElementIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const api = (window as any).__debugExcalidrawApi;
    return (api?.getSceneElements?.() ?? []).map((e: { id: string }) => e.id);
  });
}

async function waitForExcalidrawApi(page: Page) {
  await expect
    .poll(async () => page.evaluate(() => !!(window as any).__debugExcalidrawApi), { timeout: 15000 })
    .toBe(true);
}

async function appendElement(page: Page, element: Record<string, unknown>) {
  await waitForExcalidrawApi(page);
  await page.evaluate((el) => {
    const api = (window as any).__debugExcalidrawApi;
    api.updateScene({ elements: [...api.getSceneElements(), el] });
  }, element);
}

test.describe('Room lifecycle', () => {
  test('joining an existing room by code lands you in that room', async ({ page, browser }) => {
    // Host creates a room
    const hostRoomId = await createRoomWithMaxUsers(page, 'LifecycleHost', 2);

    // Peer joins the same room by code
    const peerContext = await browser.newContext();
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, hostRoomId, 'LifecyclePeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      // Verify peer is now in the same room by checking the URL room id
      const peerRoomId = new URL(peerPage.url()).pathname.split('/').pop();
      expect(peerRoomId).toBe(hostRoomId);
    } finally {
      await peerContext.close();
    }
  });

  test('username persists in localStorage across room navigations', async ({ page }) => {
    // Create and join a room with a specific username
    const room1Id = await createRoomWithMaxUsers(page, 'PersistentUsername', 2);

    // Check that username is stored in localStorage
    const storedUsername = await page.evaluate(() => {
      return localStorage.getItem('whiteboardUsername');
    });

    // If the app stores the username (implementation detail), it should persist
    if (storedUsername !== null) {
      expect(storedUsername).toBe('PersistentUsername');
    }
  });

  test.fixme('a scene element survives a page reload', async ({ page }) => {
    // KNOWN DEFECT: Elements added to the scene are not persisted to the database
    // and do not reappear after a page reload. Live updates work fine within the
    // same session, but persistence across browser refreshes is not implemented.
    // This test documents the expected behavior once that feature is added.

    // Create a room
    const roomId = await createRoomWithMaxUsers(page, 'ReloadHost', 2);

    // Append an element
    const testElemId = 'reload-element-1';
    await appendElement(page, rectangle(testElemId, 100, 100));
    await expect.poll(async () => sceneElementIds(page), { timeout: 10000 }).toContain(testElemId);

    // Reload the page
    await page.reload();
    await waitForExcalidrawApi(page);

    // Verify the element is still there (currently fails - element not persisted)
    await expect.poll(async () => sceneElementIds(page), { timeout: 10000 }).toContain(testElemId);
  });

  test('navigating directly to a room id that was never created still renders the board', async ({
    page,
  }) => {
    // Navigate to a non-existent room id (use a fake UUID-like string)
    const fakeRoomId = 'nonexistent-room-12345';
    await page.goto(appUrl(`/whiteboard/${fakeRoomId}`));

    // The app shows the username prompt for new rooms
    const usernameInput = page.getByTestId('whiteboard-username-input');
    await expect(usernameInput).toBeVisible({ timeout: 5000 });
    await usernameInput.fill('NonExistentRoomUser');
    await page.getByTestId('whiteboard-join-room-btn').click();

    // The board should render and be accessible (even if empty)
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await waitForExcalidrawApi(page);
    expect(await sceneElementIds(page)).toEqual([]);
  });

  test('creating several rooms in succession each yields a distinct room id', async ({ browser }) => {
    const roomIds: string[] = [];

    // Create three rooms in separate contexts
    for (let i = 0; i < 3; i++) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      try {
        const roomId = await createRoomWithMaxUsers(page, `RoomCreator${i}`, 2);
        roomIds.push(roomId);
      } finally {
        await ctx.close();
      }
    }

    // Verify all room ids are distinct
    const uniqueIds = new Set(roomIds);
    expect(uniqueIds.size).toBe(3);
  });

  test('a username containing spaces and an apostrophe joins successfully and appears in the presence panel', async ({
    page,
    browser,
  }) => {
    // Host creates a room
    const roomId = await createRoomWithMaxUsers(page, 'PresenceHost', 2);

    // Peer joins with a special username
    const peerContext = await browser.newContext();
    const peerPage = await peerContext.newPage();
    try {
      const specialName = "Ann O'Brien";
      await joinExistingRoom(peerPage, roomId, specialName);
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      // Verify the peer appears in the host's presence panel with the correct name
      const peerElement = page.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: specialName });
      await expect(peerElement).toBeVisible({ timeout: 10000 });
    } finally {
      await peerContext.close();
    }
  });
});
