import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import {
  createRoomWithMaxUsers,
  joinExistingRoom,
  approveFirstWaitingPeer,
  expectWaiting,
  newAuthenticatedContext,
  appendElement,
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

test.describe('Multi-peer collaboration', () => {
  test('an element appended by the approved peer appears on the host', async ({ page, browser }) => {
    // Host creates a room
    const roomId = await createRoomWithMaxUsers(page, 'MultiHost', 2);

    // Peer joins and gets approved
    const peerContext = await newAuthenticatedContext(browser);
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

  test('sheds awareness frames under signaling budget while preserving Yjs updates', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'ShedHost', 2);
    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'ShedPeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await expect.poll(
        async () => peerPage.evaluate(() => {
          const socket = (window as any).__whiteboardCollab?.provider?.ws as WebSocket | undefined;
          return socket?.readyState === WebSocket.OPEN;
        }),
        { timeout: 15000 },
      ).toBe(true);

      await expect.poll(
        async () => peerPage.evaluate(() => Boolean((window as any).__debugExcalidrawApi)),
        { timeout: 15000 },
      ).toBe(true);
      // Let the initial remote-scene hydration finish before the local update.
      await peerPage.waitForTimeout(400);

      // Under the signaling budget (120 msg/s), awareness frames (type 1) are
      // shed when exceeding budget, but Yjs sync frames (type 0) are lossless
      // and never shed. Prove an awareness probe is shed while an interleaved
      // scene update is delivered without loss.
      const probeTag = `shed-probe-${crypto.randomUUID()}`;
      await page.evaluate((tag) => {
        const socket = (window as any).__whiteboardCollab?.provider?.ws as WebSocket | undefined;
        (window as any).__receivedProbe = false;
        socket?.addEventListener('message', (event: MessageEvent) => {
          if (event.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(event.data);
            if (bytes[0] === 1) {
              const text = new TextDecoder().decode(bytes.subarray(1));
              if (text.includes(tag)) {
                (window as any).__receivedProbe = true;
              }
            }
          }
        });
      }, probeTag);

      const shedElementId = 'preserved-during-shed-rect-1';
      await peerPage.evaluate(async ({ element, tag }) => {
        const socket = (window as any).__whiteboardCollab?.provider?.ws as WebSocket | undefined;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          throw new Error('expected the peer y-websocket to be open');
        }

        // Send > 120 awareness frames (messageType === 1) to exceed the 120/s budget
        for (let index = 0; index < 130; index += 1) {
          const payload = new TextEncoder().encode(`flood-${index}`);
          const frame = new Uint8Array(1 + payload.length);
          frame[0] = 1;
          frame.set(payload, 1);
          socket.send(frame.buffer);
        }

        // Awareness probe sent over budget must be shed
        const probePayload = new TextEncoder().encode(tag);
        const probeFrame = new Uint8Array(1 + probePayload.length);
        probeFrame[0] = 1;
        probeFrame.set(probePayload, 1);
        socket.send(probeFrame.buffer);

        // Drawing update generates a sync frame (messageType === 0), which is never shed
        const api = (window as any).__debugExcalidrawApi;
        api.updateScene({
          elements: [...api.getSceneElements(), element],
          captureUpdate: 'IMMEDIATELY',
        });
      }, { element: rectangle(shedElementId, 320, 180), tag: probeTag });

      // Awareness probe was dropped by signaling budget
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => (window as any).__receivedProbe)).toBe(false);

      // Local update is present on the peer
      await expect.poll(async () => sceneElementIds(peerPage), { timeout: 5000 }).toContain(shedElementId);

      // Drawing update is preserved: host receives the sync frame despite the awareness flood
      await expect.poll(async () => sceneElementIds(page), { timeout: 10000 }).toContain(shedElementId);
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
    const peerContext = await newAuthenticatedContext(browser);
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
  test('clearing the board on the host empties the peers scene too', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'ClearHost', 2);
    const clearTestElemId = 'clear-test-rect-1';

    // The peer is approved BEFORE any content exists, so this exercises clear-board
    // propagation rather than the known late-joiner history defect.
    const peerContext = await newAuthenticatedContext(browser);
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
    const peerContext = await newAuthenticatedContext(browser);
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

    /*
     * Long enough for the arithmetic behind it, which is two numbers:
     * ACTIVE_WINDOW_MS (10s) before a silent peer is counted gone, plus
     * PRESENCE_POLL_MAX_MS (5s) before the host's next heartbeat triggers the
     * broadcast that rebuilds the roster. Fifteen seconds is therefore the
     * worst case exactly, not a margin -- and this ran at 17s.
     *
     * A closing context is the ungraceful path on purpose: the DELETE that
     * normally removes a leaver does not arrive, so the window is all there is.
     */
    await expect(peerElement).toHaveCount(0, { timeout: 20000 });
  });

  test('both peers show each other in the presence panel after approval', async ({ page, browser }) => {
    // Host creates a room
    const roomId = await createRoomWithMaxUsers(page, 'PresenceHost', 2);

    // Peer joins and gets approved
    const peerContext = await newAuthenticatedContext(browser);
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
