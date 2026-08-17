import { test, expect, Page } from '@playwright/test';
import {
  createRoomWithMaxUsers,
  joinExistingRoom,
  expectWaiting,
  approveFirstWaitingPeer,
  newAuthenticatedContext,
  expectPersistedElement,
} from './helpers';

// These tests exercise the app as it is actually built today: the board is an
// Excalidraw scene reached through window.__debugExcalidrawApi, and every
// non-host peer is admitted only after the host approves it.

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

test.describe('Excalidraw scene sync', () => {
  test('exposes the Excalidraw api once the board is open', async ({ page }) => {
    await createRoomWithMaxUsers(page, 'ApiHost', 3);

    await expect
      .poll(async () => page.evaluate(() => !!(window as any).__debugExcalidrawApi), { timeout: 15000 })
      .toBe(true);

    expect(await sceneElementIds(page)).toEqual([]);
  });

  test('an element added by the host reaches an approved peer', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'SyncHost', 3);

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'SyncPeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await appendElement(page, rectangle('sync-rect-1', 200, 150));

      await expect
        .poll(async () => sceneElementIds(peerPage), { timeout: 20000 })
        .toContain('sync-rect-1');
    } finally {
      await peerContext.close();
    }
  });

  // KNOWN DEFECT: a peer approved after the board already has content receives an
  // empty scene — it gets live updates from that point on, but no history. The
  // 'disconnected peer catches up from API fallback' case in collaboration.spec.ts
  // fails for what looks like the same reason. Unfixed; this test documents it.
  test('a peer sees elements that already existed before it was approved', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'BacklogHost', 3);

    await appendElement(page, rectangle('backlog-rect-1', 120, 120));
    await expect.poll(async () => sceneElementIds(page), { timeout: 10000 }).toContain('backlog-rect-1');

    // The peer loads the board from the room API, and that save is debounced,
    // so let it land before the peer joins.
    await expectPersistedElement(page, roomId, 'backlog-rect-1');

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'BacklogPeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await expect
        .poll(async () => sceneElementIds(peerPage), { timeout: 20000 })
        .toContain('backlog-rect-1');
    } finally {
      await peerContext.close();
    }
  });

  test('an unapproved peer waits and sees no board', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'GateHost', 3);

    await appendElement(page, rectangle('gated-rect-1', 90, 90));

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'GatePeer');
      await expectWaiting(peerPage);

      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toHaveCount(0);
      expect(await sceneElementIds(peerPage)).toEqual([]);
    } finally {
      await peerContext.close();
    }
  });
});
