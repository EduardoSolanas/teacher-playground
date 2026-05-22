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
  }, name);

  await page.goto(appUrl('/whiteboard'));
  await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');
  await page.getByTestId('whiteboard-create-room-btn').click();
  await expect(page.getByTestId('whiteboard-username-input')).toBeVisible();
  await page.getByTestId('whiteboard-username-input').fill(name);
  await page.getByTestId('whiteboard-join-room-btn').click();
  await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
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
  });

  test('undo/redo bar is visible', async ({ page }) => {
    await joinRoom(page, 'UndoUser');
    await expect(page.getByTestId('whiteboard-bottom-controls')).toBeVisible();
  });
});
