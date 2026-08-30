import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { appUrl, createRoomWithMaxUsers, waitForExcalidrawApi } from './helpers';
import { makePhotoPng } from './pngFixture';

/**
 * A teacher's shapes, kept against the room.
 *
 * Excalidraw keeps its library in the browser, so shapes built up on one
 * laptop are simply absent from another and gone when site data is cleared.
 * Held against the room they are a property of the lesson instead.
 *
 * The image case is the one worth proving. Upstream refuses a selection
 * holding a picture, because a library item carries elements and no files and
 * an image item would name bytes that stayed behind. The fork allows it
 * because this application keeps the library on the server beside the bucket
 * those bytes are already in -- so the whole feature rests on the picture
 * still being there afterwards, which is what the reload here is for.
 */
async function pasteImage(page: Page, bytes: Buffer) {
  await waitForExcalidrawApi(page);
  await page.waitForTimeout(400);
  const canvas = page.locator('canvas.excalidraw__canvas.interactive').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('the board canvas has no box to point at');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.evaluate(async (base64: string) => {
    const binary = atob(base64);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
    const file = new File([buffer], 'photo.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    (document.querySelector('canvas.excalidraw__canvas.interactive') ?? document.body)
      .dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: transfer, bubbles: true, cancelable: true,
      }));
  }, bytes.toString('base64'));
  await expect.poll(async () => page.evaluate(() => (
    Object.keys((window as any).__debugExcalidrawApi?.getFiles?.() ?? {}).length
  )), { timeout: 30000, message: 'the editor never took the pasted picture' })
    .toBeGreaterThan(0);
}

async function storedLibrary(page: Page, roomId: string) {
  const response = await page.request.get(appUrl(`/api/whiteboard/room/${roomId}/library`));
  if (!response.ok()) return `http ${response.status()}`;
  const body = await response.json() as { items?: unknown[] };
  return body.items?.length ?? -1;
}

test.describe('the room library', () => {
  test('saves a picture as a shape and still has it after a reload', async ({ page }) => {
    test.setTimeout(180_000);
    const roomId = await createRoomWithMaxUsers(page, 'LibraryHost', 2);
    await pasteImage(page, makePhotoPng(900, 700));
    await page.waitForTimeout(1500);

    const canvas = page.locator('canvas.excalidraw__canvas.interactive').first();
    const box = await canvas.boundingBox();
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(300);
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' });
    await page.locator('.context-menu').getByText(/add to library/i).first().click();

    /*
     * No error dialog is half the assertion. Upstream answers this exact
     * action with "Support for adding images to the library coming soon!",
     * so its absence is what says the divergence is in the build being run.
     */
    await page.waitForTimeout(800);
    expect(await page.locator('.ErrorDialog').allInnerTexts().catch(() => [])).toEqual([]);

    await expect.poll(() => storedLibrary(page, roomId), { timeout: 25000 }).toBe(1);

    /*
     * The reload is the point. A library that only survives while the tab is
     * open is the browser-local library this replaced, and a saved picture is
     * only worth saving if its bytes come back with it.
     */
    await page.reload();
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 20000 });
    await waitForExcalidrawApi(page);
    expect(await storedLibrary(page, roomId)).toBe(1);

    await expect.poll(async () => page.evaluate(() => (
      Object.keys((window as any).__debugExcalidrawApi?.getFiles?.() ?? {}).length
    )), { timeout: 25000, message: 'the saved shape came back without its picture' })
      .toBeGreaterThan(0);
  });
});
