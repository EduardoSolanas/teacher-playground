import { test, expect } from './fixtures';
import { Page, Browser } from '@playwright/test';
import { createRoomWithMaxUsers, newAuthenticatedContext, expandPresenceIfCollapsed, roomIdFromPageUrl, clickCreateRoom, expectSessionCookie, unusedHexRoomId } from './helpers';

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function appUrl(path: string) {
  return new URL(path, process.env.PLAYWRIGHT_BASE_URL).toString();
}

async function cleanContextAndJoin(
  page: Page,
  name: string,
  joinCode?: string,
) {
  if (joinCode) {
    await page.evaluate(() => {
      localStorage.removeItem('whiteboard_username');
    });
    await page.goto(appUrl(`/whiteboard/${joinCode}`));
  } else {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);
    await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');
    await page.evaluate(() => {
      localStorage.removeItem('whiteboard_username');
      localStorage.setItem(
        'whiteboard_user_color',
        '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
      );
    });
    await clickCreateRoom(page);
  }

  const canvasArea = page.getByTestId('whiteboard-canvas-area');
  const usernameInput = page.getByTestId('whiteboard-username-input');
  const nextView = await Promise.race([
    canvasArea.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'canvas' as const).catch(() => null),
    usernameInput.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'prompt' as const).catch(() => null),
  ]);
  if (nextView === 'prompt') {
    await usernameInput.fill(name);
    await page.getByTestId('whiteboard-join-room-btn').click();
  }

  // Wait for whiteboard to be ready
  await expect(page.getByTestId('whiteboard-tool-select')).toBeVisible({ timeout: 15000 });
  await expect(canvasArea).toBeVisible({ timeout: 15000 });
}

async function getStoreState(page: Page) {
  return await page.evaluate(() => {
    // @ts-ignore
    return window.__whiteboardStore?.getState?.() || {};
  });
}

async function getCollabState(page: Page) {
  return await page.evaluate(() => {
    // @ts-ignore
    return window.__whiteboardCollab || {};
  });
}

async function addElement(page: Page, element: any) {
  await page.evaluate((el) => {
    // @ts-ignore
    const store = window.__whiteboardStore;
    if (store) store.addElement(el);
  }, element);
}

async function waitForSync(page: Page, expectedElements: number, timeout = 10000) {
  await expect.poll(
    async () => {
      const state = await getStoreState(page);
      return state.elements?.length || 0;
    },
    { timeout },
  )[expectedElements === 0 ? 'toBe' : 'toBeGreaterThanOrEqual'](expectedElements);
}

/**
 * A second peer joining an occupied room lands in the waiting queue until the
 * host lets them in. Tolerant on purpose: when the room has spare capacity the
 * peer is admitted directly and there is nothing to approve.
 */
async function approveWaitingPeerIfPresent(hostPage: Page) {
  await expandPresenceIfCollapsed(hostPage);
  const waiting = hostPage
    .locator('[data-testid="whiteboard-waiting-section"] [data-testid^="whiteboard-user-"]')
    .first();

  try {
    await waiting.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    return;
  }

  await waiting.getByRole('button', { name: 'Let in' }).click();
}

async function waitForPresence(page: Page, name: string, timeout = 15000) {
  await expect(page.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: name }).first()).toBeVisible({ timeout });
}

async function waitForProviderConnected(page: Page, timeout = 20000) {
  await expect.poll(
    async () => {
      const c = await getCollabState(page);
      return c.status;
    },
    { timeout },
  ).toMatch(/connected|synced/);
}

/**
 * Draws by dispatching PointerEvents in the page.
 *
 * `page.mouse` does not reach Excalidraw's canvas handlers — a known limitation
 * of driving HTML5 canvas apps through synthetic browser input — so the drag is
 * replayed as the pointerdown/pointermove/pointerup sequence Excalidraw listens
 * for. This still exercises the real path: tool selection, element creation,
 * Yjs sync, and the store bridge.
 */
async function dragOnCanvas(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const canvas = page.getByTestId('whiteboard-canvas-area');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  // Excalidraw must be mounted AND initialised before the drag is replayed;
  // dispatching at a half-ready canvas silently produces no element.
  await page.locator('canvas.excalidraw__canvas.interactive').first().waitFor({
    state: 'attached',
    timeout: 15000,
  });
  await page.waitForFunction(() => !!(window as any).__debugExcalidrawApi, {
    timeout: 15000,
  });

  // A tool change propagates store -> React state -> prop -> Excalidraw, so a
  // drag dispatched immediately after clicking a tool would still be handled by
  // the previous one. Let that settle before pressing the pointer down.
  await page.waitForTimeout(250);

  await page.evaluate(
    async ({ x1, y1, x2, y2 }) => {
      const canvas = document.querySelector('canvas.excalidraw__canvas.interactive');
      if (!canvas) throw new Error('Excalidraw interactive canvas not found');

      const event = (type: string, x: number, y: number, buttons: number) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons,
        });

      const nextFrame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      canvas.dispatchEvent(event('pointerdown', x1, y1, 1));

      // Excalidraw throttles pointer handling to the display framerate, so the
      // moves have to be spread across frames. Dispatching them in one tick
      // collapses a freehand stroke down to a single point.
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        await nextFrame();
        const x = x1 + ((x2 - x1) * i) / steps;
        const y = y1 + ((y2 - y1) * i) / steps;
        canvas.dispatchEvent(event('pointermove', x, y, 1));
      }

      await nextFrame();
      window.dispatchEvent(event('pointerup', x2, y2, 0));
    },
    {
      x1: box!.x + from.x,
      y1: box!.y + from.y,
      x2: box!.x + to.x,
      y2: box!.y + to.y,
    },
  );

  // Let Excalidraw commit the element and the store bridge run.
  await page.waitForTimeout(150);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Room Connection Lifecycle', () => {
  test('disables create room button while room creation is pending', async ({ page }) => {
    let finishCreateRoom!: () => void;
    const createRoomPending = new Promise<void>((resolve) => {
      finishCreateRoom = resolve;
    });

    await page.route('**/api/whiteboard/room/*', async (route) => {
      await createRoomPending;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          updated_at: Date.now(),
          maxUsers: 2,
          hostPeerId: 'test-host',
        }),
      });
    });

    await page.goto(appUrl('/whiteboard'));
    await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');

    await expect(page.getByTestId('whiteboard-create-room-btn')).toBeEnabled();

    const createButton = page.getByTestId('whiteboard-create-room-btn');
    await createButton.click();

    await expect(createButton).toBeDisabled();
    await expect(createButton).toContainText('Creating room...');

    finishCreateRoom();
  });

  test('creates room and joins with username', async ({ page }) => {
    await cleanContextAndJoin(page, 'Alice');

    // Whiteboard UI is visible
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();
    await expect(page.getByTestId('whiteboard-tool-select')).toBeVisible(); // tool sidebar
    await expect(page.locator('[data-whiteboard-role="host"] [title="Library"]')).toBeVisible(); // Excalidraw top bar
    await expect(page.getByTestId('whiteboard-bottom-controls')).toBeVisible(); // bottom controls

    // Presence panel shows correct name
    await waitForPresence(page, 'Alice');

    // Provider is connecting
    const collab = await getCollabState(page);
    expect(collab.status).toBeTruthy();
  });

  test('joins room via code', async ({ page }) => {
    // First, create a room and get the code
    await cleanContextAndJoin(page, 'Creator');
    const roomUrl = page.url();
    const roomId = roomUrl.split('/whiteboard/')[1];

    // Navigate to home
    await page.goto(appUrl('/whiteboard'));
    await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');

    // Join via code
    await cleanContextAndJoin(page, 'Joiner', roomId);
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();
    await waitForPresence(page, 'Joiner');
  });

  test('in-room leave clears localStorage room and session keys', async ({ page }) => {
    const roomId = await createRoomWithMaxUsers(page, 'LeaveStorageHost', 2);
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();
    await expect(page.getByTestId('whiteboard-leave-room-btn')).toBeVisible();

    // Seed board cache keys; peer id and username are set during join.
    await page.evaluate((rid) => {
      localStorage.setItem(
        `whiteboard:${rid}:state`,
        JSON.stringify({ elements: [], viewport: { x: 0, y: 0, zoom: 1 } }),
      );
      localStorage.setItem(`whiteboard:${rid}:timestamp`, String(Date.now()));
      localStorage.setItem(`whiteboard:${rid}:offline_cache`, '1');
    }, roomId);

    const beforeLeave = await page.evaluate((rid) => ({
      state: localStorage.getItem(`whiteboard:${rid}:state`),
      peerId: localStorage.getItem(`whiteboard:${rid}:peer_id`),
      username: localStorage.getItem('whiteboard_username'),
    }), roomId);
    expect(beforeLeave.state).not.toBeNull();
    expect(beforeLeave.peerId).not.toBeNull();
    expect(beforeLeave.username).toBe('LeaveStorageHost');

    await page.getByTestId('whiteboard-leave-room-btn').click();
    await expect(page.getByTestId('whiteboard-username-input')).toBeVisible({ timeout: 10000 });

    const afterLeave = await page.evaluate((rid) => ({
      state: localStorage.getItem(`whiteboard:${rid}:state`),
      timestamp: localStorage.getItem(`whiteboard:${rid}:timestamp`),
      offlineCache: localStorage.getItem(`whiteboard:${rid}:offline_cache`),
      peerId: localStorage.getItem(`whiteboard:${rid}:peer_id`),
      username: localStorage.getItem('whiteboard_username'),
      userColor: localStorage.getItem('whiteboard_user_color'),
    }), roomId);

    expect(afterLeave.state).toBeNull();
    expect(afterLeave.timestamp).toBeNull();
    expect(afterLeave.offlineCache).toBeNull();
    expect(afterLeave.peerId).toBeNull();
    expect(afterLeave.username).toBeNull();
    expect(afterLeave.userColor).toBeNull();
  });

  test('user name persists across page navigation', async ({ page }) => {
    await cleanContextAndJoin(page, 'PersistentUser');
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();

    // Navigate away and back
    await page.goto(appUrl('/whiteboard'));
    await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');

    // Opening the same room again reuses the remembered name: the user is
    // taken straight to the board instead of being asked who they are again.
    await expect(page.getByTestId('whiteboard-create-room-btn')).toBeDisabled();
    await page.locator('[data-testid^="whiteboard-room-list-item-"]').first().click();
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('whiteboard-username-input')).toHaveCount(0);

    const storedName = await page.evaluate(() =>
      localStorage.getItem('whiteboard_username'),
    );
    expect(storedName).toBe('PersistentUser');
  });

  test('page refresh preserves whiteboard state', async ({ page }) => {
    await cleanContextAndJoin(page, 'Refresher');
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();

    // Draw through the real path so the element flows into the debounced save.
    await page.getByTestId('whiteboard-tool-rectangle').click();
    await dragOnCanvas(page, { x: 200, y: 200 }, { x: 350, y: 300 });

    // Poll rather than sample: the room is polled in the background, so an
    // immediate read can land between the draw and the resulting re-render.
    await expect
      .poll(async () => (await getStoreState(page)).elements?.length ?? 0, { timeout: 10000 })
      .toBeGreaterThanOrEqual(1);

    // Saving to the room API is debounced; wait until the server actually has
    // the element rather than guessing at the delay.
    const roomId = roomIdFromPageUrl(page);
    await expect
      .poll(
        async () => {
          const res = await page.request.get(appUrl(`/api/whiteboard/room/${roomId}`));
          if (!res.ok()) return 0;
          const body = await res.json();
          return body.elements?.length ?? 0;
        },
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(1);

    // Refresh the page
    // Not networkidle: the room is polled on an interval, so the network is
    // never idle and the reload would never resolve.
    await page.reload({ waitUntil: 'load' });
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

    // After refresh, the prompt should show pre-filled name
    const promptVisible = await page.getByTestId('whiteboard-username-input').isVisible();
    if (promptVisible) {
      await page.getByTestId('whiteboard-username-input').fill('Refresher');
      await page.getByTestId('whiteboard-join-room-btn').click();
    }

    // Elements should be loaded from API
    await expect
      .poll(async () => (await getStoreState(page)).elements?.length ?? 0, { timeout: 15000 })
      .toBeGreaterThanOrEqual(1);
  });

  test('connection status transitions from connecting to connected', async ({ page }) => {
    await cleanContextAndJoin(page, 'StatusUser');

    // Initially status should be 'connecting' or 'connected'
    const collab1 = await getCollabState(page);
    expect(['connecting', 'connected', 'synced'].includes(collab1.status)).toBeTruthy();

    // After some time, should be connected or synced
    await expect
      .poll(async () => (await getCollabState(page)).status, { timeout: 15000 })
      .toMatch(/^(connected|synced)$/);
  });

  test('navigating to a room id that was never created stays in the waiting room', async ({ page }) => {
    await cleanContextAndJoin(page, 'NavUser');

    // Typing a URL is join, not create: first-user host is off and GET /room
    // requires a grant, so a never-created id cannot become a live board.
    await page.goto(`/whiteboard/${unusedHexRoomId()}`);

    await expect(page.getByRole('heading', { name: /Room is Full/ })).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('whiteboard-canvas-area')).toHaveCount(0);
  });
});

test.describe('Multi-Peer Sync', () => {
  test('Alice draws rectangle, Bob sees it via Yjs WebRTC', async ({ page, browser }) => {
    // Alice creates room
    await cleanContextAndJoin(page, 'Alice');
    const roomUrl = page.url();
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();

    // Bob joins in separate browser context (simulates different browser/process)
    const bobContext = await newAuthenticatedContext(browser);
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
        localStorage.setItem('whiteboard_user_color', '#e74c3c');
      });
      await bobPage.goto(roomUrl);
      await expect(bobPage.getByTestId('whiteboard-username-input')).toBeVisible();
      await bobPage.getByTestId('whiteboard-username-input').fill('Bob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await approveWaitingPeerIfPresent(page);
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      // Wait for both peers to be connected
      await waitForProviderConnected(page);
      await waitForProviderConnected(bobPage);
      await page.waitForTimeout(2000);

      // Alice draws a rectangle
      const rectIcon = page.getByTestId('whiteboard-tool-rectangle');
      await rectIcon.click();
      await dragOnCanvas(page, { x: 200, y: 200 }, { x: 350, y: 300 });

      // Verify Alice's store has the element
      const aliceState = await getStoreState(page);
      expect(aliceState.elements?.length).toBeGreaterThanOrEqual(1);

      // Bob should see the element via Yjs sync
      await waitForSync(bobPage, 1, 15000);

      const bobState = await getStoreState(bobPage);
      const remoteRect = bobState.elements?.at(-1);
      expect(remoteRect?.type).toBe('rectangle');
      expect(remoteRect?.x).toBe(200);
      expect(remoteRect?.y).toBe(200);

      // Verify presence: Alice sees Bob, Bob sees Alice
      await waitForPresence(page, 'Bob');
      await waitForPresence(bobPage, 'Alice');
    } finally {
      await bobContext.close();
    }
  });

  test('Bob draws, Alice sees it', async ({ page, browser }) => {
    // Alice creates room
    await cleanContextAndJoin(page, 'HostAlice');
    const roomUrl = page.url();

    // Bob joins
    const bobContext = await newAuthenticatedContext(browser);
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('BobDrawer');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await approveWaitingPeerIfPresent(page);
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await waitForProviderConnected(page);
      await waitForProviderConnected(bobPage);
      await page.waitForTimeout(2000);

      // Bob draws a pen stroke
      const penIcon = bobPage.getByTestId('whiteboard-tool-pen');
      await penIcon.click();
      await dragOnCanvas(bobPage, { x: 100, y: 100 }, { x: 250, y: 200 });

      const bobState = await getStoreState(bobPage);
      expect(bobState.elements?.length).toBeGreaterThanOrEqual(1);

      // Alice should see the element
      await waitForSync(page, 1, 15000);

      const aliceState = await getStoreState(page);
      const remotePen = aliceState.elements?.at(-1);
      // The pen tool produces Excalidraw's freehand element type.
      expect(remotePen?.type).toBe('freedraw');

      // Stroke geometry lives on the Excalidraw element; the legacy store
      // projection has no `points` field, so assert against the real scene.
      const remotePointCount = await page.evaluate(() => {
        const scene = (window as any).__debugExcalidrawApi?.getSceneElements?.() ?? [];
        const last = scene[scene.length - 1];
        return Array.isArray(last?.points) ? last.points.length : 0;
      });
      expect(remotePointCount).toBeGreaterThan(1);
    } finally {
      await bobContext.close();
    }
  });

  test('a peer can draw while the other is drawing continuously', async ({ page, browser }) => {
    /*
     * The sequential test above never overlaps, so it missed this: applying a
     * remote scene set a flag that discarded every local change for 100ms, and
     * a drawing peer commits every 50ms. The window never closed, so whoever
     * was not the busiest peer had their own strokes dropped entirely — the
     * host drew fine and the student could not.
     */
    await cleanContextAndJoin(page, 'BusyAlice');
    const roomUrl = page.url();

    const bobContext = await newAuthenticatedContext(browser);
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('BusyBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await approveWaitingPeerIfPresent(page);
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await waitForProviderConnected(page);
      await waitForProviderConnected(bobPage);
      await page.waitForTimeout(2000);

      await page.getByTestId('whiteboard-tool-pen').click();
      await bobPage.getByTestId('whiteboard-tool-rectangle').click();

      // One continuous stroke held for ~2s, not a burst with gaps: the flag is
      // re-armed by each arriving commit, so only an unbroken stream keeps the
      // window from ever closing. A sequence of short drags does not reproduce.
      const aliceKeepsDrawing = page.evaluate(async () => {
        const canvas = document.querySelector('canvas.excalidraw__canvas.interactive') as HTMLElement;
        const box = canvas.getBoundingClientRect();
        const at = (x: number, y: number, type: string) => canvas.dispatchEvent(new PointerEvent(type, {
          clientX: box.left + x, clientY: box.top + y,
          bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
        }));
        at(60, 60, 'pointerdown');
        for (let i = 0; i < 100; i++) {
          at(60 + i * 2, 60 + (i % 20) * 4, 'pointermove');
          await new Promise((r) => setTimeout(r, 20));
        }
        at(260, 140, 'pointerup');
      });
      const bobDrawsOnce = (async () => {
        // Mid-stream, while Alice's stroke is still in flight.
        await bobPage.waitForTimeout(800);
        await dragOnCanvas(bobPage, { x: 420, y: 320 }, { x: 520, y: 420 });
      })();

      await Promise.all([aliceKeepsDrawing, bobDrawsOnce]);

      // Polled, not slept on: a fixed wait passed alone and failed under the
      // parallel suite, where both pages are slower. The claim is that the
      // rectangle arrives, not that it arrives within three seconds.
      await expect
        .poll(
          () => page.evaluate(() => {
            const api = (window as any).__debugExcalidrawApi;
            const elements = api?.getSceneElements?.() ?? [];
            return elements.filter((e: any) => e.type === 'rectangle' && !e.isDeleted).length;
          }),
          { timeout: 25000, message: "Bob's rectangle never reached Alice" },
        )
        .toBeGreaterThanOrEqual(1);
    } finally {
      await bobContext.close();
    }
  });

  test('both peers draw simultaneously, both see each other', async ({ page, browser }) => {
      await cleanContextAndJoin(page, 'SimAlice');
    const roomUrl = page.url();

    const bobContext = await newAuthenticatedContext(browser);
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('SimBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await approveWaitingPeerIfPresent(page);
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await waitForProviderConnected(page);
      await waitForProviderConnected(bobPage);
      await page.waitForTimeout(2000);

      // Alice draws rectangle
      const rectIcon = page.getByTestId('whiteboard-tool-rectangle');
      await rectIcon.click();
      await dragOnCanvas(page, { x: 100, y: 100 }, { x: 200, y: 200 });

      // Bob draws circle
      const circleIcon = bobPage.getByTestId('whiteboard-tool-circle');
      await circleIcon.click();
      await dragOnCanvas(bobPage, { x: 300, y: 300 }, { x: 400, y: 400 });

      // Wait for sync both ways
      await waitForSync(page, 2, 15000);
      await waitForSync(bobPage, 2, 15000);

      const aliceState = await getStoreState(page);
      const bobState = await getStoreState(bobPage);
      const typesOf = (state: { elements?: Array<{ type?: string; isDeleted?: boolean }> }) =>
        (state.elements ?? [])
          .filter((element) => !element.isDeleted)
          .map((element) => element.type)
          .sort();
      expect(new Set(typesOf(aliceState))).toEqual(new Set(['ellipse', 'rectangle']));
      expect(new Set(typesOf(bobState))).toEqual(new Set(['ellipse', 'rectangle']));
    } finally {
      await bobContext.close();
    }
  });

  test('Bob leaves, Alice sees user count drop', async ({ page, browser }) => {
    await cleanContextAndJoin(page, 'LeftAlice');
    const roomUrl = page.url();

    const bobContext = await newAuthenticatedContext(browser);
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('LeftBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await approveWaitingPeerIfPresent(page);
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await waitForProviderConnected(page);
      await waitForProviderConnected(bobPage);
      await page.waitForTimeout(2000);

      // Both present
      await waitForPresence(page, 'LeftBob');
      await waitForPresence(bobPage, 'LeftAlice');

      // Bob closes his page
      await bobPage.close();

      // Alice should see Bob disappear (presence updates via polling)
      await page.waitForTimeout(4000);
      const presencePanel = page.getByTestId('whiteboard-presence-toggle');
      const panelText = await presencePanel.textContent();
      expect(panelText).not.toContain('LeftBob');
    } finally {
      await bobContext.close();
    }
  });

  test('Bob joins after Alice has drawn, Bob receives all elements', async ({ page, browser }) => {
    await cleanContextAndJoin(page, 'EarlyAlice');
    const roomUrl = page.url();

    // Alice draws multiple elements
    const rectIcon = page.getByTestId('whiteboard-tool-rectangle');
    await rectIcon.click();
    await dragOnCanvas(page, { x: 50, y: 50 }, { x: 150, y: 150 });

    const penIcon = page.getByTestId('whiteboard-tool-pen');
    await penIcon.click();
    await dragOnCanvas(page, { x: 200, y: 200 }, { x: 300, y: 300 });

    const circleIcon = page.getByTestId('whiteboard-tool-circle');
    await circleIcon.click();
    await dragOnCanvas(page, { x: 400, y: 400 }, { x: 500, y: 500 });

    await waitForSync(page, 3, 10000);

    // Bob joins late
    const bobContext = await newAuthenticatedContext(browser);
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('LateBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await approveWaitingPeerIfPresent(page);
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await waitForProviderConnected(bobPage);
      await waitForSync(bobPage, 3, 15000);

      const bobState = await getStoreState(bobPage);
      expect(bobState.elements?.length).toBeGreaterThanOrEqual(3);
    } finally {
      await bobContext.close();
    }
  });
});

test.describe('Reconnection & Resilience', () => {
  test('reconnecting page receives existing elements', async ({ page }) => {
    await cleanContextAndJoin(page, 'ReconnUser');

    // Add elements
    await addElement(page, {
      id: generateId(),
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 100,
      height: 50,
      fill: '#e74c3c',
      stroke: '#c0392b',
      strokeWidth: 2,
    });

    const stateBefore = await getStoreState(page);
    expect(stateBefore.elements?.length).toBe(1);

    // Simulate disconnect by clearing Yjs provider cache, then reconnect
    await page.evaluate(() => {
      // @ts-ignore
      const collab = window.__whiteboardCollab;
      if (collab?.provider) {
        collab.provider.disconnect();
        // Small delay then reconnect
        setTimeout(() => {
          // @ts-ignore
          collab.provider.connect();
        }, 500);
      }
    });

    await page.waitForTimeout(3000);

    // Elements should still be there after reconnect
    const stateAfter = await getStoreState(page);
    expect(stateAfter.elements?.length).toBe(1);
  });

  test('rapid tool switching doesn\'t lose elements', async ({ page }) => {
    await cleanContextAndJoin(page, 'SwitchUser');

    // Draw with pen
    const penIcon = page.getByTestId('whiteboard-tool-pen');
    await penIcon.click();
    await dragOnCanvas(page, { x: 100, y: 100 }, { x: 200, y: 200 });

    // Rapidly switch tools
    await page.keyboard.press('r'); // rectangle
    await page.waitForTimeout(100);
    await page.keyboard.press('c'); // circle
    await page.waitForTimeout(100);
    await page.keyboard.press('l'); // line
    await page.waitForTimeout(100);
    await page.keyboard.press('p'); // pen again

    // Wait for the last switch to land rather than sampling immediately.
    await expect
      .poll(async () => (await getStoreState(page)).tool, { timeout: 5000 })
      .toBe('pen');

    const state = await getStoreState(page);
    expect(state.elements?.length).toBeGreaterThanOrEqual(1);
  });

  test('clearing board removes all elements and syncs', async ({ page, browser }) => {
    await cleanContextAndJoin(page, 'ClearAlice');
    const roomUrl = page.url();

    const bobContext = await newAuthenticatedContext(browser);
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('ClearBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await approveWaitingPeerIfPresent(page);
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await waitForProviderConnected(page);
      await waitForProviderConnected(bobPage);
      await page.waitForTimeout(2000);

      // Draw through the real path: writing straight into the legacy store
      // does not reach Excalidraw or Yjs, so it would never sync to Bob.
      await page.getByTestId('whiteboard-tool-rectangle').click();
      await dragOnCanvas(page, { x: 200, y: 200 }, { x: 320, y: 300 });
      await waitForSync(bobPage, 1, 10000);

      // Alice clears board
      await page.getByTestId('whiteboard-clear-btn').click();
      await expect(page.getByTestId('whiteboard-clear-confirm-btn')).toBeVisible();
      await page.getByTestId('whiteboard-clear-confirm-btn').click();

      // Alice's board is empty. Polled, not slept on: the clear runs through a
      // Yjs transaction and back out to React, which a fixed delay races.
      await waitForSync(page, 0, 10000);

      // Bob should also see empty board (Yjs sync deletes elements)
      await waitForSync(bobPage, 0, 10000);

      // And it has to stay cleared. The HTTP snapshot fallback republishes
      // whatever the room API still holds, so a stale save landing after the
      // clear would quietly bring the element back on both peers.
      await page.waitForTimeout(1500);
      expect((await getStoreState(page)).elements?.length ?? 0).toBe(0);
      expect((await getStoreState(bobPage)).elements?.length ?? 0).toBe(0);
    } finally {
      await bobContext.close();
    }
  });

});

test.describe('Edge Cases', () => {
  test('creating many rooms in succession works', async ({ browser }) => {
    for (let i = 0; i < 5; i++) {
      const ctx = await newAuthenticatedContext(browser);
      const page = await ctx.newPage();
      try {
        await cleanContextAndJoin(page, `User${i}`);
        await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 10000 });
      } finally {
        await ctx.close();
      }
    }
  });

  test('joining with special characters in name works', async ({ page }) => {
    await cleanContextAndJoin(page, 'User-123_Test');
    await waitForPresence(page, 'User-123_Test');
  });

  test('drawing while provider is still connecting still works', async ({ page }) => {
    await cleanContextAndJoin(page, 'FastDraw');

    // Immediately draw without waiting for provider connected
    const penIcon = page.getByTestId('whiteboard-tool-pen');
    await penIcon.click();
    await dragOnCanvas(page, { x: 100, y: 100 }, { x: 200, y: 200 });

    const state = await getStoreState(page);
    expect(state.elements?.length).toBeGreaterThanOrEqual(1);

    // Now wait for provider to connect — element should sync
    await waitForProviderConnected(page);
    await page.waitForTimeout(2000);

    const stateAfter = await getStoreState(page);
    expect(stateAfter.elements?.length).toBeGreaterThanOrEqual(1);
  });

  test('undo/redo works after Yjs sync', async ({ page, browser }) => {
    await cleanContextAndJoin(page, 'UndoAlice');
    const roomUrl = page.url();

    const bobContext = await newAuthenticatedContext(browser);
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('UndoBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await approveWaitingPeerIfPresent(page);
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await waitForProviderConnected(page);
      await waitForProviderConnected(bobPage);
      await page.waitForTimeout(2000);

      // Alice adds 3 elements
      for (let i = 0; i < 3; i++) {
        await addElement(page, {
          id: generateId(),
          type: 'pen',
          points: [{ x: i * 50, y: 0 }, { x: i * 50 + 30, y: 50 }],
          color: '#000000',
          strokeWidth: 2,
        });
        await page.waitForTimeout(200);
      }

      const stateBefore = await getStoreState(page);
      expect(stateBefore.elements?.length).toBe(3);

      // Undo once
      const undoBtn = page.getByTestId('whiteboard-undo-btn');
      await undoBtn.click();
      await page.waitForTimeout(300);

      const stateAfterUndo = await getStoreState(page);
      expect(stateAfterUndo.elements?.length).toBe(2);

      // Redo once
      const redoBtn = page.getByTestId('whiteboard-redo-btn');
      await redoBtn.click();
      await page.waitForTimeout(300);

      const stateAfterRedo = await getStoreState(page);
      expect(stateAfterRedo.elements?.length).toBe(3);
    } finally {
      await bobContext.close();
    }
  });

  test('all 8 tools can be selected and active state is shown', async ({ page }) => {
    await cleanContextAndJoin(page, 'ToolUser');

    const tools = [
      { key: 'p', title: 'Pen (P)', expected: 'pen' },
      { key: 'r', title: 'Rectangle (R)', expected: 'rectangle' },
      { key: 'c', title: 'Circle (C)', expected: 'circle' },
      { key: 'l', title: 'Line (L)', expected: 'line' },
      { key: 'a', title: 'Arrow (A)', expected: 'arrow' },
      { key: 't', title: 'Text (T)', expected: 'text' },
      { key: 's', title: 'Sticky Note (S)', expected: 'stickyNote' },
      { key: 'e', title: 'Eraser (E)', expected: 'eraser' },
    ];

    for (const tool of tools) {
      await page.keyboard.press(tool.key);
      await page.waitForTimeout(100);

      const state = await getStoreState(page);
      expect(state.tool).toBe(tool.expected);

      // Active tool should have blue background
      const activeTool = page.getByTestId(`whiteboard-tool-${tool.expected}`);
      await expect(activeTool).toHaveClass(/bg-blue-500/);
    }
  });

  test('presence shows correct user count', async ({ page, browser }) => {
    await cleanContextAndJoin(page, 'CountAlice');
    const roomUrl = page.url();

    const bobContext = await newAuthenticatedContext(browser);
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('CountBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await approveWaitingPeerIfPresent(page);
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await waitForProviderConnected(page);
      await waitForProviderConnected(bobPage);
      await page.waitForTimeout(3000);

      // Both should show "2/X" participants. The header count is compact
      // because "2 of 2" wrapped "IN THE ROOM" onto two lines in the rail.
      // The count lives in the panel
      // header, not on the collapse toggle.
      await expect(page.getByTestId('whiteboard-presence-count')).toContainText('2/');
      await expect(bobPage.getByTestId('whiteboard-presence-count')).toContainText('2/');
    } finally {
      await bobContext.close();
    }
  });
});
