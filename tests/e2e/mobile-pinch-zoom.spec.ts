import { test, expect } from './fixtures';
import type { Browser, Page } from '@playwright/test';
import { newAuthenticatedContext, createRoomWithMaxUsers, liveKitConfigured } from './helpers';

test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

/*
 * A phone has no zoom buttons on the board -- the footer drops them below sm:
 * -- so two fingers are the only way to zoom at all. These drive the real
 * touch pipeline through CDP rather than dispatching PointerEvents, so hit
 * testing, touch-action and pointer capture all take part as they do on a
 * device.
 */

async function phonePage(browser: Browser, subject: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const base = await newAuthenticatedContext(browser, subject);
  const storageState = await base.storageState();
  await base.close();
  const context = await browser.newContext({
    storageState,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

async function boardZoom(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const api = (window as any).__debugExcalidrawApi;
    return api ? api.getAppState().zoom.value : null;
  });
}

async function pinchOut(page: Page, centre: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  const points = (spread: number) => [
    { x: centre.x - spread, y: centre.y, id: 1 },
    { x: centre.x + spread, y: centre.y, id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points(30)[0]] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(30) });
  for (let spread = 36; spread <= 120; spread += 6) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(spread) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test.describe('board on a phone', () => {
  test('two fingers spreading apart zoom the board in', async ({ browser }) => {
    const { page, close } = await phonePage(browser, `pinch-${Date.now()}`);
    try {
      await createRoomWithMaxUsers(page, 'PinchHost', 1);
      await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();
      await expect.poll(() => boardZoom(page), { timeout: 15000 }).toBe(1);

      await pinchOut(page, { x: 195, y: 560 });

      await expect.poll(() => boardZoom(page)).toBeGreaterThan(1.5);
    } finally {
      await close();
    }
  });

  test('pinching still zooms with the call live and the pencil in hand', async ({ browser }) => {
    const { page, close } = await phonePage(browser, `pinch-call-${Date.now()}`);
    try {
      const roomId = await createRoomWithMaxUsers(page, 'PinchHost', 1);
      test.skip(!(await liveKitConfigured(page, roomId)), 'LiveKit is not configured in this E2E environment.');
      await expect.poll(() => boardZoom(page), { timeout: 15000 }).toBe(1);

      await page.getByTestId('av-start-call').click();
      await expect(page.getByTestId('av-toggle-mic')).toBeVisible({ timeout: 15000 });
      await page.evaluate(() => (window as any).__debugExcalidrawApi.setActiveTool({ type: 'freedraw' }));

      await pinchOut(page, { x: 195, y: 640 });

      await expect.poll(() => boardZoom(page)).toBeGreaterThan(1.5);
    } finally {
      await close();
    }
  });

  test('the room keeps a pinch for the board rather than for zooming the page', async ({ browser }) => {
    /*
     * iOS browsers other than Safari are WKWebViews, which honour the viewport
     * scale limits. On a page that can be zoomed, the web view's own pinch
     * recogniser claims two fingers and cancels the pointers before the canvas
     * sees a gesture -- so nothing zooms at all. Excalidraw's own app pins the
     * scale for exactly this; the board has its own zoom to stand in for it.
     * Only the room: the rooms list is a document and stays zoomable.
     */
    const { page, close } = await phonePage(browser, `pinch-viewport-${Date.now()}`);
    const viewportMeta = () => page.locator('meta[name="viewport"]').getAttribute('content');
    try {
      await createRoomWithMaxUsers(page, 'PinchHost', 1);
      await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();
      const room = await viewportMeta();
      expect(room).toContain('maximum-scale=1');
      expect(room).toContain('user-scalable=no');
      expect(room).toContain('viewport-fit=cover');

      await page.goto(new URL('/whiteboard', process.env.PLAYWRIGHT_BASE_URL).toString());
      await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');
      const list = await viewportMeta();
      expect(list).not.toContain('user-scalable=no');
      expect(list).not.toContain('maximum-scale');
    } finally {
      await close();
    }
  });
});

