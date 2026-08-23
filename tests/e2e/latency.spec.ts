import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import {
  approveFirstWaitingPeer,
  createRoomWithMaxUsers,
  expectWaiting,
  joinExistingRoom,
  newAuthenticatedContext,
} from './helpers';
import { summarizeLatencySamples } from '../../src/lib/whiteboard/latencyMetrics';

type LatencyEvent = {
  kind: 'stroke-publish' | 'stroke-render' | 'cursor-publish' | 'cursor-render';
  at: number;
  elementId?: string;
  version?: number;
  peerId?: string;
  x?: number;
  y?: number;
};

function eventKey(event: LatencyEvent, fields: Array<'elementId' | 'version' | 'peerId' | 'x' | 'y'>) {
  return fields.map((field) => String(event[field])).join(':');
}

async function readLatencyEvents(page: Page): Promise<LatencyEvent[]> {
  return page.evaluate(() => {
    const events = (window as any).__whiteboardLatencyEvents;
    return Array.isArray(events) ? events : [];
  });
}

async function clearLatencyEvents(page: Page) {
  // Do not create the debug global here: a missing global must remain a useful
  // red result until the browser-side probe is installed.
  await page.evaluate(() => {
    const events = (window as any).__whiteboardLatencyEvents;
    if (Array.isArray(events)) events.length = 0;
  });
}

function matchedLatencySamples(
  publishEvents: LatencyEvent[],
  renderEvents: LatencyEvent[],
  fields: Array<'elementId' | 'version' | 'peerId' | 'x' | 'y'>,
) {
  const rendersByKey = new Map<string, LatencyEvent[]>();
  for (const render of renderEvents) {
    const key = eventKey(render, fields);
    const bucket = rendersByKey.get(key) ?? [];
    bucket.push(render);
    rendersByKey.set(key, bucket);
  }

  const samples: number[] = [];
  for (const publish of publishEvents) {
    const bucket = rendersByKey.get(eventKey(publish, fields));
    if (!bucket) continue;
    const renderIndex = bucket.findIndex((render) => render.at >= publish.at);
    if (renderIndex < 0) continue;
    const [render] = bucket.splice(renderIndex, 1);
    if (render) samples.push(render.at - publish.at);
  }
  return samples;
}

async function waitForCollaborationReady(page: Page) {
  await expect
    .poll(
      async () => page.evaluate(() => Boolean((window as any).__whiteboardCollab?.isConnected)),
      { timeout: 20_000, message: 'whiteboard collaboration did not connect' },
    )
    .toBe(true);
}

async function sceneFreedraw(page: Page, elementId: string) {
  return page.evaluate((id) => {
    const api = (window as any).__debugExcalidrawApi;
    const element = (api?.getSceneElements?.() ?? []).find((candidate: any) => candidate.id === id);
    return element
      ? {
          id: element.id,
          type: element.type,
          version: element.version,
          points: Array.isArray(element.points) ? element.points.length : 0,
          isDeleted: Boolean(element.isDeleted),
        }
      : null;
  }, elementId);
}

async function canvasInkPixels(page: Page) {
  return page.evaluate(() => {
    const area = document.querySelector('[data-testid="whiteboard-canvas-area"]');
    if (!area) return 0;
    let total = 0;
    for (const canvas of area.querySelectorAll('canvas')) {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context || canvas.width === 0 || canvas.height === 0) continue;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 0; index < pixels.length; index += 4) {
        const [red, green, blue, alpha] = pixels.slice(index, index + 4);
        if (alpha > 20 && (red < 245 || green < 245 || blue < 245)) total += 1;
      }
    }
    return total;
  });
}

async function drawContinuousStroke(page: Page) {
  await page.getByTestId('whiteboard-tool-pen').click();
  await expect
    .poll(async () => page.evaluate(() => (window as any).__debugExcalidrawApi?.getAppState?.().activeTool?.type ?? null))
    .toBe('freedraw');

  await page.locator('canvas.excalidraw__canvas.interactive').first().waitFor({
    state: 'attached',
    timeout: 15_000,
  });

  await page.evaluate(async () => {
    const canvas = document.querySelector('canvas.excalidraw__canvas.interactive') as HTMLCanvasElement | null;
    if (!canvas) throw new Error('Excalidraw interactive canvas not found');
    const box = canvas.getBoundingClientRect();
    const event = (type: string, x: number, y: number, buttons: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
      });
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const points = Array.from({ length: 18 }, (_, index) => ({
      x: box.left + 100 + index * 9,
      y: box.top + 130 + (index % 6) * 11,
    }));
    const first = points[0];
    const last = points.at(-1);
    if (!first || !last) throw new Error('continuous stroke has no points');

    canvas.dispatchEvent(event('pointerdown', first.x, first.y, 1));
    for (const point of points.slice(1)) {
      await nextFrame();
      canvas.dispatchEvent(event('pointermove', point.x, point.y, 1));
    }
    await nextFrame();
    window.dispatchEvent(event('pointerup', last.x, last.y, 0));
  });

  const elementId = await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const elements = (window as any).__debugExcalidrawApi?.getSceneElements?.() ?? [];
          const stroke = [...elements].reverse().find((element: any) => element.type === 'freedraw' && !element.isDeleted);
          return stroke?.id ?? null;
        }),
      { timeout: 20_000, message: 'continuous stroke was not committed locally' },
    )
    .not.toBeNull()
    .then(async () =>
      page.evaluate(() => {
        const elements = (window as any).__debugExcalidrawApi?.getSceneElements?.() ?? [];
        const stroke = [...elements].reverse().find((element: any) => element.type === 'freedraw' && !element.isDeleted);
        return stroke?.id as string;
      }),
    );
  return elementId;
}

async function expectFinalStroke(page: Page, elementId: string) {
  await expect
    .poll(() => sceneFreedraw(page, elementId), { timeout: 25_000, message: `stroke ${elementId} did not reach the scene` })
    .toMatchObject({ id: elementId, type: 'freedraw', isDeleted: false });
  await expect
    .poll(
      async () => (await sceneFreedraw(page, elementId))?.points ?? 0,
      { timeout: 25_000, message: `stroke ${elementId} did not retain its intermediate points` },
    )
    .toBeGreaterThanOrEqual(3);
  await expect
    .poll(() => canvasInkPixels(page), { timeout: 25_000, message: 'final scene did not render visible canvas ink' })
    .toBeGreaterThan(100);
}

async function moveCursorAndAwaitRender(source: Page, target: Page, point: { x: number; y: number }) {
  const canvas = source.locator('canvas.excalidraw__canvas.interactive').first();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const before = (await readLatencyEvents(source)).filter((event) => event.kind === 'cursor-publish').length;

  await source.mouse.move(box!.x + point.x, box!.y + point.y);
  await expect
    .poll(
      async () => (await readLatencyEvents(source)).filter((event) => event.kind === 'cursor-publish').length,
      { timeout: 15_000, message: 'cursor movement was not published' },
    )
    .toBeGreaterThan(before);

  const published = (await readLatencyEvents(source)).filter((event) => event.kind === 'cursor-publish').at(-1);
  expect(published).toMatchObject({ kind: 'cursor-publish' });
  const peerId = published?.peerId;
  const x = published?.x;
  const y = published?.y;
  expect(peerId).toEqual(expect.any(String));
  expect(x).toEqual(expect.any(Number));
  expect(y).toEqual(expect.any(Number));

  await expect
    .poll(
      async () =>
        (await readLatencyEvents(target)).some(
          (event) =>
            event.kind === 'cursor-render' &&
            event.peerId === peerId &&
            event.x === x &&
            event.y === y,
        ),
      { timeout: 15_000, message: 'cursor render event did not converge on the target page' },
    )
    .toBe(true);

  await expect(target.locator(`[data-testid="whiteboard-peer-cursor-${peerId}"]`)).toBeVisible({ timeout: 15_000 });
}

async function setupPair(page: Page, browser: import('@playwright/test').Browser) {
  const roomId = await createRoomWithMaxUsers(page, 'LatencyHost', 2);
  const peerContext = await newAuthenticatedContext(browser);
  const peerPage = await peerContext.newPage();
  await joinExistingRoom(peerPage, roomId, 'LatencyPeer');
  await expectWaiting(peerPage);
  await approveFirstWaitingPeer(page);
  await expect(peerPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15_000 });
  await waitForCollaborationReady(page);
  await waitForCollaborationReady(peerPage);
  return { peerContext, peerPage };
}

test.describe('whiteboard latency budgets', () => {
  test.describe.configure({ timeout: 120_000 });

  test('continuous stroke intermediate events meet the bidirectional budget', async ({ page, browser }) => {
    const { peerContext, peerPage } = await setupPair(page, browser);
    try {
      await clearLatencyEvents(page);
      await clearLatencyEvents(peerPage);

      const hostStrokeId = await drawContinuousStroke(page);
      await expectFinalStroke(page, hostStrokeId);
      await expectFinalStroke(peerPage, hostStrokeId);

      const peerStrokeId = await drawContinuousStroke(peerPage);
      await expectFinalStroke(peerPage, peerStrokeId);
      await expectFinalStroke(page, peerStrokeId);

      await expect
        .poll(
          async () => {
            const [hostEvents, peerEvents] = await Promise.all([readLatencyEvents(page), readLatencyEvents(peerPage)]);
            return matchedLatencySamples(
              hostEvents.filter((event) => event.kind === 'stroke-publish'),
              peerEvents.filter((event) => event.kind === 'stroke-render'),
              ['elementId', 'version'],
            ).length;
          },
          { timeout: 25_000, message: 'host-to-peer stroke events did not produce three matched samples' },
        )
        .toBeGreaterThanOrEqual(3);
      await expect
        .poll(
          async () => {
            const [hostEvents, peerEvents] = await Promise.all([readLatencyEvents(page), readLatencyEvents(peerPage)]);
            return matchedLatencySamples(
              peerEvents.filter((event) => event.kind === 'stroke-publish'),
              hostEvents.filter((event) => event.kind === 'stroke-render'),
              ['elementId', 'version'],
            ).length;
          },
          { timeout: 25_000, message: 'peer-to-host stroke events did not produce three matched samples' },
        )
        .toBeGreaterThanOrEqual(3);

      const [hostEvents, peerEvents] = await Promise.all([readLatencyEvents(page), readLatencyEvents(peerPage)]);
      const hostToPeer = summarizeLatencySamples(
        matchedLatencySamples(
          hostEvents.filter((event) => event.kind === 'stroke-publish'),
          peerEvents.filter((event) => event.kind === 'stroke-render'),
          ['elementId', 'version'],
        ),
      );
      const peerToHost = summarizeLatencySamples(
        matchedLatencySamples(
          peerEvents.filter((event) => event.kind === 'stroke-publish'),
          hostEvents.filter((event) => event.kind === 'stroke-render'),
          ['elementId', 'version'],
        ),
      );
      console.log('stroke latency host->peer', hostToPeer);
      console.log('stroke latency peer->host', peerToHost);
      expect(hostToPeer.count).toBeGreaterThanOrEqual(3);
      expect(peerToHost.count).toBeGreaterThanOrEqual(3);
      expect(hostToPeer.p95 ?? Infinity).toBeLessThanOrEqual(2_000);
      expect(peerToHost.p95 ?? Infinity).toBeLessThanOrEqual(2_000);
    } finally {
      await peerContext.close();
    }
  });

  test('cursor publish to DOM render meets the bidirectional budget', async ({ page, browser }) => {
    const { peerContext, peerPage } = await setupPair(page, browser);
    try {
      await clearLatencyEvents(page);
      await clearLatencyEvents(peerPage);
      const positions = [
        { x: 150, y: 140 },
        { x: 230, y: 190 },
        { x: 320, y: 250 },
        { x: 410, y: 210 },
      ];

      for (const position of positions) {
        await moveCursorAndAwaitRender(page, peerPage, position);
      }
      for (const position of positions) {
        await moveCursorAndAwaitRender(peerPage, page, position);
      }

      const [hostEvents, peerEvents] = await Promise.all([readLatencyEvents(page), readLatencyEvents(peerPage)]);
      const hostToPeer = summarizeLatencySamples(
        matchedLatencySamples(
          hostEvents.filter((event) => event.kind === 'cursor-publish'),
          peerEvents.filter((event) => event.kind === 'cursor-render'),
          ['peerId', 'x', 'y'],
        ),
      );
      const peerToHost = summarizeLatencySamples(
        matchedLatencySamples(
          peerEvents.filter((event) => event.kind === 'cursor-publish'),
          hostEvents.filter((event) => event.kind === 'cursor-render'),
          ['peerId', 'x', 'y'],
        ),
      );
      console.log('cursor latency host->peer', hostToPeer);
      console.log('cursor latency peer->host', peerToHost);
      expect(hostToPeer.count).toBeGreaterThanOrEqual(3);
      expect(peerToHost.count).toBeGreaterThanOrEqual(3);
      expect(hostToPeer.p95 ?? Infinity).toBeLessThanOrEqual(1_000);
      expect(peerToHost.p95 ?? Infinity).toBeLessThanOrEqual(1_000);
    } finally {
      await peerContext.close();
    }
  });
});
