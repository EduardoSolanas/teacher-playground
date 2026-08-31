import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import {
  appendElement,
  clickCreateRoom,
  excalidrawRectangle,
  waitForExcalidrawApi,
} from './helpers';

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
  await clickCreateRoom(page);
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

test.describe('Room chrome', () => {
  test('the profile control is clickable while the participants panel is open', async ({ page }) => {
    /*
     * Asked by hit test rather than by visibility, because visibility was
     * never the problem.
     *
     * The panel is fixed at z-index 1200 and the top bar at 1100, and the
     * panel used to start at the top of the viewport -- so it ran the full
     * height of the screen across the bar and took the corner the profile
     * control sits in. The control was in the document, and `toBeVisible`
     * would have said so; it was simply underneath something. What a person
     * cares about is whether a click lands on it, which is what
     * elementFromPoint answers.
     */
    await joinRoom(page, 'ChromeHost');
    await waitForExcalidrawApi(page);
    await expect(page.locator('#whiteboard-presence-panel')).toBeVisible({ timeout: 15000 });

    const profile = page.getByTestId('whiteboard-profile-btn');
    const box = await profile.boundingBox();
    expect(box).not.toBeNull();

    const hit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return element?.closest('[data-testid="whiteboard-room-top-nav"]') !== null;
    }, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
    expect(hit).toBe(true);
  });
});

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

test.describe('Undo/Redo Bar', () => {
  test('undo button is visible', async ({ page }) => {
    await joinRoom(page, 'UndoVisible');
    await page.waitForTimeout(2000);
    await expect(page.locator('.undo-button-container button')).toBeVisible();
  });

  test('redo button is visible', async ({ page }) => {
    await joinRoom(page, 'RedoVisible');
    await page.waitForTimeout(2000);
    await expect(page.locator('.redo-button-container button')).toBeVisible();
  });

  test('undo and redo buttons are disabled initially', async ({ page }) => {
    await joinRoom(page, 'InitUndo');
    await page.waitForTimeout(2000);
    await expect(page.locator('.undo-button-container button')).toBeDisabled();
    await expect(page.locator('.redo-button-container button')).toBeDisabled();
  });

  test('undo is enabled after adding an element', async ({ page }) => {
    await joinRoom(page, 'AddUndo');
    await waitForExcalidrawApi(page);
    await appendElement(page, excalidrawRectangle('undo-test', 0, 0));

    await expect.poll(() => page.evaluate(() => (
      (window as any).__debugExcalidrawApi?.getSceneElements?.() ?? []
    ).some((element: { id: string }) => element.id === 'undo-test'))).toBe(true);

    await expect(page.locator('.undo-button-container button')).toBeEnabled();
  });
});
