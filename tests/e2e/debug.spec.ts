import { test, expect } from '@playwright/test';

function appUrl(path: string) {
  return new URL(path, process.env.PLAYWRIGHT_BASE_URL).toString();
}

test.skip('debug: check Konva events from Playwright', async ({ page }) => {
  await page.goto(appUrl('/whiteboard'));
  await page.getByTestId('whiteboard-create-room-btn').click();
  await page.getByTestId('whiteboard-username-input').fill('TestUser');
  await page.getByTestId('whiteboard-join-room-btn').click();
  await expect(page.getByTestId('whiteboard-palette')).toBeVisible();

  // Inject a handler on the Konva stage to log events
  await page.evaluate(() => {
    // @ts-ignore
    window.__debugEvents = [];
    
    // Watch for any mousedown on canvas
    const canvas = document.querySelector('canvas');
    if (canvas) {
      canvas.addEventListener('mousedown', (e: any) => {
        // @ts-ignore
        window.__debugEvents.push(`dom-mousedown: clientX=${(e as MouseEvent).clientX} clientY=${(e as MouseEvent).clientY}`);
      });
    }
  });

  // Click on canvas
  const canvas = page.getByTestId('whiteboard-canvas-area');
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
  }

  await page.waitForTimeout(500);

  // Read logged events
  const events = await page.evaluate(() => {
    // @ts-ignore
    return window.__debugEvents || [];
  });
  
  console.log('DOM events captured:', events);

  // Check store state
  const elements = await page.evaluate(() => {
    // @ts-ignore
    const state = window.__whiteboardStore?.getState?.() || {};
    return state.elements;
  });
  console.log('Store elements:', JSON.stringify(elements));

  // Check what tool is active
  const tool = await page.evaluate(() => {
    // @ts-ignore
    const state = window.__whiteboardStore?.getState?.() || {};
    return state.tool;
  });
  console.log('Active tool:', tool);
});
