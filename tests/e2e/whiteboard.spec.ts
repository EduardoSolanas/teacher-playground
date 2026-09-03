import { test, expect } from './fixtures';
import { Page, Browser, Locator } from '@playwright/test';
import { appendElement, createRoomWithMaxUsers, excalidrawRectangle, newAuthenticatedContext, expandPresenceIfCollapsed, roomIdFromPageUrl, clickCreateRoom, expectSessionCookie, unusedHexRoomId } from './helpers';

/**
 * Choose a tool and wait until the editor says it has it.
 *
 * Excalidraw's tool is a radio with its own icon painted over it, so a plain
 * click lands on the icon; forcing dispatches to the control. But force also
 * skips the actionability checks, and a forced click that arrives before
 * Excalidraw has finished mounting is simply dropped -- leaving the selection
 * tool active, so the drag that follows draws nothing at all and the test
 * fails somewhere else entirely. Asking the editor what it holds is the only
 * reliable acknowledgement.
 */
async function selectTool(locator: Locator, expected: string) {
  await locator.click({ force: true });
  await expect
    .poll(
      async () =>
        locator.page().evaluate(
          () => (window as any).__debugExcalidrawApi?.getAppState?.().activeTool?.type ?? null,
        ),
      { timeout: 15000 },
    )
    .toBe(expected);
}

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
  await expect(page.getByTestId('toolbar-selection')).toBeVisible({ timeout: 15000 });
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

async function getExcalidrawSceneIds(page: Page) {
  return page.evaluate(() => ((window as any).__debugExcalidrawApi?.getSceneElements?.() ?? [])
    .map((element: { id: string }) => element.id)
    .sort());
}

/**
 * What the shared document says is on the board.
 *
 * Excalidraw deletes by marking `isDeleted` rather than by removing, so an
 * undone element stays in the array as a tombstone for the server to prune.
 * Counting those would be asking what the array holds, when the question here
 * is what anybody can see.
 */
async function getSharedYjsElementIds(page: Page) {
  return page.evaluate(() => ((window as any).__whiteboardCollab?.provider?.doc?.getArray('elements')
    ?.toArray?.() ?? [])
    .filter((element: { get: (key: string) => unknown }) => element.get('isDeleted') !== true)
    .map((element: { get: (key: string) => unknown }) => element.get('id'))
    .filter((id: unknown): id is string => typeof id === 'string')
    .sort());
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
async function dispatchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
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

/**
 * Draws, and makes sure something was drawn.
 *
 * Synthetic pointer input at a canvas is unreliable in a way nothing here can
 * fix: a sequence that lands while Excalidraw is mid-render produces no
 * element and reports no error. Every caller draws in order to assert
 * something about the result, so a drag that quietly did nothing always
 * surfaced later as "expected an element, found none" -- somewhere unrelated,
 * one run in four or so.
 *
 * Comparing against the count before the drag rather than against zero,
 * because several callers draw a second and third shape onto a board that
 * already has one. A drag that still has not landed after three attempts is
 * left alone: the caller's own assertion is the right place for that verdict,
 * not a throw from a helper.
 */
async function dragOnCanvas(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const sceneCount = () => page.evaluate(
    () => (window as any).__debugExcalidrawApi?.getSceneElements?.().length ?? 0,
  );
  const before = await sceneCount();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dispatchDrag(page, from, to);
    /*
     * Four seconds, not two.
     *
     * The wait is how long the drag is given to show up before another is
     * dispatched, and dispatching one while the last is still being handled is
     * worse than waiting: Excalidraw sees a second pointerdown mid-sequence.
     * Under a full suite two seconds was short enough to overlap them, and the
     * element count came back one short with all three attempts spent.
     */
    const landed = await page
      .waitForFunction(
        (n) => ((window as any).__debugExcalidrawApi?.getSceneElements?.().length ?? 0) > n,
        before,
        { timeout: 4000 },
      )
      .then(() => true)
      .catch(() => false);
    if (landed) return;
  }
}

/**
 * One continuous stroke, held down for hundreds of samples.
 *
 * `dispatchDrag` spreads ten moves over ten frames, which is a flick. What
 * breaks a whiteboard is the other thing: a teacher drawing a single unbroken
 * curve across a diagram for several seconds. Every sample re-publishes the
 * element's whole point array, so the document grows with the square of the
 * stroke rather than its length -- which is how a room's document reached the
 * size that used to close its socket on every sync.
 *
 * The curve is a sine so the points cannot be collapsed to a straight line by
 * any simplification along the way: if the far peer receives a stroke with
 * markedly fewer points than the near one drew, the shape it shows is not the
 * shape that was drawn.
 */
async function dispatchLongStroke(page: Page, samples: number) {
  const canvas = page.getByTestId('whiteboard-canvas-area');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  await page.locator('canvas.excalidraw__canvas.interactive').first().waitFor({
    state: 'attached',
    timeout: 15000,
  });
  await page.waitForFunction(() => !!(window as any).__debugExcalidrawApi, { timeout: 15000 });
  await page.waitForTimeout(250);

  await page.evaluate(
    async ({ originX, originY, width, samples }) => {
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

      const pointAt = (i: number) => ({
        x: originX + (width * i) / samples,
        y: originY + Math.sin((i / samples) * Math.PI * 6) * 90,
      });

      const start = pointAt(0);
      canvas.dispatchEvent(event('pointerdown', start.x, start.y, 1));
      for (let i = 1; i <= samples; i += 1) {
        // One per frame, as Excalidraw's own throttling expects: batched into a
        // single tick they collapse into one point and the stroke is not long.
        await nextFrame();
        const point = pointAt(i);
        canvas.dispatchEvent(event('pointermove', point.x, point.y, 1));
      }
      await nextFrame();
      const end = pointAt(samples);
      window.dispatchEvent(event('pointerup', end.x, end.y, 0));
    },
    {
      originX: box!.x + 80,
      originY: box!.y + 300,
      width: 900,
      samples,
    },
  );

  await page.waitForTimeout(300);
}

/** Freedraw elements on the board, with how many points each carries. */
async function getFreedrawPointCounts(page: Page): Promise<number[]> {
  return page.evaluate(() => ((window as any).__debugExcalidrawApi?.getSceneElements?.() ?? [])
    .filter((element: { type: string; isDeleted?: boolean }) => (
      element.type === 'freedraw' && element.isDeleted !== true
    ))
    .map((element: { points?: unknown[] }) => element.points?.length ?? 0));
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
    await expect(page.getByTestId('toolbar-selection')).toBeVisible(); // tool sidebar
    // The library is reached from the room's title menu now; Excalidraw's own
    // button floated over the canvas and has gone with the hamburger.
    await expect(page.getByTestId('room-title-trigger')).toBeVisible();
    await expect(page.locator('.undo-button-container button')).toBeVisible(); // board controls, in the footer

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

  test('leaving a room clears localStorage room and session keys', async ({ page }) => {
    // Leaving is "Back to rooms" now: the in-room Leave beside it did the same
    // clearing and differed only in where it put you afterwards.
    const roomId = await createRoomWithMaxUsers(page, 'LeaveStorageHost', 2);
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();
    await expect(page.getByTestId('whiteboard-back-to-rooms')).toBeVisible();

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

    await page.getByTestId('whiteboard-back-to-rooms').click();
    await expect(page.locator('h1')).toContainText('Collaborative Whiteboard', { timeout: 10000 });

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
    await selectTool(page.getByTestId('toolbar-rectangle'), 'rectangle');
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

test.describe('Stored room view', () => {
  test('the host view is stored and reopened at', async ({ page }) => {
    const roomId = await createRoomWithMaxUsers(page, 'ViewHost', 2);
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();

    await expect
      .poll(async () => page.evaluate(() => !!(window as any).__debugExcalidrawApi), { timeout: 15000 })
      .toBe(true);
    await page.waitForTimeout(400);

    // The host pans and zooms, the way scrolling the canvas would.
    await page.evaluate(() => {
      const api = (window as any).__debugExcalidrawApi;
      api.updateScene({ appState: { scrollX: -320, scrollY: 240, zoom: { value: 1.5 } } });
    });

    await expect
      .poll(
        async () => {
          const response = await page.request.get(appUrl(`/api/whiteboard/room/${roomId}`));
          if (!response.ok()) return null;
          return (await response.json()).viewport ?? null;
        },
        { timeout: 20000, message: 'the room view was never stored' },
      )
      .toMatchObject({ x: -320, y: 240, zoom: 1.5 });

    // Reopening the room lands on that view rather than the origin.
    await page.reload();
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();
    await expect
      .poll(
        async () => page.evaluate(() => {
          const api = (window as any).__debugExcalidrawApi;
          if (!api) return null;
          const state = api.getAppState();
          return { x: state.scrollX, y: state.scrollY, zoom: state.zoom.value };
        }),
        { timeout: 20000, message: 'the board did not reopen at the stored view' },
      )
      .toMatchObject({ x: -320, y: 240, zoom: 1.5 });
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

      // Wait for both peers to be connected and present in rosters
      await waitForProviderConnected(page);
      await waitForProviderConnected(bobPage);
      await waitForPresence(page, 'Bob');
      await waitForPresence(bobPage, 'Alice');

      // Alice draws a rectangle
      const rectIcon = page.getByTestId('toolbar-rectangle');
      await selectTool(rectIcon, 'rectangle');
      await dragOnCanvas(page, { x: 200, y: 200 }, { x: 350, y: 300 });

      // Verify Alice's store has the element
      await expect
        .poll(async () => (await getStoreState(page)).elements?.length ?? 0, { timeout: 15000 })
        .toBeGreaterThanOrEqual(1);

      // Bob should see the element via Yjs sync
      await waitForSync(bobPage, 1, 15000);

      await expect
        .poll(async () => {
          const bobState = await getStoreState(bobPage);
          const remoteRect = bobState.elements?.at(-1);
          return remoteRect?.type === 'rectangle' && remoteRect?.x === 200 && remoteRect?.y === 200;
        }, { timeout: 15000 })
        .toBe(true);
    } finally {
      await bobContext.close();
    }
  });

  test('the host can guide the class through the native Excalidraw follow state', async ({ page, browser }) => {
    await cleanContextAndJoin(page, 'GuideTeacher');
    const roomUrl = page.url();
    const bobContext = await newAuthenticatedContext(browser);
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('GuideStudent');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await approveWaitingPeerIfPresent(page);
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await waitForProviderConnected(page);
      await waitForProviderConnected(bobPage);

      const guideButton = page.getByTestId('whiteboard-tool-guide');
      await expect(guideButton).toHaveAttribute('aria-label', 'Guide class');
      await guideButton.click();
      await expect(guideButton).toHaveAttribute('aria-label', 'Stop guiding');

      await expect
        .poll(
          () => page.evaluate(() => {
            const api = (window as any).__debugExcalidrawApi;
            return Boolean(api?.updateScene && api?.getAppState);
          }),
          { timeout: 15000, message: 'Excalidraw API did not become ready' },
        )
        .toBe(true);

      await page.evaluate(() => {
        (window as any).__debugExcalidrawApi.updateScene({
          appState: { scrollX: -410, scrollY: 275, zoom: { value: 1.35 } },
        });
      });

      await expect
        .poll(
          async () => bobPage.evaluate(() => {
            const state = (window as any).__debugExcalidrawApi?.getAppState?.();
            return state ? { x: state.scrollX, y: state.scrollY, zoom: state.zoom.value } : null;
          }),
          { timeout: 15000, message: 'student never followed the teacher viewport' },
        )
        .toMatchObject({ x: -410, y: 275, zoom: 1.35 });
      await expect
        .poll(() => bobPage.evaluate(() => (window as any).__debugExcalidrawApi.getAppState().userToFollow), {
          timeout: 5000,
          message: 'student did not retain native follow state',
        })
        .toMatchObject({ socketId: expect.any(String) });
      await expect(bobPage.getByText('Following')).toBeVisible({ timeout: 5000 });

      await page.evaluate(() => {
        (window as any).__debugExcalidrawApi.updateScene({
          appState: { scrollX: -260, scrollY: 140, zoom: { value: 1.2 } },
        });
      });
      await expect
        .poll(() => bobPage.evaluate(() => {
          const api = (window as any).__debugExcalidrawApi;
          const state = api?.getAppState?.();
          return state ? { viewport: { x: state.scrollX, y: state.scrollY, zoom: state.zoom.value }, following: state.userToFollow } : null;
        }))
        .toMatchObject({ viewport: { x: -260, y: 140, zoom: 1.2 }, following: { socketId: expect.any(String) } });

      // The native badge close/unfollow is local-only until the next guide session.
      await bobPage.evaluate(() => {
        (window as any).__debugExcalidrawApi.updateScene({ appState: { userToFollow: null } });
      });
      await expect
        .poll(() => bobPage.evaluate(() => (window as any).__debugExcalidrawApi.getAppState().userToFollow))
        .toBeNull();

      await guideButton.click();
      await expect(guideButton).toHaveAttribute('aria-label', 'Guide class');
      await expect
        .poll(() => bobPage.evaluate(() => (window as any).__debugExcalidrawApi.getAppState().userToFollow))
        .toBeNull();

      // A new guide session clears the student's local opt-out.
      await guideButton.click();
      await expect(guideButton).toHaveAttribute('aria-label', 'Stop guiding');
      await page.evaluate(() => {
        (window as any).__debugExcalidrawApi.updateScene({
          appState: { scrollX: -120, scrollY: 80, zoom: { value: 1.1 } },
        });
      });
      await expect
        .poll(() => bobPage.evaluate(() => (window as any).__debugExcalidrawApi.getAppState().userToFollow))
        .toMatchObject({ socketId: expect.any(String), username: 'GuideTeacher' });

      await guideButton.click();
      await expect
        .poll(() => bobPage.evaluate(() => (window as any).__debugExcalidrawApi.getAppState().userToFollow))
        .toBeNull();
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
      await waitForPresence(page, 'Bob');
      await waitForPresence(bobPage, 'Alice');

      // Bob draws a pen stroke
      const penIcon = bobPage.getByTestId('toolbar-freedraw');
      await selectTool(penIcon, 'freedraw');
      await dragOnCanvas(bobPage, { x: 100, y: 100 }, { x: 250, y: 200 });

      await expect
        .poll(async () => (await getStoreState(bobPage)).elements?.length ?? 0, { timeout: 15000 })
        .toBeGreaterThanOrEqual(1);

      // Alice should see the element
      await waitForSync(page, 1, 15000);

      await expect
        .poll(async () => (await getStoreState(page)).elements?.at(-1)?.type, { timeout: 15000 })
        .toBe('freedraw');

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

  test('a freehand stroke reaches the other peer with its points intact', async ({ page, browser }) => {
    /*
     * Every other sync test here draws a rectangle, which carries no `points`.
     * So when strokes began travelling as encoded bytes, nothing noticed that
     * the canvas was being handed an undecoded buffer it cannot draw: a peer's
     * freehand simply never appeared on the other board. This is the only test
     * that would have failed.
     */
    await cleanContextAndJoin(page, 'InkAlice');
    const roomUrl = page.url();

    const bobContext = await newAuthenticatedContext(browser);
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('InkBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await approveWaitingPeerIfPresent(page);
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await waitForProviderConnected(page);
      await waitForProviderConnected(bobPage);
      await waitForPresence(page, 'InkBob');
      await waitForPresence(bobPage, 'Alice');

      await selectTool(bobPage.getByTestId('toolbar-freedraw'), 'freedraw');
      await dragOnCanvas(bobPage, { x: 160, y: 160 }, { x: 360, y: 300 });

      const freedrawOnAlice = () => page.evaluate(() => {
        const api = (window as any).__debugExcalidrawApi;
        const elements = ((api?.getSceneElements?.() ?? []) as any[])
          .filter((e) => e.type === 'freedraw' && !e.isDeleted);
        const first = elements[0];
        return {
          count: elements.length,
          points: Array.isArray(first?.points) ? first.points.length : -1,
        };
      });

      await expect
        .poll(async () => (await freedrawOnAlice()).count, {
          timeout: 25000,
          message: "Bob's freehand stroke never reached Alice",
        })
        .toBeGreaterThanOrEqual(1);

      // Decoded into real coordinates, not handed over as an opaque buffer.
      const arrived = await freedrawOnAlice();
      expect(arrived.points, 'points did not arrive as an array of coordinates')
        .toBeGreaterThan(1);
    } finally {
      await bobContext.close();
    }
  });

  test('a peer can draw while the other is drawing continuously', async ({ page, browser }) => {
    // Two pages, one of them drawing without pause for several seconds. On a
    // loaded runner both are slow enough that the default budgets expire while
    // the work is still legitimately in flight.
    test.slow();
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
      await waitForPresence(page, 'BusyBob');
      await waitForPresence(bobPage, 'Alice');

      await selectTool(page.getByTestId('toolbar-freedraw'), 'freedraw');
      await selectTool(bobPage.getByTestId('toolbar-rectangle'), 'rectangle');

      /*
       * Alice draws continuously until told to stop, rather than for a fixed
       * two seconds. Bob's drag is a synthetic pointer sequence and a loaded
       * runner sometimes swallows one, so he has to be able to retry — and if
       * Alice had already finished by then the test would no longer be
       * exercising the case it exists for.
       */
      const aliceKeepsDrawing = page.evaluate(async () => {
        (window as any).__stopDrawing = false;
        const canvas = document.querySelector('canvas.excalidraw__canvas.interactive') as HTMLElement;
        const box = canvas.getBoundingClientRect();
        const at = (x: number, y: number, type: string) => canvas.dispatchEvent(new PointerEvent(type, {
          clientX: box.left + x, clientY: box.top + y,
          bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
        }));
        const deadline = Date.now() + 30000;
        while (!(window as any).__stopDrawing && Date.now() < deadline) {
          at(60, 60, 'pointerdown');
          for (let i = 0; i < 60 && !(window as any).__stopDrawing; i++) {
            at(60 + i * 2, 60 + (i % 20) * 4, 'pointermove');
            await new Promise((r) => setTimeout(r, 20));
          }
          at(180, 140, 'pointerup');
        }
      });
      const bobRectangles = () => bobPage.evaluate(() => {
        const api = (window as any).__debugExcalidrawApi;
        return ((api?.getSceneElements?.() ?? []) as any[])
          .filter((e) => e.type === 'rectangle' && !e.isDeleted).length;
      });

      /*
       * Bob's shape is created through Excalidraw's own API rather than by
       * synthesising a drag.
       *
       * What this test is about is whether one peer's work reaches another
       * while that other peer draws without pause. Driving it with pointer
       * events made it fail about half the time on a loaded runner — not
       * because sync broke, but because a synthetic drag can be swallowed, and
       * the test then blamed sync for an element that was never created. The
       * publish path is identical either way: updateScene fires onChange, which
       * is what commits to the document.
       */
      const bobDrawsOnce = (async () => {
        await bobPage.waitForTimeout(800);
        await bobPage.evaluate(() => {
          const api = (window as any).__debugExcalidrawApi;
          const existing = api.getSceneElements();
          api.updateScene({
            elements: [
              ...existing,
              {
                id: `bob-rect-${Date.now()}`,
                type: 'rectangle',
                x: 420, y: 320, width: 100, height: 100,
                angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
                fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
                roughness: 1, opacity: 100, groupIds: [], frameId: null,
                roundness: null, seed: 1, version: 1, versionNonce: 1,
                isDeleted: false, boundElements: null, updated: Date.now(),
                link: null, locked: false,
              },
            ],
          });
        });
        await expect
          .poll(bobRectangles, { timeout: 15000, message: 'Bob never got his own rectangle' })
          .toBeGreaterThanOrEqual(1);
      })();

      await bobDrawsOnce;
      await page.evaluate(() => { (window as any).__stopDrawing = true; });
      await aliceKeepsDrawing;

      /*
       * Confirm Bob actually drew before asking whether Alice received it.
       * Under a loaded suite a drag can land before Excalidraw is ready and
       * silently produce nothing, and then this test blames sync for a
       * rectangle that never existed.
       */
      await expect
        .poll(
          () => bobPage.evaluate(() => {
            const api = (window as any).__debugExcalidrawApi;
            return ((api?.getSceneElements?.() ?? []) as any[])
              .filter((e) => e.type === 'rectangle' && !e.isDeleted).length;
          }),
          { timeout: 15000, message: 'Bob never drew a rectangle at all' },
        )
        .toBeGreaterThanOrEqual(1);

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
      await waitForPresence(page, 'SimBob');
      await waitForPresence(bobPage, 'Alice');

      // Alice draws rectangle
      const rectIcon = page.getByTestId('toolbar-rectangle');
      await selectTool(rectIcon, 'rectangle');
      await dragOnCanvas(page, { x: 100, y: 100 }, { x: 200, y: 200 });

      // Bob draws circle
      const circleIcon = bobPage.getByTestId('toolbar-ellipse');
      await selectTool(circleIcon, 'ellipse');
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

      // Both present
      await waitForPresence(page, 'LeftBob');
      await waitForPresence(bobPage, 'LeftAlice');

      // Bob closes his page
      await bobPage.close();

      // Alice should see Bob disappear from presence roster without a fixed sleep
      await expect(
        page.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: 'LeftBob' }),
      ).toHaveCount(0, { timeout: 15000 });
    } finally {
      await bobContext.close();
    }
  });

  test('Bob joins after Alice has drawn, Bob receives all elements', async ({ page, browser }) => {
    await cleanContextAndJoin(page, 'EarlyAlice');
    const roomUrl = page.url();

    // Alice draws multiple elements
    const rectIcon = page.getByTestId('toolbar-rectangle');
    await selectTool(rectIcon, 'rectangle');
    await dragOnCanvas(page, { x: 50, y: 50 }, { x: 150, y: 150 });

    const penIcon = page.getByTestId('toolbar-freedraw');
    await selectTool(penIcon, 'freedraw');
    await dragOnCanvas(page, { x: 200, y: 200 }, { x: 300, y: 300 });

    const circleIcon = page.getByTestId('toolbar-ellipse');
    await selectTool(circleIcon, 'ellipse');
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

  /*
   * The drawing that used to kill the room.
   *
   * A single unbroken curve, held for hundreds of samples, is what a teacher
   * draws over a diagram -- and it is the worst case this whiteboard has.
   * Every sample republishes the element's entire point array, so the document
   * grows with the square of the stroke rather than its length. That is how one
   * room's document passed 4 MiB, at which point every sync frame it sent was
   * refused as oversized and the socket closed, over and over, for as long as
   * anyone had the board open.
   *
   * So this asserts the two things that failure took away. The late peer must
   * receive the stroke, and it must receive all of it: a curve that arrives
   * with a fraction of its points is not the shape that was drawn, and a peer
   * showing a different shape is the same lesson broken more quietly.
   */
  test('a very long curve and a line reach a late peer whole', async ({ page, browser }) => {
    test.setTimeout(180_000);

    await cleanContextAndJoin(page, 'LongAlice');
    const roomUrl = page.url();

    await selectTool(page.getByTestId('toolbar-freedraw'), 'freedraw');
    await dispatchLongStroke(page, 300);

    // Settle before reading: the last samples are still being committed, and a
    // count taken mid-stroke would be compared against a larger one later.
    await expect
      .poll(async () => (await getFreedrawPointCounts(page))[0] ?? 0, { timeout: 30000 })
      .toBeGreaterThan(200);
    const [authorPoints] = await getFreedrawPointCounts(page);

    await selectTool(page.getByTestId('toolbar-line'), 'line');
    await dragOnCanvas(page, { x: 120, y: 520 }, { x: 900, y: 560 });
    await waitForSync(page, 2, 20000);

    const bobContext = await newAuthenticatedContext(browser);
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('LongBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await approveWaitingPeerIfPresent(page);
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await waitForProviderConnected(bobPage);
      await waitForSync(bobPage, 2, 30000);

      // Whole, not truncated: same point count as the peer that drew it.
      await expect
        .poll(async () => (await getFreedrawPointCounts(bobPage))[0] ?? 0, { timeout: 30000 })
        .toBe(authorPoints);

      // And the same board, so the line came across beside the curve.
      expect(await getExcalidrawSceneIds(bobPage)).toEqual(await getExcalidrawSceneIds(page));

      // The socket that carried it is still up. An oversized frame closes it
      // with 1009, and a peer that reconnects into a loop still passes every
      // assertion above on the elements it received before the close.
      await expect
        .poll(async () => (await getCollabState(bobPage)).status, { timeout: 10000 })
        .toMatch(/connected|synced/);
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

    await waitForProviderConnected(page);

    // Elements should still be there after reconnect
    await expect
      .poll(async () => (await getStoreState(page)).elements?.length ?? 0, { timeout: 15000 })
      .toBe(1);
  });

  test('rapid tool switching doesn\'t lose elements', async ({ page }) => {
    await cleanContextAndJoin(page, 'SwitchUser');

    /*
     * Draw with the pen, and insist on it.
     *
     * What this test is about is the switching that follows; the stroke is
     * only setup. Synthetic pointer input at a canvas is unreliable by the
     * admission of the helper above -- a drag that lands while Excalidraw is
     * mid-render produces nothing and says nothing -- so a single attempt made
     * this test fail perhaps one run in four, always at the last assertion and
     * never anywhere near the cause.
     */
    const penIcon = page.getByTestId('toolbar-freedraw');
    await selectTool(penIcon, 'freedraw');
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
      await waitForPresence(page, 'ClearBob');
      await waitForPresence(bobPage, 'Alice');

      // Draw through the real path: writing straight into the legacy store
      // does not reach Excalidraw or Yjs, so it would never sync to Bob.
      await selectTool(page.getByTestId('toolbar-rectangle'), 'rectangle');
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
    const penIcon = page.getByTestId('toolbar-freedraw');
    await selectTool(penIcon, 'freedraw');
    await dragOnCanvas(page, { x: 100, y: 100 }, { x: 200, y: 200 });

    await expect
      .poll(async () => (await getStoreState(page)).elements?.length ?? 0, { timeout: 10000 })
      .toBeGreaterThanOrEqual(1);

    // Now wait for provider to connect — element should sync
    await waitForProviderConnected(page);

    await expect
      .poll(async () => (await getStoreState(page)).elements?.length ?? 0, { timeout: 10000 })
      .toBeGreaterThanOrEqual(1);
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
      await waitForPresence(page, 'UndoBob');
      await waitForPresence(bobPage, 'Alice');

      // Alice adds 3 elements through the Excalidraw scene. Her undo is
      // Excalidraw's own, and remote work never enters it: updates from Bob
      // are applied with CaptureUpdateAction.NEVER.
      const elementIds = ['undo-yjs-1', 'undo-yjs-2', 'undo-yjs-3'];
      for (let i = 0; i < elementIds.length; i += 1) {
        await appendElement(page, excalidrawRectangle(elementIds[i], i * 50, 0, i + 1));
      }

      await expect.poll(() => getExcalidrawSceneIds(page)).toEqual(elementIds);
      await expect.poll(() => getSharedYjsElementIds(page)).toEqual(elementIds);

      // Undo once
      const undoBtn = page.locator('.undo-button-container button');
      await expect(undoBtn).toBeEnabled();
      await undoBtn.click();
      await expect.poll(() => getExcalidrawSceneIds(page)).toEqual(elementIds.slice(0, 2));
      await expect.poll(() => getSharedYjsElementIds(page)).toEqual(elementIds.slice(0, 2));

      // Redo once
      const redoBtn = page.locator('.redo-button-container button');
      await expect(redoBtn).toBeEnabled();
      await redoBtn.click();
      await expect.poll(() => getExcalidrawSceneIds(page)).toEqual(elementIds);
      await expect.poll(() => getSharedYjsElementIds(page)).toEqual(elementIds);
    } finally {
      await bobContext.close();
    }
  });

  test('the title menu opens the library, and shapes put there survive a reload', async ({ page }) => {
    /*
     * The test that was missing.
     *
     * "Add to library" was covered only by a unit test asserting the menu item
     * called its callback -- which proves the button is wired to something and
     * nothing at all about whether a library opens. It did not: the callback
     * asked for a sidebar named "library", and there is no such sidebar. It is
     * a tab of the default one, and asking Excalidraw for a sidebar that does
     * not exist is not an error, so nothing opened and nothing complained.
     *
     * A mock of the thing under test is not a test of it. This drives the menu
     * and then looks at the room.
     */
    await cleanContextAndJoin(page, 'LibraryUser');
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();
    await expect(page.getByTestId('toolbar-selection')).toBeAttached();

    await page.getByTestId('room-title-trigger').click();
    await page.getByTestId('room-menu-library').click();
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.library-menu-items-container')).toBeVisible({ timeout: 10000 });

    // The roster shares that edge, so it folds away rather than covering it.
    await expect(page.getByTestId('whiteboard-presence-panel')).toHaveCount(0);

    /*
     * And a shape put into the library is still there after a reload, which is
     * the half the room owns: Excalidraw announces the change, the room writes
     * it to /library, and the next open reads it back.
     */
    await page.evaluate(async () => {
      const api = (window as any).__debugExcalidrawApi;
      await api.updateLibrary({
        libraryItems: [{
          status: 'unpublished',
          id: 'library-probe',
          created: Date.now(),
          elements: [{
            type: 'rectangle', id: 'library-probe-el', x: 0, y: 0, width: 20, height: 20,
            angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
            fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1,
            opacity: 100, groupIds: [], seed: 1, version: 1, versionNonce: 1,
            isDeleted: false, boundElements: null, updated: 1, link: null,
            locked: false, frameId: null, roundness: null,
          }],
        }],
        merge: true,
      });
    });

    const roomId = roomIdFromPageUrl(page);
    await expect
      .poll(async () => {
        const response = await page.request.get(appUrl(`/api/whiteboard/room/${roomId}/library`));
        if (!response.ok()) return -1;
        const body = await response.json() as { items?: unknown[] };
        return body.items?.length ?? 0;
      }, { timeout: 15000 })
      .toBeGreaterThanOrEqual(1);
  });

  test('the toolbar keys select the tool they name', async ({ page }) => {
    /*
     * Excalidraw's letters, because the toolbar is Excalidraw's. This used to
     * press this application's own set against a rail that no longer exists --
     * and two of those letters never agreed with the editor anyway: C for a
     * circle where it uses O for an ellipse, and S for a sticky note that was
     * only ever a rectangle wearing a different name.
     */
    await cleanContextAndJoin(page, 'ToolUser');
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();
    await expect(page.getByTestId('toolbar-selection')).toBeAttached();
    // Excalidraw answers its shortcuts only while its canvas has the focus,
    // and a fresh join leaves the focus on the document.
    await page.locator('canvas.excalidraw__canvas.interactive').first().click({ position: { x: 200, y: 200 } });

    const tools = [
      { key: 'v', testId: 'toolbar-selection' },
      { key: 'r', testId: 'toolbar-rectangle' },
      { key: 'd', testId: 'toolbar-diamond' },
      { key: 'o', testId: 'toolbar-ellipse' },
      { key: 'a', testId: 'toolbar-arrow' },
      { key: 'l', testId: 'toolbar-line' },
      { key: 'p', testId: 'toolbar-freedraw' },
      { key: 't', testId: 'toolbar-text' },
      { key: 'e', testId: 'toolbar-eraser' },
    ];

    for (const tool of tools) {
      await page.keyboard.press(tool.key);
      // Excalidraw re-renders the whole toolbar on a tool change, and a press
      // landing inside that drops. Pressing straight into the next key failed
      // on a different tool each run, which is what a race looks like.
      await page.waitForTimeout(100);
      // A radio, so the editor's own answer to "which tool is on" is the
      // assertion, rather than a class name this application chose.
      await expect(page.getByTestId(tool.testId)).toBeChecked();
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
      await waitForPresence(page, 'CountBob');
      await waitForPresence(bobPage, 'CountAlice');

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
