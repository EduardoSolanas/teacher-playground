import { test, expect } from './fixtures';
import { createRoomWithMaxUsers } from './helpers';

/**
 * The board editor is the heaviest file the room pulls, and the component that
 * imports it only mounts after the session bootstrap and the room read have
 * both come back. Starting the download at module scope instead overlaps it
 * with that chain.
 *
 * Observed at the network level rather than through the Resource Timing API,
 * whose fetch entries do not reliably land in this harness. The chunk name is
 * content-hashed, so the editor is identified as the largest JS response of
 * the load (measured as the responses arrive; the responses arrive chunked, so
 * content-length is not available). The assertion is ordering, not existence:
 * the editor's request must be issued before the session check that currently
 * gates everything else. The local harness re-requests every chunk on reload,
 * so the request is always observed here.
 */
test('starts downloading the board editor chunk before the auth chain', async ({ page }) => {
  test.setTimeout(60_000);

  const roomId = await createRoomWithMaxUsers(page, 'Preload Teacher', 4);

  const requestedAt = new Map<string, number>();
  let largestBytes = 0;
  let largestUrl = '';
  page.on('request', (request) => {
    const url = request.url();
    if (!requestedAt.has(url)) requestedAt.set(url, Date.now());
  });
  page.on('response', async (response) => {
    const url = response.url();
    if (!/\/_next\/static\/chunks\/.+\.js$/.test(url)) return;
    try {
      const bytes = (await response.body()).byteLength;
      if (bytes > largestBytes) {
        largestBytes = bytes;
        largestUrl = url;
      }
    } catch {
      // A body evicted before we read it cannot be the identifier; the load
      // was still observed and the next-largest chunk takes the role.
    }
  });

  await page.goto(`/whiteboard/${roomId}`);
  await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 20000 });

  await expect
    .poll(
      () => [...requestedAt.keys()].filter((url) => url.includes('/auth/session/current')).length,
      { message: 'the auth session check was never requested' },
    )
    .toBeGreaterThanOrEqual(1);

  const sessionAt = Math.min(
    ...[...requestedAt.entries()]
      .filter(([url]) => url.includes('/auth/session/current'))
      .map(([, at]) => at),
  );

  await expect
    .poll(() => largestUrl, { message: 'the room fetched no JS chunks' })
    .not.toBe('');

  const editorAt = requestedAt.get(largestUrl);
  expect(editorAt, 'the editor chunk request was never issued').toBeDefined();
  expect(
    editorAt,
    `editor chunk (${largestUrl}) download started after the auth check`,
  ).toBeLessThan(sessionAt);
});
