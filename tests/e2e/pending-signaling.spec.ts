import { test, expect, Page } from '@playwright/test';
import {
  createRoomWithMaxUsers,
  joinExistingRoom,
  expectWaiting,
  expectNotWaiting,
  approveFirstWaitingPeer,
  newAuthenticatedContext,
  expectPersistedElement,
} from './helpers';

function trackWebsocketUrls(page: Page) {
  const urls: string[] = [];
  page.on('websocket', (ws) => urls.push(ws.url()));
  return urls;
}

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

test.describe('Pending peer signaling gate', () => {
  test('waiting peer does not open /signaling and has no canvas', async ({ browser }) => {
    const hostContext = await newAuthenticatedContext(browser);
    const peerContext = await newAuthenticatedContext(browser);

    const hostPage = await hostContext.newPage();
    const peerPage = await peerContext.newPage();

    const hostSockets = trackWebsocketUrls(hostPage);
    const peerSockets = trackWebsocketUrls(peerPage);

    try {
      const roomId = await createRoomWithMaxUsers(hostPage, 'SignalingGateHost', 1);

      await joinExistingRoom(peerPage, roomId, 'SignalingGatePeer');
      await expectWaiting(peerPage);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toHaveCount(0);

      await expect
        .poll(() => peerSockets.filter((url) => url.includes('/signaling')), {
          timeout: 5000,
          message: 'waiting peer must not open /signaling',
        })
        .toHaveLength(0);

      await appendElement(hostPage, rectangle('gate-secret-rect', 100, 100));
      await expectPersistedElement(hostPage, roomId, 'gate-secret-rect');

      await expect
        .poll(
          async () =>
            peerPage.evaluate(async (id) => {
              const response = await fetch(`/api/whiteboard/room/${id}`);
              return response.status;
            }, roomId),
          { timeout: 10000, message: 'waiting peer must not read room bytes' },
        )
        .toBe(403);

      expect(hostSockets.some((url) => url.includes('/signaling'))).toBe(true);

      await approveFirstWaitingPeer(hostPage);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await expectNotWaiting(peerPage);

      await expect
        .poll(() => peerSockets.some((url) => url.includes('/signaling')), {
          timeout: 20000,
          message: 'approved peer should open /signaling',
        })
        .toBe(true);
    } finally {
      await hostContext.close();
      await peerContext.close();
    }
  });
});
