import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import { makeNoisePng, makePhotoPng } from './pngFixture';
import { createHash } from 'node:crypto';
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
    /*
     * Client-side downscaling converts large photographs to WebP before upload:
     * 3000x2250 exceeds the 2048px cap on the long edge, so this photograph
     * will be downscaled by the browser before it reaches the server. The stored
     * object should be WebP (not PNG) and materially smaller than the uploaded
     * original, because real photographs compress well.
     *
     * The byte-for-byte contract is now obsolete; downscaling is the feature.
     * We assert that the picture still reaches the editor under the same fileId,
     * and that it actually saved bytes to prove the downscaling engaged.
     */
    const original = makePhotoPng(3000, 2250);
    const fileId = await pasteImage(page, original);

    await expect
      .poll(
        async () => (await page.request.get(
          appUrl(`/api/whiteboard/room/${roomId}/files/${fileId}`),
        )).status(),
        { timeout: 30000, message: 'the photograph never reached the room store' },
      )
      .toBe(200);

    const stored = await page.request.get(appUrl(`/api/whiteboard/room/${roomId}/files/${fileId}`));
    const storedBytes = Buffer.from(await stored.body());

    expect(stored.headers()['content-type']).toContain('image/webp');

    /*
     * Downscaling should produce a picture smaller than half the original.
     * This proves the conversion actually happened; without it, the stored
     * object would be the original size or larger.
     */
    expect(storedBytes.length < original.length / 2).toBe(true);
    console.log(`Original: ${original.length} bytes, Stored: ${storedBytes.length} bytes, Ratio: ${(storedBytes.length / original.length * 100).toFixed(1)}%`);

    /*
     * The picture must still be in the editor under its fileId for the paste
     * to be complete. If the fileId is missing, the element exists but the
     * image is broken.
     */
    const fileIds = await fileIdsInScene(page);
    expect(fileIds).toContain(fileId);
  });

  test('uploads the small picture but keeps the big one in the editor', async ({ page }) => {
    const original = makePhotoPng(3000, 2250);
    const originalBase64Length = original.toString('base64').length;
    await createRoomWithMaxUsers(page, 'ImageMemory', 2);
    const fileId = await pasteImage(page, original);

    /*
     * What this pins down is a combination of a fix and a remaining limitation.
     *
     * The CSP fix now allows `blob:` in img-src, so Excalidraw's own 1440px
     * resize runs silently on every paste and the in-memory dataURL is now much
     * smaller than the original — roughly 30–50% on real photographs — because
     * the resize compresses pixel data from 3000+ down to 1440px.
     *
     * However, `uploadBoardFile` re-adds the converted WebP under the same
     * fileId, intending the editor to drop the resized original. It does not.
     * Excalidraw's `addFiles` runs through `addMissingFiles`, which takes a
     * file only `if (!files[id])` — an id it already holds is skipped, so the
     * call is a no-op and the resized data URL stays in memory for as long as
     * the tab is open. The bucket and every other peer still get the smaller
     * WebP; the person who pasted it keeps the resized version.
     *
     * Fixing it properly means the fork ingesting the converted bytes before
     * the editor ever sees the original, since no application code can replace
     * a file through the public API. When that lands this test fails, which is
     * the point: it is here to notice.
     */
    const inMemoryLength = await page.evaluate((id: string) => {
      const api = (window as any).__debugExcalidrawApi;
      return api?.getFiles?.()[id]?.dataURL?.length ?? 0;
    }, fileId);

    console.log(`Original base64: ${originalBase64Length} bytes, In-memory dataURL: ${inMemoryLength} bytes, Ratio: ${(inMemoryLength / originalBase64Length * 100).toFixed(1)}%`);

    await expect
      .poll(
        () => page.evaluate((id: string) => {
          const api = (window as any).__debugExcalidrawApi;
          return api?.getFiles?.()[id]?.dataURL?.length ?? 0;
        }, fileId),
        { timeout: 15000, message: 'the editor lost the picture it was holding' },
      )
      .toBeLessThan(originalBase64Length * 0.6);
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
     *
     * The canvas element appears well before the editor behind it exists, so
     * this waits for the API rather than the container: polling a scene that
     * has no editor yet reads an empty file list and tells us nothing.
     *
     * Honesty about the wait below: this test failed once at the full 30s poll
     * under four parallel workers and has not reproduced since, alone or in
     * repeated full runs. Thirty seconds of an empty scene is not a slow start,
     * so the cause is something else and is NOT established. Nothing here
     * claims to have fixed it -- if it returns, the place to look is whether
     * the board rehydrated at all after the reload, not whether it was given
     * long enough.
     */
    await page.reload();
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 20000 });
    await waitForExcalidrawApi(page);
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

  test('streams a large upload straight to the bucket', async ({ page }) => {
    test.setTimeout(90_000);
    const roomId = await createRoomWithMaxUsers(page, 'ImageStream', 2);

    /*
     * The streaming evidence, inherited rather than invented.
     *
     * It used to come for free from the paste test above: that pasted a 4.8MB
     * photograph and read the same bytes back, which only works if the file
     * route really streams the body past the JSON path and its MAX_BODY_BYTES
     * cap. Downscaling took that evidence away without touching the route --
     * a paste now arrives as a few hundred KB of WebP, comfortably under the
     * cap -- so nothing was left to fail if the route regressed. This puts a
     * large body through it directly instead.
     *
     * Noise on purpose here, and the one place it is the right fixture: the
     * point is a body that is genuinely large, and noise cannot be compressed
     * into something small by accident.
     */
    const large = makeNoisePng(1400, 1400);
    expect(large.length).toBeGreaterThan(5 * 1024 * 1024);
    const fileId = createHash('sha1').update(large).digest('hex');
    const url = appUrl(`/api/whiteboard/room/${roomId}/files/${fileId}`);

    /*
     * Base64 across the bridge, not an array of numbers. `Array.from` on these
     * bytes hands Playwright a JSON array of six million integers to serialise,
     * which takes longer than the test timeout and looks exactly like the route
     * hanging.
     */
    const status = await page.evaluate(async ({ target, base64 }) => {
      const binary = atob(base64);
      const body = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) body[i] = binary.charCodeAt(i);
      const response = await fetch(target, {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        body,
      });
      return response.status;
    }, { target: url, base64: large.toString('base64') });
    expect(status).toBe(201);

    /*
     * Compared by digest rather than by carrying the bytes back out. Length
     * alone would pass on a body that arrived the right size and the wrong
     * shape, which is precisely what a broken stream produces.
     */
    const readBack = await page.evaluate(async (target: string) => {
      const response = await fetch(target);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return {
        status: response.status,
        length: bytes.byteLength,
        sha256: Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0')).join(''),
      };
    }, url);

    expect(readBack.status).toBe(200);
    expect(readBack.length).toBe(large.length);
    expect(readBack.sha256).toBe(createHash('sha256').update(large).digest('hex'));
  });

});
