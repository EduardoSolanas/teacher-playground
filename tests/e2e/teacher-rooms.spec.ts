import { test, expect } from '@playwright/test';
import { appUrl, createRoomWithMaxUsers, expectSessionCookie } from './helpers';

test.describe('teacher room list on landing', () => {
  test('lists owned rooms as rows, not a dropdown, and opens from the list', async ({
    page,
  }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);
    await expect(page.getByRole('heading', { name: 'Your rooms' })).toBeVisible();
    await expect(page.locator('select')).toHaveCount(0);
    await expect(page.getByTestId('whiteboard-create-room-btn')).toBeVisible();
    await expect(page.getByTestId('whiteboard-room-code-input')).toBeVisible();

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
  });

  test('renames a listed room from the landing list', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);
    const roomId = await createRoomWithMaxUsers(page, 'RenameHost', 2);

    await page.goto(appUrl('/whiteboard'));
    const item = page.getByTestId(`whiteboard-room-list-item-${roomId}`);
    await expect(item).toBeVisible({ timeout: 15000 });

    await page.getByTestId(`whiteboard-room-rename-${roomId}`).click();
    await page.getByTestId(`whiteboard-room-name-input-${roomId}`).fill('Geometry');
    await page.getByTestId(`whiteboard-room-name-save-${roomId}`).click();

    await expect(item).toContainText('Geometry', { timeout: 15000 });
    await expect(page.locator('select')).toHaveCount(0);
  });
});
