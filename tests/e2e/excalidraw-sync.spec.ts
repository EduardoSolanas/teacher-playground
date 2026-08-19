import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import {
  createRoomWithMaxUsers,
  joinExistingRoom,
  expectWaiting,
  approveFirstWaitingPeer,
  newAuthenticatedContext,
  expectPersistedElement,
  appendElement,
} from './helpers';

async function installWebRtcSentinel(page: Page) {
  await page.addInitScript(() => {
    (window as any).__e2ePeerConnectionCount = 0;
    const Original = window.RTCPeerConnection;
    if (!Original) return;
    (window as any).RTCPeerConnection = function (...args: ConstructorParameters<typeof RTCPeerConnection>) {
      (window as any).__e2ePeerConnectionCount += 1;
      return new Original(...args);
    };
    Object.assign((window as any).RTCPeerConnection, Original);
    (window as any).RTCPeerConnection.prototype = Original.prototype;
  });
}

function trackWebsocketUrls(page: Page) {
  const urls: string[] = [];
  page.on('websocket', (ws) => urls.push(ws.url()));
  return urls;
}

async function expectYWebsocketTransport(page: Page, websocketUrls: string[]) {
  const collab = await page.evaluate(() => {
    const provider = (window as any).__whiteboardCollab?.provider;
    return {
      providerName: provider?.constructor?.name ?? null,
      peerConnectionCount: (window as any).__e2ePeerConnectionCount ?? 0,
    };
  });

  expect(websocketUrls.some((url) => url.includes('/signaling'))).toBe(true);
  expect(websocketUrls.some((url) => /stun:|turn:/i.test(url))).toBe(false);
  expect(collab.providerName).not.toBe('WebrtcProvider');
  expect(collab.peerConnectionCount).toBe(0);
}

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

test.describe('Excalidraw scene sync', () => {
  test('exposes the Excalidraw api once the board is open', async ({ page }) => {
    await createRoomWithMaxUsers(page, 'ApiHost', 2);

    await expect
      .poll(async () => page.evaluate(() => !!(window as any).__debugExcalidrawApi), { timeout: 15000 })
      .toBe(true);

    expect(await sceneElementIds(page)).toEqual([]);
  });

  test('an element added by the host reaches an approved peer', async ({ page, browser }) => {
    await installWebRtcSentinel(page);
    const hostSockets = trackWebsocketUrls(page);

    const roomId = await createRoomWithMaxUsers(page, 'SyncHost', 2);

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    await installWebRtcSentinel(peerPage);
    const peerSockets = trackWebsocketUrls(peerPage);
    try {
      await joinExistingRoom(peerPage, roomId, 'SyncPeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await expect
        .poll(async () => (await page.evaluate(() => (window as any).__whiteboardCollab?.isSynced)), { timeout: 20000 })
        .toBe(true);
      await expect
        .poll(async () => (await peerPage.evaluate(() => (window as any).__whiteboardCollab?.isConnected)), { timeout: 20000 })
        .toBe(true);
      await expect
        .poll(() => hostSockets.some((url) => url.includes('/signaling')), { timeout: 20000 })
        .toBe(true);
      await expect
        .poll(() => peerSockets.some((url) => url.includes('/signaling')), { timeout: 20000 })
        .toBe(true);
      await expectYWebsocketTransport(page, hostSockets);
      await expectYWebsocketTransport(peerPage, peerSockets);

      await appendElement(page, rectangle('sync-rect-1', 200, 150));

      await expect
        .poll(async () => sceneElementIds(peerPage), { timeout: 20000 })
        .toContain('sync-rect-1');
    } finally {
      await peerContext.close();
    }
  });

  // Late joiners catch up from the room API after persist (expectPersistedElement),
  // not from Yjs history replay on the signaling socket.
  test('a peer sees elements that already existed before it was approved', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'BacklogHost', 2);

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
    const roomId = await createRoomWithMaxUsers(page, 'GateHost', 2);

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
