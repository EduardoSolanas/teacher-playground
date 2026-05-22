import { test, expect, Page } from '@playwright/test';

function appUrl(path: string) {
  return new URL(path, process.env.PLAYWRIGHT_BASE_URL).toString();
}

async function joinRoom(page: Page, name: string) {
  await page.context().addInitScript((n) => {
    localStorage.removeItem('whiteboard_username');
    localStorage.removeItem('whiteboard_user_color');
    localStorage.setItem('whiteboard_user_color', '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'));
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
    await usernameInput.fill(name);
    await page.getByTestId('whiteboard-join-room-btn').click();
  }
  await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
}

async function getStoreState(page: Page) {
  return await page.evaluate(() => {
    return (window as any).__whiteboardStore?.getState?.() || {};
  });
}

test.describe('Clear Board Modal', () => {
  test('clear board button is visible in bottom controls', async ({ page }) => {
    await joinRoom(page, 'ClearVisible');
    await page.waitForTimeout(2000);
    await expect(page.getByTestId('whiteboard-clear-btn')).toBeVisible();
  });

  test('clear board button opens the confirmation modal', async ({ page }) => {
    await joinRoom(page, 'ClearOpen');
    await page.waitForTimeout(2000);
    await page.getByTestId('whiteboard-clear-btn').click();
    await expect(page.getByTestId('whiteboard-clear-confirm-btn')).toBeVisible();
    await expect(page.getByTestId('whiteboard-clear-cancel-btn')).toBeVisible();
  });

  test('cancel button closes the clear board modal', async ({ page }) => {
    await joinRoom(page, 'ClearCancel');
    await page.waitForTimeout(2000);
    await page.getByTestId('whiteboard-clear-btn').click();
    await expect(page.getByTestId('whiteboard-clear-confirm-btn')).toBeVisible();
    await page.getByTestId('whiteboard-clear-cancel-btn').click();
    await expect(page.getByTestId('whiteboard-clear-confirm-btn')).toHaveCount(0);
  });

  test('clear board removes all elements from the store', async ({ page }) => {
    await joinRoom(page, 'ClearConfirm');
    await page.waitForTimeout(2000);

    // Add an element
    await page.evaluate(() => {
      const store = (window as any).__whiteboardStore;
      if (store) store.addElement({ id: 'test-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, fill: '#000', stroke: '#000', strokeWidth: 2 });
    });
    let state = await getStoreState(page);
    expect(state.elements?.length).toBe(1);

    // Clear board via modal
    await page.getByTestId('whiteboard-clear-btn').click();
    await expect(page.getByTestId('whiteboard-clear-confirm-btn')).toBeVisible();
    await page.getByTestId('whiteboard-clear-confirm-btn').click();
    await page.waitForTimeout(500);

    state = await getStoreState(page);
    expect(state.elements?.length).toBe(0);
  });
});

test.describe('Empty State', () => {
  test('empty state hints are visible on fresh whiteboard with select tool', async ({ page }) => {
    await joinRoom(page, 'EmptyUser');
    await page.waitForTimeout(2000);
    await expect(page.getByText('Drag, draw, and collaborate in real-time')).toBeVisible();
  });

  test('dismiss button hides the empty state hints', async ({ page }) => {
    await joinRoom(page, 'DismissUser');
    await page.waitForTimeout(2000);
    await expect(page.getByText('Drag, draw, and collaborate in real-time')).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByText('Drag, draw, and collaborate in real-time')).toBeHidden();
  });

  test('empty state is hidden after switching tool away from select', async ({ page }) => {
    await joinRoom(page, 'ToolSwitchEmpty');
    await page.waitForTimeout(2000);
    await expect(page.getByText('Drag, draw, and collaborate in real-time')).toBeVisible();
    await page.getByTestId('whiteboard-tool-pen').click();
    await page.waitForTimeout(500);
    await expect(page.getByText('Drag, draw, and collaborate in real-time')).toBeHidden();
  });
});

test.describe('Undo/Redo Bar', () => {
  test('undo button is visible', async ({ page }) => {
    await joinRoom(page, 'UndoVisible');
    await page.waitForTimeout(2000);
    await expect(page.getByTestId('whiteboard-undo-btn')).toBeVisible();
  });

  test('redo button is visible', async ({ page }) => {
    await joinRoom(page, 'RedoVisible');
    await page.waitForTimeout(2000);
    await expect(page.getByTestId('whiteboard-redo-btn')).toBeVisible();
  });

  test('undo and redo buttons are disabled initially', async ({ page }) => {
    await joinRoom(page, 'InitUndo');
    await page.waitForTimeout(2000);
    await expect(page.getByTestId('whiteboard-undo-btn')).toBeDisabled();
    await expect(page.getByTestId('whiteboard-redo-btn')).toBeDisabled();
  });

  test('undo is enabled after adding an element', async ({ page }) => {
    await joinRoom(page, 'AddUndo');
    await page.waitForTimeout(2000);

    await page.evaluate(() => {
      const store = (window as any).__whiteboardStore;
      if (store) store.addElement({ id: 'undo-test', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, fill: '#000', stroke: '#000', strokeWidth: 2 });
    });
    await page.waitForTimeout(300);

    await expect(page.getByTestId('whiteboard-undo-btn')).toBeEnabled();
  });
});