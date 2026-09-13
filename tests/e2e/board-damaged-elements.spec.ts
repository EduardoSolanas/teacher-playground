import { test, expect } from './fixtures';
import { newAuthenticatedContext, createRoomWithMaxUsers } from './helpers';

/*
 * A shared document can hold a line or arrow whose points are gone: a client
 * from before the codec stored them differently, an interrupted encode, or a
 * manual edit. Excalidraw reads `points.length` and `points[0]` while it walks
 * the scene, so without the guard that one element takes the whole board down
 * for every peer -- which is what "cannot draw" looked like.
 */

test('a line that lost its points cannot break drawing for the room', async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await newAuthenticatedContext(browser, `damaged-${crypto.randomUUID()}`);
  const page = await context.newPage();
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && /undefined.*(length|iterable)/i.test(message.text())) {
      failures.push(`console: ${message.text()}`);
    }
  });

  try {
    await createRoomWithMaxUsers(page, 'DamagedHost', 2);
    await page.waitForFunction(() => !!(window as any).__debugExcalidrawApi, null, { timeout: 15000 });
    await page.waitForTimeout(400);

    const canvas = page.getByTestId('whiteboard-canvas-area');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no canvas box');
    await page.locator('label', { has: page.getByTestId('toolbar-line') }).first().click();
    await page.waitForTimeout(200);
    await page.mouse.move(box.x + 340, box.y + 240);
    await page.mouse.down();
    await page.mouse.move(box.x + 520, box.y + 330, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(1500);

    const lineId = await page.evaluate(() => (window as any).__debugExcalidrawApi
      .getSceneElements().filter((element: any) => element.type === 'line' && !element.isDeleted)
      .map((element: any) => element.id)[0]);
    expect(lineId).toBeTruthy();
    await page.waitForTimeout(1200);
    const stripped = await page.evaluate((id) => {
      const elements = (window as any).__whiteboardCollab.provider.doc.getArray('elements');
      const map = elements.toArray().find((candidate: any) => candidate.get('id') === id);
      if (!map) return false;
      map.delete('points');
      return true;
    }, lineId);
    expect(stripped).toBe(true);

    failures.length = 0;
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__debugExcalidrawApi, null, { timeout: 15000 });
    await page.waitForTimeout(2500);
    expect(failures).toEqual([]);

    const line = await page.evaluate((id) => {
      const found = (window as any).__debugExcalidrawApi.getSceneElements()
        .find((element: any) => element.id === id);
      return found ? { points: Array.isArray(found.points) ? found.points.length : null } : null;
    }, lineId);
    expect(line).not.toBeNull();

    await page.locator('label', { has: page.getByTestId('toolbar-freedraw') }).first().click();
    await page.waitForTimeout(200);
    await page.mouse.move(box.x + 560, box.y + 320);
    await page.mouse.down();
    for (let i = 1; i <= 16; i += 1) {
      await page.mouse.move(box.x + 560 + i * 6, box.y + 320 + i * 4, { steps: 1 });
      await page.waitForTimeout(8);
    }
    await page.mouse.up();

    await expect.poll(async () => page.evaluate(() => (window as any).__debugExcalidrawApi
      .getSceneElements().filter((element: any) => element.type === 'freedraw' && !element.isDeleted)
      .reduce((count: number, element: any) => count + (element.points?.length ?? 0), 0)))
      .toBeGreaterThan(8);
    expect(failures).toEqual([]);
  } finally {
    await context.close();
  }
});
