import { test, expect } from './fixtures';
import { Page, Locator } from '@playwright/test';
import { newAuthenticatedContext, expandPresenceIfCollapsed, clickCreateRoom } from './helpers';

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

function appUrl(path: string) {
  return new URL(path, process.env.PLAYWRIGHT_BASE_URL).toString();
}

async function joinRoom(page: Page, name: string) {
  await page.context().addInitScript((n) => {
    localStorage.removeItem('whiteboard_username');
    localStorage.removeItem('whiteboard_user_color');
    // @ts-ignore
    localStorage.setItem('whiteboard_user_color', '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'));
    localStorage.setItem('whiteboard_username', n);
  }, name);

  await page.goto(appUrl('/whiteboard'));
  await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');
  await clickCreateRoom(page);
  const canvasArea = page.getByTestId('whiteboard-canvas-area');
  const usernameInput = page.getByTestId('whiteboard-username-input');
  const nextView = await Promise.race([
    canvasArea.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'canvas' as const).catch(() => null),
    usernameInput.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'prompt' as const).catch(() => null),
  ]);
  // The username is pre-seeded in localStorage, so the app may auto-join and
  // unmount the prompt between the race resolving and the fill. actionTimeout
  // defaults to 0 (wait forever), so an unbounded fill on a vanished prompt
  // hangs until the whole test times out. Bound it and skip once the canvas is
  // up: reaching the canvas is what this helper is for.
  if (nextView === 'prompt' && !(await canvasArea.isVisible().catch(() => false))) {
    await usernameInput.fill(name, { timeout: 5000 }).catch(() => {});
    await page.getByTestId('whiteboard-join-room-btn').click({ timeout: 5000 }).catch(() => {});
  }
  await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
}

async function approveWaitingPeer(hostPage: Page, name: string) {
  await expandPresenceIfCollapsed(hostPage);
  const waitingUser = hostPage
    .locator('[data-testid^="whiteboard-user-"]')
    .filter({ hasText: name })
    .filter({ hasText: 'Waiting' })
    .first();
  await expect(waitingUser).toBeVisible({ timeout: 15000 });
  await waitingUser.getByRole('button', { name: 'Let in' }).click();
}

async function joinExistingRoom(page: Page, roomId: string, name: string, hostPage?: Page) {
  await page.context().addInitScript((n) => {
    localStorage.removeItem('whiteboard_username');
    localStorage.removeItem('whiteboard_user_color');
    localStorage.setItem('whiteboard_user_color', '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'));
    localStorage.setItem('whiteboard_username', n);
  }, name);

  await page.goto(`/whiteboard/${roomId}`);
  const canvasArea = page.getByTestId('whiteboard-canvas-area');
  const usernameInput = page.getByTestId('whiteboard-username-input');
  const waitingHeading = page.getByRole('heading', { name: /Room is Full/ });
  const nextView = await Promise.race([
    canvasArea.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'canvas' as const).catch(() => null),
    usernameInput.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'prompt' as const).catch(() => null),
    waitingHeading.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'waiting' as const).catch(() => null),
  ]);
  if (nextView === 'prompt' && !(await canvasArea.isVisible().catch(() => false))) {
    await page.getByTestId('whiteboard-username-input').fill(name, { timeout: 5000 }).catch(() => {});
    await page.getByTestId('whiteboard-join-room-btn').click({ timeout: 5000 }).catch(() => {});
  }

  if (hostPage) {
    await approveWaitingPeer(hostPage, name);
  } else {
    await Promise.race([
      canvasArea.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'canvas' as const).catch(() => null),
      waitingHeading.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'waiting' as const).catch(() => null),
    ]);
  }

  await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
}

async function createRoom(page: Page, name: string) {
  await joinRoom(page, name);
  await expect(page).toHaveURL(/\/whiteboard\/[A-Za-z0-9_-]{8,}(?:\/)?$/);
  const roomId = new URL(page.url()).pathname.split('/').pop()!;
  expect(roomId).not.toBe('_room');
  expect(roomId).not.toBe('undefined');
  return roomId;
}

async function dragInCanvas(
  page: Page,
  points: Array<{ x: number; y: number }>,
  options: { finish?: boolean } = {},
) {
  const canvasArea = page.getByTestId('whiteboard-canvas-area');
  const box = await canvasArea.boundingBox();
  expect(box).not.toBeNull();

  await page.locator('canvas.excalidraw__canvas.interactive').first().waitFor({
    state: 'attached',
    timeout: 15000,
  });
  await page.waitForFunction(() => !!(window as any).__debugExcalidrawApi, {
    timeout: 15000,
  });
  await page.waitForTimeout(250);

  await page.evaluate(
    async ({ originX, originY, points: rel, finish }) => {
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

      const abs = rel.map((point) => ({ x: originX + point.x, y: originY + point.y }));
      const first = abs[0];
      const last = abs[abs.length - 1];
      if (!first || !last) throw new Error('dragInCanvas requires at least one point');

      canvas.dispatchEvent(event('pointerdown', first.x, first.y, 1));
      for (let i = 1; i < abs.length; i++) {
        await nextFrame();
        canvas.dispatchEvent(event('pointermove', abs[i]!.x, abs[i]!.y, 1));
      }
      await nextFrame();
      if (finish) {
        window.dispatchEvent(event('pointerup', last.x, last.y, 0));
      }
    },
    { originX: box!.x, originY: box!.y, points, finish: options.finish !== false },
  );

  if (options.finish !== false) await page.waitForTimeout(150);
}

type SceneElementSummary = {
  id: string;
  type: string;
  points: number | null;
  width: number;
  height: number;
  isDeleted: boolean;
};

async function getSceneElements(page: Page): Promise<SceneElementSummary[]> {
  return page.evaluate(() => {
    const api = (window as any).__debugExcalidrawApi;
    const elements = api?.getSceneElements?.() ?? [];
    return elements.map((element: any) => ({
      id: element.id,
      type: element.type,
      points: Array.isArray(element.points) ? element.points.length : null,
      width: Math.abs(Number(element.width ?? 0)),
      height: Math.abs(Number(element.height ?? 0)),
      isDeleted: Boolean(element.isDeleted),
    }));
  });
}

async function expectCommittedElement(
  page: Page,
  type: string,
  minimumCount: number,
  options: { minPoints?: number; minWidth?: number; minHeight?: number } = {},
) {
  await expect
    .poll(
      async () => {
        const matches = (await getSceneElements(page)).filter((element) => {
          if (element.isDeleted || element.type !== type) return false;
          if (options.minPoints != null && (element.points ?? 0) < options.minPoints) return false;
          if (options.minWidth != null && element.width < options.minWidth) return false;
          if (options.minHeight != null && element.height < options.minHeight) return false;
          return true;
        });
        return matches.length;
      },
      { timeout: 30000 },
    )
    .toBeGreaterThanOrEqual(minimumCount);
}

async function getCanvasInkPixels(page: Page) {
  return page.evaluate(() => {
    const canvasArea = document.querySelector('[data-testid="whiteboard-canvas-area"]');
    if (!canvasArea) return 0;

    let total = 0;
    for (const canvas of canvasArea.querySelectorAll('canvas')) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx || canvas.width === 0 || canvas.height === 0) continue;

      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (alpha > 20 && (r < 245 || g < 245 || b < 245)) {
          total++;
        }
      }
    }
    return total;
  });
}

async function expectCanvasInk(page: Page) {
  await expect
    .poll(() => getCanvasInkPixels(page), { timeout: 30000 })
    .toBeGreaterThan(100);
}

async function getCollaborationState(page: Page) {
  return page.evaluate(() => {
    const collab = (window as any).__whiteboardCollab;
    return {
      status: collab?.status ?? null,
      isConnected: collab?.isConnected ?? null,
      isSynced: collab?.isSynced ?? null,
      providerConnected: collab?.provider?.wsconnected ?? collab?.provider?.connected ?? null,
      providerShouldConnect: collab?.provider?.shouldConnect ?? null,
    };
  });
}

async function expectSameCommittedScene(pageA: Page, pageB: Page) {
  await expect
    .poll(
      async () => {
        const [left, right] = await Promise.all([getSceneElements(pageA), getSceneElements(pageB)]);
        const normalize = (elements: SceneElementSummary[]) =>
          elements
            .filter((element) => !element.isDeleted)
            .map((element) => element.type)
            .sort()
            .join(',');
        return normalize(left) === normalize(right) && normalize(left).length > 0;
      },
      { timeout: 30000 },
    )
    .toBe(true);
}

const EXCALIDRAW_TOOL_BY_TEST_ID: Record<string, string> = {
  'toolbar-selection': 'selection',
  'toolbar-freedraw': 'freedraw',
  'toolbar-rectangle': 'rectangle',
  'toolbar-ellipse': 'ellipse',
  'toolbar-line': 'line',
  'toolbar-arrow': 'arrow',
};

async function selectExcalidrawTool(page: Page, testId: keyof typeof EXCALIDRAW_TOOL_BY_TEST_ID) {
  // Excalidraw's tool is a radio with its own icon drawn over it, so the icon
  // is what a plain click lands on. Forcing dispatches to the control.
  await page.getByTestId(testId).click({ force: true });
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const api = (window as any).__debugExcalidrawApi;
          return api?.getAppState?.().activeTool?.type ?? null;
        }),
      { timeout: 10000 },
    )
    .toBe(EXCALIDRAW_TOOL_BY_TEST_ID[testId]);
}

test.describe('Excalidraw', () => {
  test('whiteboard page loads with Excalidraw canvas', async ({ page }) => {
    await joinRoom(page, 'TestUser');
    await page.waitForTimeout(2000);
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 10000 });
  });

  test('tool buttons are visible in sidebar', async ({ page }) => {
    await joinRoom(page, 'ToolUser');
    await expect(page.getByTestId('toolbar-selection')).toBeVisible();
    await expect(page.getByTestId('toolbar-freedraw')).toBeVisible();
    await expect(page.getByTestId('toolbar-text')).toBeVisible();
    await expect(page.getByTestId('toolbar-rectangle')).toBeVisible();
    await expect(page.getByTestId('toolbar-ellipse')).toBeVisible();
    await expect(page.getByTestId('toolbar-line')).toBeVisible();
    await expect(page.getByTestId('toolbar-arrow')).toBeVisible();
    await expect(page.getByTestId('toolbar-rectangle')).toBeVisible();
    await expect(page.getByTestId('toolbar-eraser')).toBeVisible();
  });

  test('undo/redo bar is visible', async ({ page }) => {
    await joinRoom(page, 'UndoUser');
    await expect(page.locator('.undo-button-container button')).toBeVisible();
  });

  test('select tool is active by default', async ({ page }) => {
    await joinRoom(page, 'SelectUser');
    const selectBtn = page.getByTestId('toolbar-selection');
    await expect(selectBtn).toBeChecked();
  });

  test('clicking a tool highlights it', async ({ page }) => {
    await joinRoom(page, 'ClickTool');
    const penBtn = page.getByTestId('toolbar-freedraw');
    const selectBtn = page.getByTestId('toolbar-selection');

    // Through the helper, which waits for the editor to report the tool rather
    // than for a fixed number of milliseconds: a click that lands before
    // Excalidraw has finished mounting is dropped, and this test runs straight
    // after the join.
    await expect(selectBtn).toBeChecked();
    await selectExcalidrawTool(page, 'toolbar-freedraw');
    await expect(penBtn).toBeChecked();
    await expect(selectBtn).not.toBeChecked();

    const circleBtn = page.getByTestId('toolbar-ellipse');
    await selectExcalidrawTool(page, 'toolbar-ellipse');
    await expect(circleBtn).toBeChecked();
    await expect(penBtn).not.toBeChecked();
  });

  test('canvas has no drawn shapes on fresh room', async ({ page }) => {
    await joinRoom(page, 'EmptyUser');
    await page.waitForTimeout(2000);
    const shapeRects = await page.locator('svg rect[stroke]').count();
    expect(shapeRects).toBe(0);
  });
});

test.describe('Excalidraw Collaboration', () => {
  test.describe.configure({ timeout: 90_000 });
  test('drawings sync in both directions in the same room', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoom(page1, 'BidirectionalA');
    await joinExistingRoom(page2, roomId, 'BidirectionalB', page1);

    await page1.waitForTimeout(3000);
    await page2.waitForTimeout(3000);

    await selectExcalidrawTool(page1, 'toolbar-rectangle');
    await dragInCanvas(page1, [{ x: 420, y: 260 }, { x: 600, y: 400 }]);

    await expectCommittedElement(page1, 'rectangle', 1, { minWidth: 40, minHeight: 40 });
    await expectCommittedElement(page2, 'rectangle', 1, { minWidth: 40, minHeight: 40 });
    await expectCanvasInk(page1);
    await expectCanvasInk(page2);

    await selectExcalidrawTool(page2, 'toolbar-line');
    await dragInCanvas(page2, [{ x: 700, y: 260 }, { x: 700, y: 430 }]);

    await expectCommittedElement(page2, 'line', 1, { minPoints: 2 });
    await expectCommittedElement(page1, 'line', 1, { minPoints: 2 });
    await expectSameCommittedScene(page1, page2);
    await expectCanvasInk(page1);
    await expectCanvasInk(page2);

    await context1.close();
    await context2.close();
  });

  test('drawing a rectangle on one peer appears on the other', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoom(page1, 'PeerA');
    await joinExistingRoom(page2, roomId, 'PeerB', page1);

    await page1.waitForTimeout(3000);
    await page2.waitForTimeout(3000);

    await selectExcalidrawTool(page1, 'toolbar-rectangle');
    await dragInCanvas(page1, [{ x: 420, y: 260 }, { x: 600, y: 400 }]);

    const canvas2 = page2.locator('canvas').first();
    await expect(canvas2).toBeVisible({ timeout: 5000 });
    await expectCommittedElement(page1, 'rectangle', 1, { minWidth: 40, minHeight: 40 });
    await expectCommittedElement(page2, 'rectangle', 1, { minWidth: 40, minHeight: 40 });
    await expectCanvasInk(page1);
    await expectCanvasInk(page2);

    await context1.close();
    await context2.close();
  });

  test('drawing a circle on one peer appears on the other', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoom(page1, 'CirclePeerA');
    await joinExistingRoom(page2, roomId, 'CirclePeerB', page1);

    await page1.waitForTimeout(3000);
    await page2.waitForTimeout(3000);

    await selectExcalidrawTool(page1, 'toolbar-ellipse');
    await dragInCanvas(page1, [{ x: 420, y: 260 }, { x: 600, y: 400 }]);
    await expectCommittedElement(page1, 'ellipse', 1, { minWidth: 40, minHeight: 40 });
    await expectCommittedElement(page2, 'ellipse', 1, { minWidth: 40, minHeight: 40 });
    await expectCanvasInk(page1);
    await expectCanvasInk(page2);

    await context1.close();
    await context2.close();
  });

  test('drawing a pen stroke on one peer appears on the other', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoom(page1, 'PenPeerA');
    await joinExistingRoom(page2, roomId, 'PenPeerB', page1);

    await page1.waitForTimeout(3000);
    await page2.waitForTimeout(3000);

    await selectExcalidrawTool(page1, 'toolbar-freedraw');
    await dragInCanvas(page1, [
      { x: 420, y: 320 },
      { x: 480, y: 280 },
      { x: 560, y: 340 },
      { x: 680, y: 290 },
    ]);
    await expectCommittedElement(page1, 'freedraw', 1, { minPoints: 3 });
    await expectCommittedElement(page2, 'freedraw', 1, { minPoints: 3 });
    await expectCanvasInk(page1);
    await expectCanvasInk(page2);

    await context1.close();
    await context2.close();
  });

  test('tool switch on one peer highlights the correct button locally', async ({ browser }) => {
    const context = await newAuthenticatedContext(browser);
    const page1 = await context.newPage();

    await joinRoom(page1, 'ToolA');

    await page1.waitForTimeout(3000);

    const selectBtn1 = page1.getByTestId('toolbar-selection');
    await expect(selectBtn1).toBeChecked();

    const penBtn1 = page1.getByTestId('toolbar-freedraw');
    await selectTool(penBtn1, 'freedraw');
    await page1.waitForTimeout(500);
    await expect(penBtn1).toBeChecked();
    await expect(selectBtn1).not.toBeChecked();

    await expect(page1.getByTestId('toolbar-freedraw')).toBeChecked();

    await context.close();
  });

  test('presence panel shows at least one user', async ({ browser }) => {
    const context = await newAuthenticatedContext(browser);
    const page1 = await context.newPage();

    await joinRoom(page1, 'PresenceA');

    await page1.waitForTimeout(5000);

    const presenceToggle1 = page1.getByTestId('whiteboard-presence-toggle');
    await expect(presenceToggle1).toBeVisible();

    await context.close();
  });

  test('provider status reflects disconnect and reconnect', async ({ page }) => {
    await joinRoom(page, 'ReconnectStatus');
    await page.waitForTimeout(2000);

    await expect
      .poll(async () => (await getCollaborationState(page)).providerConnected, { timeout: 20000 })
      .toBe(true);

    await page.evaluate(() => {
      (window as any).__whiteboardCollab?.provider?.disconnect();
    });

    await expect
      .poll(async () => await getCollaborationState(page), { timeout: 10000 })
      .toMatchObject({
        status: 'disconnected',
        isConnected: false,
        providerConnected: false,
        providerShouldConnect: false,
      });

    await page.evaluate(() => {
      (window as any).__whiteboardCollab?.provider?.connect();
    });

    await expect
      .poll(async () => (await getCollaborationState(page)).providerConnected, { timeout: 20000 })
      .toBe(true);
  });

  test('disconnected peer catches up from API fallback', async ({ browser }) => {
    const context1 = await newAuthenticatedContext(browser);
    const context2 = await newAuthenticatedContext(browser);

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoom(page1, 'FallbackA');
    await joinExistingRoom(page2, roomId, 'FallbackB', page1);

    await expect
      .poll(async () => (await getCollaborationState(page1)).providerConnected, { timeout: 20000 })
      .toBe(true);
    await expect
      .poll(async () => (await getCollaborationState(page2)).providerConnected, { timeout: 20000 })
      .toBe(true);

    await page2.evaluate(() => {
      (window as any).__whiteboardCollab?.provider?.disconnect();
    });
    await expect
      .poll(async () => (await getCollaborationState(page2)).providerConnected, { timeout: 10000 })
      .toBe(false);

    await selectExcalidrawTool(page1, 'toolbar-freedraw');
    await dragInCanvas(page1, [
      { x: 420, y: 320 },
      { x: 480, y: 280 },
      { x: 560, y: 340 },
      { x: 680, y: 290 },
    ]);

    await expectCommittedElement(page1, 'freedraw', 1, { minPoints: 3 });
    await expectCommittedElement(page2, 'freedraw', 1, { minPoints: 3 });
    await expectCanvasInk(page2);

    await context1.close();
    await context2.close();
  });

  test('pen tool works locally', async ({ page }) => {
    await joinRoom(page, 'PenLocal');
    await page.waitForTimeout(2000);

    await selectExcalidrawTool(page, 'toolbar-freedraw');

    await expect(page.getByTestId('toolbar-freedraw')).toBeChecked();

    await dragInCanvas(page, [
      { x: 420, y: 320 },
      { x: 480, y: 280 },
      { x: 560, y: 340 },
      { x: 680, y: 290 },
    ]);
    await expectCommittedElement(page, 'freedraw', 1, { minPoints: 3 });
  });

  // Was 'pen draws through the first-run empty state hints'. The hint overlay
  // is gone, so there is nothing left to draw through, but what the test
  // actually proved — selecting the pen and dragging produces a freedraw
  // element — is worth keeping on its own.
  test('selecting the pen and dragging produces a freedraw element', async ({ page }) => {
    await joinRoom(page, 'PenHints');
    await page.waitForTimeout(2000);

    await selectExcalidrawTool(page, 'toolbar-freedraw');

    const canvasArea = page.getByTestId('whiteboard-canvas-area');
    const box = await canvasArea.boundingBox();
    expect(box).not.toBeNull();

    await page.mouse.move(box!.x + 350, box!.y + 360);
    await page.mouse.down();
    await page.mouse.move(box!.x + 430, box!.y + 330);
    await page.mouse.move(box!.x + 520, box!.y + 370);
    await page.mouse.move(box!.x + 610, box!.y + 335);
    await page.mouse.up();
    await page.waitForTimeout(1000);

    const freedraw = await page.evaluate(() => {
      const api = (window as any).__debugExcalidrawApi;
      const elements = api?.getSceneElements?.() ?? [];
      return elements.find((element: any) => element.type === 'freedraw');
    });

    expect(freedraw?.points?.length ?? 0).toBeGreaterThan(2);
  });

  test('arrow tool works locally', async ({ page }) => {
    await joinRoom(page, 'ArrowUser');
    await page.waitForTimeout(2000);

    await selectExcalidrawTool(page, 'toolbar-arrow');

    await expect(page.getByTestId('toolbar-arrow')).toBeChecked();

    await dragInCanvas(page, [{ x: 420, y: 320 }, { x: 680, y: 320 }]);
    await expectCommittedElement(page, 'arrow', 1, { minPoints: 2 });
  });
});
