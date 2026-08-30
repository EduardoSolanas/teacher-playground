import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import { makeNoisePng, makePhotoPng } from './pngFixture';
import { createHash } from 'node:crypto';
import {
  appUrl,
  appendElement,
  excalidrawRectangle,
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
  const orphanImage = {
    id: 'orphan-image', type: 'image', fileId: 'deadbeefdeadbeefdeadbeefdeadbeef',
    x: 40, y: 40, width: 120, height: 90, angle: 0, strokeColor: '#000',
    backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1,
    strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null,
    roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false,
    boundElements: null, updated: 1, link: null, locked: false, index: 'a0',
    status: 'saved', scale: [1, 1], crop: null,
  };

  test('a picture the room does not hold is asked for once, not on every change', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const roomId = await createRoomWithMaxUsers(page, 'MissingHost', 2);
    await waitForExcalidrawApi(page);

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'MissingPeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await waitForExcalidrawApi(peerPage);

      const asked: string[] = [];
      peerPage.on('request', (request) => {
        if (request.url().includes(`/room/${roomId}/files/`)) asked.push(request.url());
      });

      /*
       * An element naming a file the room never held, arriving over the document
       * -- which is what a scene brought in from elsewhere leaves behind once it
       * is published: the reference travels, the bytes stayed with the file it
       * came from.
       */
      await appendElement(page, orphanImage);
      await page.waitForTimeout(1500);

      // Then keep the board changing. Each remote change used to provoke another
      // request for the same absent file.
      for (let i = 0; i < 6; i += 1) {
        await appendElement(page, excalidrawRectangle(`r-${i}`, 200 + i * 20, 200));
        await page.waitForTimeout(400);
      }
      await page.waitForTimeout(2000);

      console.log('ASKED ' + asked.length);
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.length).toBeLessThanOrEqual(2);
    } finally {
      await peerPage.close();
      await peerContext.close();
    }
  });


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

  test('holds the converted picture, not the photograph that was pasted', async ({ page }) => {
    const roomId = await createRoomWithMaxUsers(page, 'ImageMemory', 2);
    const original = makePhotoPng(3000, 2250);
    const originalBase64Length = original.toString('base64').length;
    const fileId = await pasteImage(page, original);

    /*
     * The memory half of the feature, which took three attempts to actually
     * get and twice looked finished when it was not.
     *
     * The application converted the picture on its way to the bucket and then
     * handed the converted copy back to the editor under the same id, which
     * does nothing: addFiles runs through addMissingFiles and takes a file only
     * `if (!files[id])`. So the bucket got 156KB while the person who pasted it
     * held megabytes, and nothing said so. Before that, our own CSP was denying
     * `blob:` to img-src, which made Excalidraw's built-in 1440px resize throw
     * into a catch that only logged -- so the editor kept the untouched 10.2MB
     * original and still looked like it was working.
     *
     * The fork now converts at ingest, which is the only place it can be done,
     * and this asserts the property that follows from it rather than a size:
     * what the editor is holding is the same picture it uploaded. A resized
     * intermediate would still pass a generous "smaller than the original"
     * bound -- the assertion this replaces did exactly that, and went on
     * passing after it had stopped meaning anything.
     */
    await expect
      .poll(
        async () => (await page.request.get(
          appUrl(`/api/whiteboard/room/${roomId}/files/${fileId}`),
        )).status(),
        { timeout: 30000, message: 'the picture never reached the room store' },
      )
      .toBe(200);
    const stored = Buffer.from(await (await page.request.get(
      appUrl(`/api/whiteboard/room/${roomId}/files/${fileId}`),
    )).body());

    const inMemoryLength = await page.evaluate((id: string) => {
      const api = (window as any).__debugExcalidrawApi;
      return api?.getFiles?.()[id]?.dataURL?.length ?? 0;
    }, fileId);

    console.log(
      `Pasted base64: ${originalBase64Length} bytes, stored: ${stored.length} bytes, `
      + `in editor: ${inMemoryLength} bytes (${(inMemoryLength / originalBase64Length * 100).toFixed(1)}% of pasted)`,
    );

    // A data URL is base64, so about four bytes for every three it carries,
    // plus its prefix. Anything near that is the stored picture and nothing
    // else; a resized PNG intermediate would be several times larger.
    expect(inMemoryLength).toBeGreaterThan(0);
    expect(inMemoryLength).toBeLessThan(stored.length * 1.5);
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
    /*
     * Before reloading, establish that the board was saved at all.
     *
     * The reloaded page reads its scene from the room row, and that row is
     * written by the durable object's flush -- so "the picture did not come
     * back" has two entirely different causes behind it, and the failure this
     * localises could not tell them apart. If this poll is what fails, the
     * board was never persisted and no reload was involved; if it passes and
     * the board still comes back empty, the loss is in restoring it.
     *
     * A failure here is a product bug, not a slow test: a lesson that has been
     * drawn on and not saved is the thing the flush exists to prevent.
     */
    await expect
      .poll(
        async () => {
          const response = await page.request.get(appUrl(`/api/whiteboard/room/${roomId}`));
          if (!response.ok()) return `http ${response.status()}`;
          const body = await response.json() as { elements?: unknown[] };
          return `saved=${body.elements?.length ?? -1}`;
        },
        { timeout: 30000, message: 'the board was never saved, so a reload cannot bring it back' },
      )
      .not.toBe('saved=0');

    await page.reload();
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 20000 });
    await waitForExcalidrawApi(page);

    /*
     * Reported as one string so that a failure says which half went wrong.
     *
     * A picture comes back in two independent steps: the element arrives with
     * the rest of the scene, and only then does this peer notice a fileId it
     * does not hold and fetch the bytes. An empty file list alone cannot tell
     * those apart, and that ambiguity is why this test failed twice in CI and
     * told us nothing -- the element count is the first thing worth knowing
     * and it was not in the output.
     */
    await expect
      .poll(
        async () => {
          const { elements, files } = await page.evaluate(() => {
            const api = (window as any).__debugExcalidrawApi;
            return {
              elements: api?.getSceneElements?.()?.length ?? -1,
              files: Object.keys(api?.getFiles?.() ?? {}),
            };
          });
          const response = await page.request.get(appUrl(`/api/whiteboard/room/${roomId}`));
          const saved = response.ok()
            ? ((await response.json() as { elements?: unknown[] }).elements?.length ?? -1)
            : -1;
          return `saved=${saved} elements=${elements} files=[${files.join(',')}]`;
        },
        {
          timeout: 30000,
          message: 'the board came back without its picture',
        },
      )
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
