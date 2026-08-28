import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import {
  appUrl,
  createRoomWithMaxUsers,
  joinExistingRoom,
  approveFirstWaitingPeer,
  expectWaiting,
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

/** A one-pixel PNG, small enough to inline and a real decodable image. */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function imageElement(id: string, fileId: string) {
  return {
    id,
    type: 'image',
    fileId,
    x: 120,
    y: 140,
    width: 200,
    height: 200,
    angle: 0,
    strokeColor: 'transparent',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 4242,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    status: 'saved',
    scale: [1, 1],
    crop: null,
  };
}

/**
 * Adds an image the way a paste does: the bytes go into Excalidraw's files map
 * first, then an element referencing them lands in the scene.
 */
async function addImage(page: Page, fileId: string, elementId: string) {
  await waitForExcalidrawApi(page);
  // The API applies a remote snapshot shortly after mount and ignores onChange
  // while it does; the same wait appendElement uses, for the same reason.
  await page.waitForTimeout(400);
  await page.evaluate(
    ({ dataUrl, fileId: id, element }) => {
      const api = (window as any).__debugExcalidrawApi;
      api.addFiles([{ id, dataURL: dataUrl, mimeType: 'image/png', created: Date.now() }]);
      api.updateScene({
        elements: [...api.getSceneElements(), element],
        captureUpdate: 'IMMEDIATELY',
      });
    },
    { dataUrl: PNG_DATA_URL, fileId, element: imageElement(elementId, fileId) },
  );
}

async function fileIdsInScene(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const api = (window as any).__debugExcalidrawApi;
    return Object.keys(api?.getFiles?.() ?? {});
  });
}

test.describe('board images', () => {
  test('uploads an image to the room store and serves it back', async ({ page }) => {
    const roomId = await createRoomWithMaxUsers(page, 'ImageHost', 2);
    const fileId = `e2e-file-${Date.now()}`;

    await addImage(page, fileId, `img-${fileId}`);

    // The bytes must reach the room's store, not just the local scene.
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            appUrl(`/api/whiteboard/room/${roomId}/files/${fileId}`),
          );
          return response.status();
        },
        { timeout: 20000, message: 'the image never reached the room store' },
      )
      .toBe(200);

    const stored = await page.request.get(
      appUrl(`/api/whiteboard/room/${roomId}/files/${fileId}`),
    );
    expect(stored.headers()['content-type']).toContain('image/png');
    expect((await stored.body()).byteLength).toBeGreaterThan(0);
  });

  test('delivers an image to a peer that never had the bytes', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'ImageOwner', 2);
    const fileId = `e2e-shared-${Date.now()}`;
    const elementId = `img-${fileId}`;

    await addImage(page, fileId, elementId);

    const peerContext = await newAuthenticatedContext(browser);
    const peerPage = await peerContext.newPage();
    try {
      await joinExistingRoom(peerPage, roomId, 'ImagePeer');
      await expectWaiting(peerPage);
      await approveFirstWaitingPeer(page);
      await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });

      /*
       * The peer receives the element over Yjs but never the bytes -- they were
       * uploaded before it joined and are not in the document. It has to notice
       * the fileId it does not hold and fetch it. Before board files existed
       * this is precisely where the image showed as broken.
       */
      await expect
        .poll(() => fileIdsInScene(peerPage), {
          timeout: 25000,
          message: 'the peer never fetched the image it was not sent',
        })
        .toContain(fileId);
    } finally {
      await peerPage.close();
      await peerContext.close();
    }
  });

  test('refuses the image to an account with no grant in the room', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'ImagePrivate', 2);
    const fileId = `e2e-private-${Date.now()}`;

    await addImage(page, fileId, `img-${fileId}`);
    await expect
      .poll(
        async () => (await page.request.get(
          appUrl(`/api/whiteboard/room/${roomId}/files/${fileId}`),
        )).status(),
        { timeout: 20000 },
      )
      .toBe(200);

    /*
     * A session is not a grant. An account that was never admitted to this room
     * must not be able to read its pictures by asking for the URL, which is the
     * whole reason the bucket is private and the Worker is the only reader.
     */
    const outsiderContext = await newAuthenticatedContext(browser);
    const outsiderPage = await outsiderContext.newPage();
    try {
      await outsiderPage.goto('/whiteboard');
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
