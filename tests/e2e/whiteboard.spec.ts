import { test, expect, Page, Browser } from '@playwright/test';

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
  await page.context().addInitScript((n) => {
    localStorage.removeItem('whiteboard_username');
    localStorage.removeItem('whiteboard_user_color');
    // @ts-ignore
    localStorage.setItem('whiteboard_user_color', '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'));
  }, name);

  await page.goto(appUrl('/whiteboard'));
  await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');

  if (joinCode) {
    await page.getByTestId('whiteboard-room-code-input').fill(joinCode);
    await page.getByTestId('whiteboard-join-room-btn').click();
  } else {
    await page.getByTestId('whiteboard-create-room-btn').click();
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
  ).toBeGreaterThanOrEqual(expectedElements);
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

async function dragOnCanvas(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const canvas = page.getByTestId('whiteboard-canvas-area');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + from.x, box!.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box!.x + to.x, box!.y + to.y, { steps: 10 });
  await page.mouse.up();
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
          maxUsers: 3,
          hostPeerId: 'test-host',
        }),
      });
    });

    await page.goto(appUrl('/whiteboard'));
    await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');

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

  test('user name persists across page navigation', async ({ page }) => {
    await cleanContextAndJoin(page, 'PersistentUser');
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();

    // Navigate away and back
    await page.goto(appUrl('/whiteboard'));
    await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');

    // Create a new room — the prompt should be pre-filled
    await page.getByTestId('whiteboard-create-room-btn').click();
    await expect(page.getByTestId('whiteboard-username-input')).toBeVisible();
    const inputValue = await page.getByTestId('whiteboard-username-input').inputValue();
    expect(inputValue).toBe('PersistentUser');
  });

  test('page refresh preserves whiteboard state', async ({ page }) => {
    await cleanContextAndJoin(page, 'Refresher');
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();

    // Add an element
    await addElement(page, {
      id: generateId(),
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      fill: '#3498db',
      stroke: '#2980b9',
      strokeWidth: 2,
    });

    const stateBefore = await getStoreState(page);
    expect(stateBefore.elements?.length).toBe(1);

    // Refresh the page
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

    // After refresh, the prompt should show pre-filled name
    const promptVisible = await page.getByTestId('whiteboard-username-input').isVisible();
    if (promptVisible) {
      await page.getByTestId('whiteboard-username-input').fill('Refresher');
      await page.getByTestId('whiteboard-join-room-btn').click();
    }

    // Elements should be loaded from API
    const stateAfter = await getStoreState(page);
    expect(stateAfter.elements?.length).toBeGreaterThanOrEqual(1);
  });

  test('connection status transitions from connecting to connected', async ({ page }) => {
    await cleanContextAndJoin(page, 'StatusUser');

    // Initially status should be 'connecting' or 'connected'
    const collab1 = await getCollabState(page);
    expect(['connecting', 'connected', 'synced'].includes(collab1.status)).toBeTruthy();

    // After some time, should be connected or synced
    await page.waitForTimeout(3000);
    const collab2 = await getCollabState(page);
    expect(['connected', 'synced'].includes(collab2.status)).toBeTruthy();
  });

  test('navigating to non-existent room shows whiteboard anyway', async ({ page }) => {
    await cleanContextAndJoin(page, 'NavUser');
    const roomId = page.url().split('/whiteboard/')[1];

    // Navigate to a fresh room ID that doesn't exist in DB
    await page.goto(`/whiteboard/FAKENONEXIST${Date.now()}`);
    await expect(page.getByTestId('whiteboard-username-input')).toBeVisible();
    await page.getByTestId('whiteboard-username-input').fill('NavUser');
    await page.getByTestId('whiteboard-join-room-btn').click();

    // Should still show whiteboard (Yjs handles new rooms)
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await waitForPresence(page, 'NavUser');
  });
});

test.describe('Multi-Peer Sync', () => {
  test('Alice draws rectangle, Bob sees it via Yjs WebRTC', async ({ page, browser }) => {
    // Alice creates room
    await cleanContextAndJoin(page, 'Alice');
    const roomUrl = page.url();
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();

    // Bob joins in separate browser context (simulates different browser/process)
    const bobContext = await browser.newContext();
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
    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('BobDrawer');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await waitForProviderConnected(page);
      await waitForProviderConnected(bobPage);
      await page.waitForTimeout(2000);

      // Bob draws a pen stroke
      const penIcon = bobPage.getByTestId('whiteboard-tool-pen');
      await penIcon.click();
      await dragOnCanvas(bobPage, { x: 100, y: 100 }, { x: 250, y: 200 });

      // Alice should see the element
      await waitForSync(page, 1, 15000);

      const aliceState = await getStoreState(page);
      const remotePen = aliceState.elements?.at(-1);
      expect(remotePen?.type).toBe('pen');
      expect(remotePen?.points?.length).toBeGreaterThan(1);
    } finally {
      await bobContext.close();
    }
  });

  test('both peers draw simultaneously, both see each other', async ({ page, browser }) => {
      await cleanContextAndJoin(page, 'SimAlice');
    const roomUrl = page.url();

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('SimBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
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
      expect(aliceState.elements?.length).toBe(2);
      expect(bobState.elements?.length).toBe(2);

      // Verify element types
      const aliceTypes = aliceState.elements?.map((e: any) => e.type).sort();
      const bobTypes = bobState.elements?.map((e: any) => e.type).sort();
      expect(aliceTypes).toEqual(['circle', 'rectangle']);
      expect(bobTypes).toEqual(['circle', 'rectangle']);
    } finally {
      await bobContext.close();
    }
  });

  test('Bob leaves, Alice sees user count drop', async ({ page, browser }) => {
    await cleanContextAndJoin(page, 'LeftAlice');
    const roomUrl = page.url();

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('LeftBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
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

    await page.waitForTimeout(1000);
    const aliceState = await getStoreState(page);
    expect(aliceState.elements?.length).toBeGreaterThanOrEqual(3);

    // Bob joins late
    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('LateBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
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

    const state = await getStoreState(page);
    expect(state.elements?.length).toBeGreaterThanOrEqual(1);
    expect(state.tool).toBe('pen');
  });

  test('clearing board removes all elements and syncs', async ({ page, browser }) => {
    await cleanContextAndJoin(page, 'ClearAlice');
    const roomUrl = page.url();

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('ClearBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await waitForProviderConnected(page);
      await waitForProviderConnected(bobPage);
      await page.waitForTimeout(2000);

      // Add elements
      await addElement(page, {
        id: generateId(),
        type: 'pen',
        points: [{ x: 0, y: 0 }, { x: 50, y: 50 }],
        color: '#000000',
        strokeWidth: 2,
      });
      await waitForSync(bobPage, 1, 10000);

      // Alice clears board
      await page.getByTestId('whiteboard-clear-btn').click();
      await expect(page.getByTestId('whiteboard-clear-confirm-btn')).toBeVisible();
      await page.getByTestId('whiteboard-clear-confirm-btn').click();
      await page.waitForTimeout(500);

      // Alice's board is empty
      const aliceState = await getStoreState(page);
      expect(aliceState.elements?.length).toBe(0);

      // Bob should also see empty board (Yjs sync deletes elements)
      await waitForSync(bobPage, 0, 10000);
      const bobState = await getStoreState(bobPage);
      expect(bobState.elements?.length).toBe(0);
    } finally {
      await bobContext.close();
    }
  });

  test('viewport changes sync between peers', async ({ page, browser }) => {
    await cleanContextAndJoin(page, 'VPAlice');
    const roomUrl = page.url();

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('VPBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await waitForProviderConnected(page);
      await waitForProviderConnected(bobPage);
      await page.waitForTimeout(2000);

      // Alice zooms in
      const initialZoom = (await getStoreState(page)).viewport?.zoom || 1;
      await page.evaluate((z) => {
        // @ts-ignore
        const store = window.__whiteboardStore;
        if (store) store.setViewport({ x: 0, y: 0, zoom: z + 0.5 });
      }, initialZoom);

      await page.waitForTimeout(1000);

      // Bob should see the zoom change
      const bobState = await getStoreState(bobPage);
      expect(bobState.viewport?.zoom).toBeGreaterThan(initialZoom);
    } finally {
      await bobContext.close();
    }
  });
});

test.describe('Edge Cases', () => {
  test('creating many rooms in succession works', async ({ page }) => {
    for (let i = 0; i < 5; i++) {
      await cleanContextAndJoin(page, `User${i}`);
      await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(500);
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

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('UndoBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
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

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    try {
      await bobContext.addInitScript(() => {
        localStorage.removeItem('whiteboard_username');
        localStorage.removeItem('whiteboard_user_color');
      });
      await bobPage.goto(roomUrl);
      await bobPage.getByTestId('whiteboard-username-input').fill('CountBob');
      await bobPage.getByTestId('whiteboard-join-room-btn').click();
      await expect(bobPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      await waitForProviderConnected(page);
      await waitForProviderConnected(bobPage);
      await page.waitForTimeout(3000);

      // Both should show "2/X users online"
      await expect(page.getByTestId('whiteboard-presence-toggle')).toContainText('2/');
      await expect(bobPage.getByTestId('whiteboard-presence-toggle')).toContainText('2/');
    } finally {
      await bobContext.close();
    }
  });
});
