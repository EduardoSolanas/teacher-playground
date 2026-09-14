import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import {
  appendElement,
  clickCreateRoom,
  excalidrawRectangle,
  waitForExcalidrawApi,
  expandPresenceIfCollapsed,
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
    // The roster is behind the People button now, so it has to be opened before
    // anything can sit on top of it.
    await expandPresenceIfCollapsed(page);
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

  test('the profile menu items are on top of the participants panel when opened', async ({ page }) => {
    await joinRoom(page, 'ChromeHost2');
    await waitForExcalidrawApi(page);
    // The roster is behind the People button now, so it has to be opened before
    // anything can sit on top of it.
    await expandPresenceIfCollapsed(page);
    await expect(page.locator('#whiteboard-presence-panel')).toBeVisible({ timeout: 15000 });

    const profile = page.getByTestId('whiteboard-profile-btn');
    await profile.click();

    const changeNameBtn = page.getByTestId('whiteboard-profile-edit-name');
    await expect(changeNameBtn).toBeVisible();

    const box = await changeNameBtn.boundingBox();
    expect(box).not.toBeNull();

    const hit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return element?.closest('[data-testid="whiteboard-profile-edit-name"]') !== null;
    }, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
    expect(hit).toBe(true);
  });
});

test.describe('Clear Board Modal', () => {
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

test.describe('Room seats', () => {
  test('raises the seat cap from the title menu, persists it, and refuses beyond the plan', async ({ page }) => {
    // A one-seat room keeps occupancy below every cap the test touches:
    // lowering a cap below who is already in the room would queue them on
    // reload, which is correct behaviour but not what this test is about.
    await page.goto(appUrl('/whiteboard'));
    await page.locator('input[type="number"]').fill('1');
    await page.getByTestId('whiteboard-create-room-btn').click();
    await page.getByTestId('whiteboard-username-input').fill('SeatsHost');
    await page.getByTestId('whiteboard-join-room-btn').click();
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

    await page.getByTestId('room-title-trigger').click();
    await page.getByTestId('room-menu-seats').click();
    await expect(page.getByTestId('room-seats-value')).toHaveText('1');

    // Raise to two: applied live, beside the board, without a reload.
    await page.getByTestId('room-seats-up').click();
    await page.getByTestId('room-seats-save').click();
    await expect(page.getByLabel(/of 2/)).toBeVisible();

    // A reload reads the seat count back from the room's settings.
    await page.reload();
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('room-title-trigger').click();
    await page.getByTestId('room-menu-seats').click();
    await expect(page.getByTestId('room-seats-value')).toHaveText('2');

    // Beyond the plan's free cap the server refuses, visibly, and the room
    // keeps the cap it has. The draft survives the refusal so the teacher can
    // pick a lower number instead of starting over.
    await page.getByTestId('room-seats-up').click();
    await page.getByTestId('room-seats-save').click();
    await expect(page.getByTestId('room-seats-limit')).toBeVisible();
    await expect(page.getByTestId('room-seats-value')).toHaveText('3');
  });
});