import { test, expect, Page } from '@playwright/test';

function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function joinRoom(page: Page, name: string, joinCode?: string) {
  await page.context().addInitScript((n) => {
    localStorage.removeItem('whiteboard_username');
    localStorage.removeItem('whiteboard_user_color');
    // @ts-ignore
    localStorage.setItem('whiteboard_user_color', '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'));
  }, name);

  await page.goto('/whiteboard');
  await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');

  if (joinCode) {
    await page.getByTestId('whiteboard-room-code-input').fill(joinCode);
    await page.getByTestId('whiteboard-join-room-btn').click();
  } else {
    await page.getByTestId('whiteboard-create-room-btn').click();
  }

  await expect(page.getByTestId('whiteboard-username-input')).toBeVisible();
  await page.getByTestId('whiteboard-username-input').fill(name);
  await page.getByTestId('whiteboard-join-room-btn').click();

  await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
}

async function getViewport(page: Page) {
  return await page.evaluate(() => {
    // @ts-ignore
    return window.__whiteboardStore?.getState?.()?.viewport || {};
  });
}

test.describe('Viewport Controls', () => {
  test('zoom in increases zoom level', async ({ page }) => {
    await joinRoom(page, 'ZoomUser');

    const initial = await getViewport(page);
    expect(initial.zoom).toBe(1);

    // Click zoom in button
    const zoomInBtn = page.getByRole('button', { name: '+' });
    await zoomInBtn.click();
    await page.waitForTimeout(300);

    const afterZoomIn = await getViewport(page);
    expect(afterZoomIn.zoom).toBeGreaterThan(initial.zoom);
  });

  test('zoom out decreases zoom level', async ({ page }) => {
    await joinRoom(page, 'ZoomUser');

    const initial = await getViewport(page);
    expect(initial.zoom).toBe(1);

    // Click zoom out button
    const zoomOutBtn = page.getByRole('button', { name: '-' });
    await zoomOutBtn.click();
    await page.waitForTimeout(300);

    const afterZoomOut = await getViewport(page);
    expect(afterZoomOut.zoom).toBeLessThan(initial.zoom);
  });

  test('reset view restores zoom to 1 and center', async ({ page }) => {
    await joinRoom(page, 'ResetUser');

    // Zoom in first using store directly to avoid multiple DOM interactions
    await page.evaluate(() => {
      // @ts-ignore
      const store = window.__whiteboardStore;
      if (store) store.setViewport({ zoom: 2 });
    });
    await page.waitForTimeout(500);

    const afterZoom = await getViewport(page);
    expect(afterZoom.zoom).toBeGreaterThan(1);

    // Reset view
    await page.getByTestId('whiteboard-reset-view-btn').click();
    await page.waitForTimeout(500);

    const afterReset = await getViewport(page);
    expect(afterReset.zoom).toBe(1);
    expect(afterReset.x).toBe(0);
    expect(afterReset.y).toBe(0);
  });

  test('fit to content calculates appropriate zoom', async ({ page }) => {
    await joinRoom(page, 'FitUser');

    // Add an element so fit has content to work with
    await page.evaluate((id) => {
      // @ts-ignore
      const store = window.__whiteboardStore;
      if (store) {
        store.addElement({
          id,
          type: 'rectangle',
          x: 100,
          y: 100,
          width: 200,
          height: 100,
          fill: '#3498db',
          stroke: '#2980b9',
          strokeWidth: 2,
        });
      }
    }, 'fit-test-element-' + Date.now());

    await page.waitForTimeout(500);

    // Click fit button
    const fitBtn = page.getByRole('button', { name: 'Fit' });
    await fitBtn.click();
    await page.waitForTimeout(500);

    const afterFit = await getViewport(page);
    expect(afterFit.zoom).toBeGreaterThan(0);
  });

  test('multiple zoom in/out cycles work correctly', async ({ page }) => {
    await joinRoom(page, 'CycleUser');

    const zoomInBtn = page.getByRole('button', { name: '+' });
    const zoomOutBtn = page.getByRole('button', { name: '-' });

    // Zoom in 5 times
    for (let i = 0; i < 5; i++) {
      await zoomInBtn.click();
      await page.waitForTimeout(100);
    }

    let vp = await getViewport(page);
    expect(vp.zoom).toBeGreaterThan(1);

    // Zoom out 5 times
    for (let i = 0; i < 5; i++) {
      await zoomOutBtn.click();
      await page.waitForTimeout(100);
    }

    vp = await getViewport(page);
    expect(vp.zoom).toBeCloseTo(1, 4);
  });
});
