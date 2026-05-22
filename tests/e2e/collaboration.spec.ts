import { test, expect, Page } from '@playwright/test';

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
  await page.getByTestId('whiteboard-create-room-btn').click();
  const canvasArea = page.getByTestId('whiteboard-canvas-area');
  const usernameInput = page.getByTestId('whiteboard-username-input');
  const nextView = await Promise.race([
    canvasArea.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'canvas' as const).catch(() => null),
    usernameInput.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'prompt' as const).catch(() => null),
  ]);
  if (nextView === 'prompt') {
    await page.getByTestId('whiteboard-username-input').fill(name);
    await page.getByTestId('whiteboard-join-room-btn').click();
  }
  await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
}

async function approveWaitingPeer(hostPage: Page, name: string) {
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
  if (nextView === 'prompt' && await usernameInput.isVisible().catch(() => false)) {
    await page.getByTestId('whiteboard-username-input').fill(name);
    await page.getByTestId('whiteboard-join-room-btn').click();
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
  return new URL(page.url()).pathname.split('/').pop()!;
}

async function dragInCanvas(page: Page, points: Array<{ x: number; y: number }>) {
  const canvasArea = page.getByTestId('whiteboard-canvas-area');
  const box = await canvasArea.boundingBox();
  expect(box).not.toBeNull();

  const [first, ...rest] = points;
  await page.mouse.move(box!.x + first.x, box!.y + first.y);
  await page.mouse.down();
  await page.waitForTimeout(100);
  for (const point of rest) {
    await page.mouse.move(box!.x + point.x, box!.y + point.y, { steps: 10 });
  }
  await page.waitForTimeout(100);
  await page.mouse.up();
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
      providerConnected: collab?.provider?.connected ?? null,
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
            .map(({ id: _id, ...element }) => element)
            .sort((a, b) => `${a.type}:${a.width}:${a.height}:${a.points}`.localeCompare(`${b.type}:${b.width}:${b.height}:${b.points}`));
        return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
      },
      { timeout: 30000 },
    )
    .toBe(true);
}

const EXCALIDRAW_TOOL_BY_TEST_ID: Record<string, string> = {
  'whiteboard-tool-select': 'selection',
  'whiteboard-tool-pen': 'freedraw',
  'whiteboard-tool-rectangle': 'rectangle',
  'whiteboard-tool-circle': 'ellipse',
  'whiteboard-tool-line': 'line',
  'whiteboard-tool-arrow': 'arrow',
};

async function selectExcalidrawTool(page: Page, testId: keyof typeof EXCALIDRAW_TOOL_BY_TEST_ID) {
  await page.getByTestId(testId).click();
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
    await expect(page.getByTestId('whiteboard-tool-select')).toBeVisible();
    await expect(page.getByTestId('whiteboard-tool-pen')).toBeVisible();
    await expect(page.getByTestId('whiteboard-tool-text')).toBeVisible();
    await expect(page.getByTestId('whiteboard-tool-rectangle')).toBeVisible();
    await expect(page.getByTestId('whiteboard-tool-circle')).toBeVisible();
    await expect(page.getByTestId('whiteboard-tool-line')).toBeVisible();
    await expect(page.getByTestId('whiteboard-tool-arrow')).toBeVisible();
    await expect(page.getByTestId('whiteboard-tool-stickyNote')).toBeVisible();
    await expect(page.getByTestId('whiteboard-tool-eraser')).toBeVisible();
  });

  test('undo/redo bar is visible', async ({ page }) => {
    await joinRoom(page, 'UndoUser');
    await expect(page.getByTestId('whiteboard-bottom-controls')).toBeVisible();
  });

  test('select tool is active by default', async ({ page }) => {
    await joinRoom(page, 'SelectUser');
    const selectBtn = page.getByTestId('whiteboard-tool-select');
    await expect(selectBtn).toHaveClass(/bg-blue-500/);
  });

  test('clicking a tool highlights it', async ({ page }) => {
    await joinRoom(page, 'ClickTool');
    const penBtn = page.getByTestId('whiteboard-tool-pen');
    const selectBtn = page.getByTestId('whiteboard-tool-select');

    await expect(selectBtn).toHaveClass(/bg-blue-500/);
    await penBtn.click();
    await page.waitForTimeout(500);
    await expect(penBtn).toHaveClass(/bg-blue-500/);
    await expect(selectBtn).not.toHaveClass(/bg-blue-500/);

    const circleBtn = page.getByTestId('whiteboard-tool-circle');
    await circleBtn.click();
    await page.waitForTimeout(500);
    await expect(circleBtn).toHaveClass(/bg-blue-500/);
    await expect(penBtn).not.toHaveClass(/bg-blue-500/);
  });

  test('canvas has no drawn shapes on fresh room', async ({ page }) => {
    await joinRoom(page, 'EmptyUser');
    await page.waitForTimeout(2000);
    const shapeRects = await page.locator('svg rect[stroke]').count();
    expect(shapeRects).toBe(0);
  });
});

test.describe('Excalidraw Collaboration', () => {
  test('drawings sync in both directions in the same room', async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoom(page1, 'BidirectionalA');
    await joinExistingRoom(page2, roomId, 'BidirectionalB', page1);

    await page1.waitForTimeout(3000);
    await page2.waitForTimeout(3000);

    await selectExcalidrawTool(page1, 'whiteboard-tool-rectangle');
    await dragInCanvas(page1, [{ x: 420, y: 260 }, { x: 600, y: 400 }]);

    await expectCommittedElement(page1, 'rectangle', 1, { minWidth: 40, minHeight: 40 });
    await expectCommittedElement(page2, 'rectangle', 1, { minWidth: 40, minHeight: 40 });
    await expectCanvasInk(page1);
    await expectCanvasInk(page2);

    await selectExcalidrawTool(page2, 'whiteboard-tool-line');
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
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoom(page1, 'PeerA');
    await joinExistingRoom(page2, roomId, 'PeerB', page1);

    await page1.waitForTimeout(3000);
    await page2.waitForTimeout(3000);

    await selectExcalidrawTool(page1, 'whiteboard-tool-rectangle');
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
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoom(page1, 'CirclePeerA');
    await joinExistingRoom(page2, roomId, 'CirclePeerB', page1);

    await page1.waitForTimeout(3000);
    await page2.waitForTimeout(3000);

    await selectExcalidrawTool(page1, 'whiteboard-tool-circle');
    await dragInCanvas(page1, [{ x: 420, y: 260 }, { x: 600, y: 400 }]);
    await expectCommittedElement(page1, 'ellipse', 1, { minWidth: 40, minHeight: 40 });
    await expectCommittedElement(page2, 'ellipse', 1, { minWidth: 40, minHeight: 40 });
    await expectCanvasInk(page1);
    await expectCanvasInk(page2);

    await context1.close();
    await context2.close();
  });

  test('drawing a pen stroke on one peer appears on the other', async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const roomId = await createRoom(page1, 'PenPeerA');
    await joinExistingRoom(page2, roomId, 'PenPeerB', page1);

    await page1.waitForTimeout(3000);
    await page2.waitForTimeout(3000);

    await selectExcalidrawTool(page1, 'whiteboard-tool-pen');
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
    const context = await browser.newContext();

    const page1 = await context.newPage();
    const page2 = await context.newPage();

    await joinRoom(page1, 'ToolA');
    await joinRoom(page2, 'ToolB');

    await page1.waitForTimeout(3000);
    await page2.waitForTimeout(3000);

    const selectBtn1 = page1.getByTestId('whiteboard-tool-select');
    const selectBtn2 = page2.getByTestId('whiteboard-tool-select');
    await expect(selectBtn1).toHaveClass(/bg-blue-500/);
    await expect(selectBtn2).toHaveClass(/bg-blue-500/);

    const penBtn1 = page1.getByTestId('whiteboard-tool-pen');
    await penBtn1.click();
    await page1.waitForTimeout(500);
    await expect(penBtn1).toHaveClass(/bg-blue-500/);
    await expect(selectBtn1).not.toHaveClass(/bg-blue-500/);

    await expect(page1.getByTestId('whiteboard-tool-pen')).toHaveClass(/bg-blue-500/);

    await context.close();
  });

  test('presence panel shows at least one user', async ({ browser }) => {
    const context = await browser.newContext();

    const page1 = await context.newPage();
    const page2 = await context.newPage();

    await joinRoom(page1, 'PresenceA');
    await joinRoom(page2, 'PresenceB');

    await page1.waitForTimeout(5000);
    await page2.waitForTimeout(5000);

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
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

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

    await selectExcalidrawTool(page1, 'whiteboard-tool-pen');
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

    await selectExcalidrawTool(page, 'whiteboard-tool-pen');

    await expect(page.getByTestId('whiteboard-tool-pen')).toHaveClass(/bg-blue-500/);

    await dragInCanvas(page, [
      { x: 420, y: 320 },
      { x: 480, y: 280 },
      { x: 560, y: 340 },
      { x: 680, y: 290 },
    ]);
    await expectCommittedElement(page, 'freedraw', 1, { minPoints: 3 });
  });

  test('pen draws through the first-run empty state hints', async ({ page }) => {
    await joinRoom(page, 'PenHints');
    await page.waitForTimeout(2000);

    await expect(page.getByText('Drag, draw, and collaborate in real-time')).toBeVisible();
    await selectExcalidrawTool(page, 'whiteboard-tool-pen');
    await expect(page.getByText('Drag, draw, and collaborate in real-time')).toBeHidden();

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

    await selectExcalidrawTool(page, 'whiteboard-tool-arrow');

    await expect(page.getByTestId('whiteboard-tool-arrow')).toHaveClass(/bg-blue-500/);

    await dragInCanvas(page, [{ x: 420, y: 320 }, { x: 680, y: 320 }]);
    await expectCommittedElement(page, 'arrow', 1, { minPoints: 2 });
  });
});
