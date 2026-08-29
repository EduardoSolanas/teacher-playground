import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import { makeNoisePng } from './pngFixture';
import {
  appUrl,
  createRoomWithMaxUsers,
  joinExistingRoom,
  approveFirstWaitingPeer,
  expectWaiting,
  expectSessionCookie,
  newAuthenticatedContext,
  waitForExcalidrawApi,
} from './helpers';

/*
 * Images are the one part of a board that does not travel in the document.
 * Elements carry a fileId and the bytes go to R2, so an image only works if
 * three separate things line up: the upload reaches the bucket, the element
 * reaches the other peer through Yjs, and that peer fetches the bytes it was
 * never sent. Every unit and worker test covers one of those in isolation, and
 * an image that renders for the person who added it and nowhere else is exactly
 * the bug this feature was built to fix -- so it has to be proved end to end.
 */

/**
 * A photograph the size a real one is, built rather than committed.
 *
 * Deliberately past 4MB. That was upstream Excalidraw's `MAX_ALLOWED_FILE_BYTES`
 * and it refused anything larger in the editor, before the upload route was
 * ever reached -- which is most of what a phone camera produces. The fork
 * raises it to 12MB, and this file is the evidence: at 4.8MB it also clears
 * `MAX_BODY_BYTES`, so it only reaches the bucket if the upload really is
 * streamed by the route that sits ahead of the JSON body path.
 */
function photograph(): Buffer {
  return makeNoisePng(1300, 1300);
}

/**
 * Pastes a picture onto the board, which is how one usually arrives.
 *
 * The bytes go in through Excalidraw's own clipboard handler, so everything it
 * does with a real file runs: reading it, deriving the element, sizing it,
 * putting it in the files map. Driving `addFiles` and `updateScene` through the
 * debug API instead would skip all of that and prove only that our sync layer
 * works on input we invented.
 */
async function pasteImage(page: Page, bytes: Buffer): Promise<string> {
  await waitForExcalidrawApi(page);
  // The editor applies a remote snapshot shortly after mount and ignores
  // changes while it does; the same wait appendElement uses, for the reason.
  await page.waitForTimeout(400);

  /*
   * The editor refuses a paste unless focus is inside its container and the
   * pointer is over the canvas -- it reads `elementFromPoint` at the last
   * viewport position to decide where the picture lands. Both hold for a person
   * who is looking at the board, and neither holds for a bare dispatch.
   */
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
    const target = document.querySelector('canvas.excalidraw__canvas.interactive')
      ?? document.body;
    target.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    }));
  }, bytes.toString('base64'));

  await expect
    .poll(() => fileIdsInScene(page), {
      timeout: 30000,
      message: 'the editor never took the pasted picture',
    })
    .not.toHaveLength(0);

  const [fileId] = await fileIdsInScene(page);
  return fileId;
}

async function fileIdsInScene(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const api = (window as any).__debugExcalidrawApi;
    return Object.keys(api?.getFiles?.() ?? {});
  });
}

test.describe('board images', () => {
  test('stores a real photograph and serves back the same bytes', async ({ page }) => {
    const roomId = await createRoomWithMaxUsers(page, 'ImageHost', 2);
    const photo = photograph();

    const fileId = await pasteImage(page, photo);

    await expect
      .poll(
        async () => (await page.request.get(
          appUrl(`/api/whiteboard/room/${roomId}/files/${fileId}`),
        )).status(),
        { timeout: 30000, message: 'the photograph never reached the room store' },
      )
      .toBe(200);

    const stored = await page.request.get(appUrl(`/api/whiteboard/room/${roomId}/files/${fileId}`));
    expect(stored.headers()['content-type']).toContain('image/png');
    // Byte-for-byte: a picture that arrives truncated or re-encoded is a
    // picture that renders wrong, and the size alone would not catch it.
    expect(Buffer.from(await stored.body()).equals(photo)).toBe(true);
  });

  test('keeps the photograph across a reload', async ({ page }) => {
    const roomId = await createRoomWithMaxUsers(page, 'ImageReload', 2);
    const photo = photograph();
    const fileId = await pasteImage(page, photo);

    await expect
      .poll(
        async () => (await page.request.get(
          appUrl(`/api/whiteboard/room/${roomId}/files/${fileId}`),
        )).status(),
        { timeout: 30000 },
      )
      .toBe(200);

    /*
     * Before board files existed this is where a pasted image was lost: it
     * lived only in the editor's memory, so reopening the room showed a broken
     * picture on a board that had looked fine a moment earlier.
     */
    await page.reload();
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 20000 });
    await expect
      .poll(() => fileIdsInScene(page), {
        timeout: 30000,
        message: 'the board came back without its picture',
      })
      .toContain(fileId);
  });

  test('delivers the photograph to a peer that never had the bytes', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'ImageOwner', 2);
    const photo = photograph();
    const fileId = await pasteImage(page, photo);

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'ImagePeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      /*
       * The peer receives the element over the document but never the bytes --
       * they were uploaded before it joined and are not in the document. It has
       * to notice the fileId it does not hold and fetch it.
       */
      await expect
        .poll(() => fileIdsInScene(peerPage), {
          timeout: 30000,
          message: 'the peer never fetched the picture it was not sent',
        })
        .toContain(fileId);
    } finally {
      await peerPage.close();
      await peerContext.close();
    }
  });

  test('refuses the photograph to an account with no grant in the room', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'ImagePrivate', 2);
    const photo = photograph();
    const fileId = await pasteImage(page, photo);

    await expect
      .poll(
        async () => (await page.request.get(
          appUrl(`/api/whiteboard/room/${roomId}/files/${fileId}`),
        )).status(),
        { timeout: 30000 },
      )
      .toBe(200);

    /*
     * A session is not a grant. An account never admitted to this room must not
     * read its pictures by asking for the URL, which is the whole reason the
     * bucket is private and the Worker is its only reader.
     */
    const outsiderContext = await newAuthenticatedContext(browser);
    const outsiderPage = await outsiderContext.newPage();
    try {
      await outsiderPage.goto('/whiteboard');
      await expectSessionCookie(outsiderPage);
      const refused = await outsiderPage.request.get(
        appUrl(`/api/whiteboard/room/${roomId}/files/${fileId}`),
      );
      expect(refused.status()).toBe(403);
      expect(refused.headers()['content-type'] ?? '').not.toContain('image/');
    } finally {
      await outsiderPage.close();
      await outsiderContext.close();
    }
  });
});
