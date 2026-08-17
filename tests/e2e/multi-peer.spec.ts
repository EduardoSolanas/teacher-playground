import { test, expect, Page } from '@playwright/test';
import {
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

test.describe('Multi-peer collaboration', () => {
  test('an element appended by the approved peer appears on the host', async ({ page, browser }) => {
    // Host creates a room
    const roomId = await createRoomWithMaxUsers(page, 'MultiHost', 2);

    // Peer joins and gets approved
    const peerContext = await browser.newContext();
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'MultiPeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      // Peer appends an element
      const peerElemId = 'peer-appended-rect-1';
      await appendElement(peerPage, rectangle(peerElemId, 150, 150));

      // Host should see the element
      await expect.poll(async () => sceneElementIds(page), { timeout: 20000 }).toContain(peerElemId);
    } finally {
      await peerContext.close();
    }
  });

  test('both peers append an element at the same time and each ends up with both ids present', async ({
    page,
    browser,
  }) => {
    // Host creates a room
    const roomId = await createRoomWithMaxUsers(page, 'ConcurrentHost', 2);

    // Peer joins and gets approved
    const peerContext = await browser.newContext();
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'ConcurrentPeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      // Both peers append elements concurrently
      const hostElemId = 'concurrent-host-rect-1';
      const peerElemId = 'concurrent-peer-rect-1';

      // Start both operations without awaiting
      const hostAppend = appendElement(page, rectangle(hostElemId, 100, 100));
      const peerAppend = appendElement(peerPage, rectangle(peerElemId, 200, 200));

      // Wait for both to complete
      await Promise.all([hostAppend, peerAppend]);

      // Both should have both element ids
      await expect.poll(async () => sceneElementIds(page), { timeout: 20000 }).toContain(hostElemId);
      await expect.poll(async () => sceneElementIds(page), { timeout: 20000 }).toContain(peerElemId);

      await expect.poll(async () => sceneElementIds(peerPage), { timeout: 20000 }).toContain(hostElemId);
      await expect.poll(async () => sceneElementIds(peerPage), { timeout: 20000 }).toContain(peerElemId);
    } finally {
      await peerContext.close();
    }
  });

  // KNOWN DEFECT: the clear-board button does not empty the Excalidraw scene. Observed on
  // the HOST's own page: after clear + confirm, getSceneElements() still contains the
  // element. Note that ui-controls.spec.ts has a passing 'clear board removes all elements
  // from the store' test — it asserts on the orphaned window.__whiteboardStore, so it
  // clears the dead store and reports success while the real scene is untouched.
  test.fixme('clearing the board on the host empties the peers scene too', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'ClearHost', 2);
    const clearTestElemId = 'clear-test-rect-1';

    // The peer is approved BEFORE any content exists, so this exercises clear-board
    // propagation rather than the known late-joiner history defect.
    const peerContext = await browser.newContext();
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'ClearPeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await appendElement(page, rectangle(clearTestElemId, 100, 100));
      await expect.poll(async () => sceneElementIds(page), { timeout: 10000 }).toContain(clearTestElemId);
      await expect.poll(async () => sceneElementIds(peerPage), { timeout: 20000 }).toContain(clearTestElemId);

      // Host clears the board using the UI
      await page.getByTestId('whiteboard-clear-btn').click();
      await expect(page.getByTestId('whiteboard-clear-confirm-btn')).toBeVisible({ timeout: 5000 });
      await page.getByTestId('whiteboard-clear-confirm-btn').click();

      // Both should now have empty scenes
      await expect.poll(async () => sceneElementIds(page), { timeout: 10000 }).toEqual([]);
      await expect.poll(async () => sceneElementIds(peerPage), { timeout: 20000 }).toEqual([]);
    } finally {
      await peerContext.close();
    }
  });

  test('when the peer context closes, the host presence panel stops listing that peer', async ({
    page,
    browser,
  }) => {
    // Host creates a room
    const roomId = await createRoomWithMaxUsers(page, 'DisconnectHost', 2);

    // Peer joins and gets approved
    const peerContext = await browser.newContext();
    const peerPage = await peerContext.newPage();

    await joinExistingRoom(peerPage, roomId, 'DisconnectPeer');
    await expectWaiting(peerPage);
    await approveFirstWaitingPeer(page);
    await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

    // Verify peer appears in the host's presence panel
    const peerElement = page.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'DisconnectPeer' });
    await expect(peerElement).toBeVisible({ timeout: 10000 });

    // Close the peer context
    await peerContext.close();

    // Verify the peer is no longer in the host's presence panel
    await expect(peerElement).toHaveCount(0, { timeout: 15000 });
  });

  test('both peers show each other in the presence panel after approval', async ({ page, browser }) => {
    // Host creates a room
    const roomId = await createRoomWithMaxUsers(page, 'PresenceHost', 2);

    // Peer joins and gets approved
    const peerContext = await browser.newContext();
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'PresencePeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      // Host should see the peer in the presence panel
      const hostSeePeer = page.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'PresencePeer' });
      await expect(hostSeePeer).toBeVisible({ timeout: 10000 });

      // Peer should see the host in the presence panel
      const peerSeeHost = peerPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'PresenceHost' });
      await expect(peerSeeHost).toBeVisible({ timeout: 10000 });
    } finally {
      await peerContext.close();
    }
  });
});
