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
  waitForExcalidrawApi,
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

function rectangle(
  id: string,
  x: number,
  y: number,
  version = 1,
  index = 'a0',
  versionNonce = version,
) {
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
    version,
    versionNonce,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    index,
  };
}

async function sceneElementIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const api = (window as any).__debugExcalidrawApi;
    return (api?.getSceneElements?.() ?? [])
      .map((e: { id: string }) => e.id)
      .sort();
  });
}

async function sharedElementIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const elements = (window as any).__whiteboardCollab?.provider?.doc?.getArray('elements');
    return (elements?.toArray?.() ?? [])
      .map((element: any) => element.get('id'))
      .sort();
  });
}

/**
 * What the shared document says is actually on the board.
 *
 * Excalidraw deletes by marking `isDeleted` rather than by removing, so an
 * undone element stays in the array as a tombstone -- the server prunes those
 * separately. `sharedElementIds` counts them, which is right for asking what
 * the array holds and wrong for asking what anybody can see.
 */
async function liveSharedElementIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const elements = (window as any).__whiteboardCollab?.provider?.doc?.getArray('elements');
    return (elements?.toArray?.() ?? [])
      .filter((element: any) => element.get('isDeleted') !== true)
      .map((element: any) => element.get('id'))
      .sort();
  });
}

async function replaceElement(page: Page, element: Record<string, unknown>) {
  await waitForExcalidrawApi(page);
  await page.evaluate((nextElement) => {
    const api = (window as any).__debugExcalidrawApi;
    const elements = api.getSceneElements?.() ?? [];
    api.updateScene({
      elements: elements.map((current: any) => current.id === nextElement.id ? nextElement : current),
      captureUpdate: 'IMMEDIATELY',
    });
  }, element);
}

async function replaceSharedElement(page: Page, element: Record<string, unknown>) {
  await page.evaluate((nextElement) => {
    const provider = (window as any).__whiteboardCollab?.provider;
    const elements = provider?.doc?.getArray('elements');
    const current = elements?.toArray?.().find((candidate: any) => candidate.get('id') === nextElement.id);
    if (!provider?.doc || !current) throw new Error('shared element was not found');
    provider.doc.transact(() => {
      for (const [key, value] of Object.entries(nextElement)) current.set(key, value);
    });
  }, element);
}

async function sharedElement(page: Page, id: string) {
  return page.evaluate((elementId) => {
    const elements = (window as any).__whiteboardCollab?.provider?.doc?.getArray('elements');
    const element = elements?.toArray?.().find((candidate: any) => candidate.get('id') === elementId);
    return { x: element?.get('x'), version: element?.get('version'), versionNonce: element?.get('versionNonce') };
  }, id);
}

test.describe('Excalidraw scene sync', () => {
  test('exposes the Excalidraw api once the board is open', async ({ page }) => {
    await createRoomWithMaxUsers(page, 'ApiHost', 2);

    await expect
      .poll(async () => page.evaluate(() => !!(window as any).__debugExcalidrawApi), { timeout: 15000 })
      .toBe(true);

    expect(await sceneElementIds(page)).toEqual([]);
  });


  test('the host can take the board away and a peer cannot', async ({ page, browser }) => {
    /*
     * The only way a lesson leaves this application. Platform point-in-time
     * recovery is the whole of the backup story, so a room that is deleted
     * takes the work on it with it unless somebody saved a copy first.
     *
     * Owner only, and that is the half worth guarding: a board is usually a
     * child's work, and a guest admitted for one lesson should not be able to
     * walk off with a copy of everything anyone has drawn on it.
     *
     * It moved out of Excalidraw's menu into the room's title menu when that
     * menu was removed, so this asks the room rather than the editor. The
     * property is the same one, and `UIOptions.canvasActions.export` still
     * gates the editor's own path behind the same check.
     */
    const roomId = await createRoomWithMaxUsers(page, 'ExportHost', 2);
    await page.getByTestId('room-title-trigger').click();
    await expect(page.getByTestId('room-menu-save')).toBeVisible();
    await page.keyboard.press('Escape');

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'ExportPeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      // No menu at all rather than a menu that refuses: the trigger is the
      // owner's, and with it goes the only way to take a copy away.
      await expect(peerPage.getByTestId('room-title-trigger')).toHaveCount(0);
      await expect(peerPage.getByTestId('room-menu-save')).toHaveCount(0);
    } finally {
      await peerPage.close();
      await peerContext.close();
    }
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

  test('keeps a newer local element when a stale remote snapshot arrives', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'ReconcileHost', 2);
    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'ReconcilePeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await appendElement(page, rectangle('reconcile-rect-1', 410, 150, 5, 'a0'));
      await expect.poll(async () => sceneElementIds(peerPage), { timeout: 20000 })
        .toContain('reconcile-rect-1');

      // Publish a complete but stale peer object. The host must retain its
      // newer local geometry when the remote update is reconciled.
      await replaceElement(peerPage, rectangle('reconcile-rect-1', 40, 150, 2, 'a0'));
      await expect.poll(async () => page.evaluate(() => {
        const element = (window as any).__debugExcalidrawApi?.getSceneElements?.()
          ?.find((candidate: any) => candidate.id === 'reconcile-rect-1');
        return { x: element?.x, version: element?.version };
      }), { timeout: 20000 }).toEqual({ x: 410, version: 5 });
      await expect.poll(async () => peerPage.evaluate(() => {
        const element = (window as any).__debugExcalidrawApi?.getSceneElements?.()
          ?.find((candidate: any) => candidate.id === 'reconcile-rect-1');
        return { x: element?.x, version: element?.version };
      }), { timeout: 20000 }).toEqual({ x: 410, version: 5 });

      // With equal versions, Excalidraw's public reconcileElements uses the
      // versionNonce tie-breaker. A lower local nonce remains authoritative.
      await replaceElement(peerPage, rectangle('reconcile-rect-1', 40, 150, 5, 'a0', 6));
      await replaceSharedElement(peerPage, rectangle('reconcile-rect-1', 40, 150, 5, 'a0', 6));
      expect(await sharedElement(peerPage, 'reconcile-rect-1')).toEqual({ x: 40, version: 5, versionNonce: 6 });
      await expect.poll(async () => page.evaluate(() => {
        const element = (window as any).__debugExcalidrawApi?.getSceneElements?.()
          ?.find((candidate: any) => candidate.id === 'reconcile-rect-1');
        return { x: element?.x, version: element?.version, versionNonce: element?.versionNonce };
      }), { timeout: 20000 }).toEqual({ x: 410, version: 5, versionNonce: 5 });
      await expect.poll(async () => sharedElement(peerPage, 'reconcile-rect-1'), { timeout: 20000 })
        .toEqual({ x: 410, version: 5, versionNonce: 5 });
      await expect.poll(async () => peerPage.evaluate(() => {
        const element = (window as any).__debugExcalidrawApi?.getSceneElements?.()
          ?.find((candidate: any) => candidate.id === 'reconcile-rect-1');
        return { x: element?.x, version: element?.version, versionNonce: element?.versionNonce };
      }), { timeout: 20000 }).toEqual({ x: 410, version: 5, versionNonce: 5 });
    } finally {
      await peerContext.close();
    }
  });

  test('undoes only Alice local work and redoes it across both peers', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'UndoAlice', 2);
    const bobContext = await newAuthenticatedContext(browser);
    const bobPage = await bobContext.newPage();
    try {
      await joinExistingRoom(bobPage, roomId, 'UndoBob');
      await expect(bobPage.getByRole('heading', { name: /Room is Full/ })).toBeVisible({ timeout: 15000 });
      await approveFirstWaitingPeer(page);
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await expect.poll(async () => page.evaluate(() => (window as any).__whiteboardCollab?.isSynced), { timeout: 20000 })
        .toBe(true);
      await expect.poll(async () => bobPage.evaluate(() => (window as any).__whiteboardCollab?.isSynced), { timeout: 20000 })
        .toBe(true);

      await waitForExcalidrawApi(bobPage);
      await bobPage.evaluate((element) => {
        const api = (window as any).__debugExcalidrawApi;
        api.updateScene({ elements: [...api.getSceneElements(), element], captureUpdate: 'IMMEDIATELY' });
      }, rectangle('undo-bob', 120, 120, 5, 'a0'));
      await expect.poll(async () => sceneElementIds(page), { timeout: 20000 }).toContain('undo-bob');

      await waitForExcalidrawApi(page);
      await page.evaluate((element) => {
        const api = (window as any).__debugExcalidrawApi;
        api.updateScene({ elements: [...api.getSceneElements(), element], captureUpdate: 'IMMEDIATELY' });
      }, rectangle('undo-alice', 420, 120, 6, 'b0'));
      await expect.poll(async () => sceneElementIds(bobPage), { timeout: 20000 })
        .toEqual(expect.arrayContaining(['undo-alice', 'undo-bob']));
      await expect.poll(async () => sharedElementIds(page), { timeout: 20000 })
        .toEqual(['undo-alice', 'undo-bob']);

      /*
       * Excalidraw's own undo, which is the board's only one now. This is the
       * test that says it is safe to use here: Alice undoes and Bob's element
       * survives, because remote updates are applied with
       * CaptureUpdateAction.NEVER and so never enter Alice's history.
       */
      await expect(page.locator('.undo-button-container button')).toBeEnabled();
      await page.locator('.undo-button-container button').click();
      await expect.poll(async () => sceneElementIds(page), { timeout: 20000 }).toEqual(['undo-bob']);
      await expect.poll(async () => sceneElementIds(bobPage), { timeout: 20000 }).toEqual(['undo-bob']);
      // Alice's element is tombstoned in the array, not removed: what matters
      // is that nothing anybody can see went with it except her own work.
      await expect.poll(async () => liveSharedElementIds(page), { timeout: 20000 })
        .toEqual(['undo-bob']);

      await expect(page.locator('.redo-button-container button')).toBeEnabled();
      await page.locator('.redo-button-container button').click();
      await expect.poll(async () => sharedElementIds(page), { timeout: 20000 })
        .toEqual(['undo-alice', 'undo-bob']);
      await expect.poll(async () => sceneElementIds(page), { timeout: 20000 })
        .toEqual(['undo-alice', 'undo-bob']);
      await expect.poll(async () => sceneElementIds(bobPage), { timeout: 20000 })
        .toEqual(['undo-alice', 'undo-bob']);
    } finally {
      await bobContext.close();
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
