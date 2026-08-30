import { test, expect } from './fixtures';
import { readFileSync } from 'node:fs';
import {
  appUrl,
  appendElement,
  createRoomWithMaxUsers,
  excalidrawRectangle,
  expectSessionCookie,
  waitForExcalidrawApi,
} from './helpers';

test.describe('taking a copy of a board', () => {
  /*
   * From the list, without opening the room.
   *
   * The point of it being here rather than only inside the board is a teacher
   * archiving a term: thirty rooms is thirty visits otherwise. Everything this
   * covers is downstream of that -- the scene is fetched over HTTP, the
   * pictures are fetched one at a time and packed into the file, and the image
   * is rendered by Excalidraw's exporter on a page that has no canvas on it.
   *
   * Asserted on the bytes that come back rather than on the click, because
   * every part of that chain can fail while still producing a file: an export
   * that writes an empty scene, or a PNG that is a JSON error page with the
   * wrong name on it.
   */
  /*
   * The diagnostics download, asserted on the file rather than the click.
   *
   * It shipped answering 403 to the owner it was built for: the handler
   * checked ownership correctly and was never reached, because authorization
   * in RoomDO is a separate gate whose default is refusal and which had no
   * entry for the route. Nothing caught it -- the button produced no file and
   * said nothing, and a unit test of the handler cannot see the gate.
   */
  test('downloads a diagnostic report describing the room', async ({ page }) => {
    const roomId = await createRoomWithMaxUsers(page, 'StatsHost', 2);
    await waitForExcalidrawApi(page);
    await appendElement(page, excalidrawRectangle('rect-1', 40, 60));
    await page.waitForTimeout(1500);

    await page.getByRole('link', { name: /back to rooms/i }).click();
    await expect(page.getByRole('heading', { name: 'Your rooms' })).toBeVisible({ timeout: 20000 });

    await page.getByTestId(`whiteboard-room-menu-${roomId}`).click();
    const reportPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.getByTestId(`whiteboard-room-stats-${roomId}`).click();
    const report = await reportPromise;
    const reportPath = await report.path();
    expect(reportPath).not.toBeNull();

    const stats = JSON.parse(readFileSync(reportPath!, 'utf8')) as {
      elements: { total: number; visible: number };
      snapshotBytes: number;
    };
    expect(stats.elements.total).toBeGreaterThan(0);
    expect(stats.elements.visible).toBeGreaterThan(0);
    expect(stats.snapshotBytes).toBeGreaterThan(0);
  });

  test('downloads the scene and a picture of it from the list', async ({ page }) => {
    const roomId = await createRoomWithMaxUsers(page, 'DownloadHost', 2);
    await waitForExcalidrawApi(page);
    await appendElement(page, excalidrawRectangle('rect-1', 120, 140));
    await page.waitForTimeout(1500);

    await page.getByRole('link', { name: /back to rooms/i }).click();
    await expect(page.getByRole('heading', { name: 'Your rooms' })).toBeVisible({ timeout: 20000 });

    await page.getByTestId(`whiteboard-room-menu-${roomId}`).click();
    const scenePromise = page.waitForEvent('download', { timeout: 30000 });
    await page.getByTestId(`whiteboard-room-download-${roomId}`).click();
    const scene = await scenePromise;
    const scenePath = await scene.path();
    expect(scenePath).not.toBeNull();
    const parsed = JSON.parse(readFileSync(scenePath!, 'utf8')) as {
      type: string; elements: unknown[];
    };
    expect(parsed.type).toBe('excalidraw');
    expect(parsed.elements.length).toBeGreaterThan(0);
    expect(scene.suggestedFilename()).toMatch(/\.excalidraw$/);

    await page.getByTestId(`whiteboard-room-menu-${roomId}`).click();
    const imagePromise = page.waitForEvent('download', { timeout: 30000 });
    await page.getByTestId(`whiteboard-room-image-${roomId}`).click();
    const image = await imagePromise;
    const imagePath = await image.path();
    expect(imagePath).not.toBeNull();
    // The eight byte PNG signature: a real picture, not an error page renamed.
    const bytes = readFileSync(imagePath!);
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(image.suggestedFilename()).toMatch(/\.png$/);
  });
});

test.describe('teacher room list on landing', () => {
  test('lists owned rooms as rows, not a dropdown, and opens from the list', async ({
    page,
  }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);
    await expect(page.getByRole('heading', { name: 'Your rooms' })).toBeVisible();
    await expect(page.locator('select')).toHaveCount(0);
    await expect(page.getByTestId('whiteboard-create-room-btn')).toBeVisible();
    await expect(page.getByTestId('whiteboard-room-name-input')).toHaveCount(0);

    const roomId = await createRoomWithMaxUsers(page, 'ListHost', 2);

    await page.goto(appUrl('/whiteboard'));
    await expect(page.getByRole('heading', { name: 'Your rooms' })).toBeVisible();
    await expect(page.locator('select')).toHaveCount(0);

    const item = page.getByTestId(`whiteboard-room-list-item-${roomId}`);
    await expect(item).toBeVisible({ timeout: 15000 });
    await expect(item).toHaveAttribute('href', `/whiteboard/${roomId}`);

    await item.click();
    await expect(page).toHaveURL(new RegExp(`/whiteboard/${roomId}`));
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

    await page.getByTestId('whiteboard-back-to-rooms').click();
    await expect(page).toHaveURL(/\/whiteboard\/?$/);
    await expect(page.getByRole('heading', { name: 'Your rooms' })).toBeVisible();
    await expect(page.getByTestId('whiteboard-create-room-btn')).toBeDisabled();
  });

  test('renames a listed room from the landing list', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);
    const roomId = await createRoomWithMaxUsers(page, 'RenameHost', 2);

    await page.goto(appUrl('/whiteboard'));
    const item = page.getByTestId(`whiteboard-room-list-item-${roomId}`);
    await expect(item).toBeVisible({ timeout: 15000 });

    await page.getByTestId(`whiteboard-room-menu-${roomId}`).click();
    await page.getByTestId(`whiteboard-room-rename-${roomId}`).click();
    await page.getByTestId(`whiteboard-room-name-input-${roomId}`).fill('Geometry');
    await page.getByTestId(`whiteboard-room-name-save-${roomId}`).click();

    await expect(item).toContainText('Geometry', { timeout: 15000 });
    await expect(page.locator('select')).toHaveCount(0);
  });
});
