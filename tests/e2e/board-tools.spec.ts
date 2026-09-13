import { test, expect } from './fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { createRoomWithMaxUsers, joinRoomApproved, newAuthenticatedContext, roomIdFromPageUrl } from './helpers';
import { makeNoisePng } from './pngFixture';

/*
 * Every tool on the board's toolbar, used the way a person uses it.
 *
 * Each tool is picked from the toolbar -- its label, not a forced click or
 * setActiveTool -- and then used with real input: the mouse on a desktop, and
 * touch through CDP on a phone, so hit testing, pointer capture and
 * touch-action all take part. The result is checked twice: in the editor, and
 * in the room's shared document, because a tool whose work never leaves the
 * page is broken for everybody else in the lesson.
 *
 * The phone is a different toolbar component in the fork (MobileMenu), not the
 * desktop one shrunk, so it gets its own pass rather than being assumed.
 */

interface Point { readonly x: number; readonly y: number }

interface Pointer {
  drag(from: Point, to: Point): Promise<void>;
  tap(at: Point): Promise<void>;
}

interface Device {
  readonly name: 'desktop' | 'phone';
  /** A rectangle of open canvas: clear of the room bar, the toolbar and the footer. */
  readonly area: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
}

const DESKTOP: Device = { name: 'desktop', area: { left: 360, top: 200, right: 900, bottom: 470 } };
const PHONE: Device = { name: 'phone', area: { left: 60, top: 300, right: 330, bottom: 600 } };

interface Board {
  readonly page: Page;
  readonly input: Pointer;
  readonly device: Device;
  close(): Promise<void>;
}

function mousePointer(page: Page): Pointer {
  return {
    async drag(from, to) {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 16 });
      await page.mouse.up();
    },
    async tap(at) {
      await page.mouse.click(at.x, at.y);
    },
  };
}

function touchPointer(page: Page): Pointer {
  /*
   * One CDP session for the whole gesture: the browser keeps touch state per
   * session, and a move sent on a fresh one is refused as a touch that never
   * started.
   *
   * A drag comes to rest before the finger lifts, the way a hand ends a stroke.
   * Lifted at full speed, Chromium reads it as a fling, and the next tap --
   * anywhere, however much later -- is swallowed as the tap that stops the
   * fling, so the tool after it never gets chosen.
   */
  const gesture = async (steps: Point[]) => {
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', point?: Point) => cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: point ? [{ x: point.x, y: point.y, id: 1 }] : [],
    });
    try {
      const [first, ...rest] = steps;
      await touch('touchStart', first);
      // About a frame per sample. Faster than a hand, the editor's double-tap
      // check (two touches starting within 300ms) reads drag-then-tap as a
      // double tap and opens a text editor.
      for (const point of rest) {
        await touch('touchMove', point);
        await page.waitForTimeout(16);
      }
      if (rest.length > 0) {
        const last = rest[rest.length - 1];
        await page.waitForTimeout(120);
        await touch('touchMove', last);
        await page.waitForTimeout(120);
      }
      await touch('touchEnd');
    } finally {
      await cdp.detach();
    }
  };
  return {
    drag(from, to) {
      const steps = 16;
      return gesture(Array.from({ length: steps + 1 }, (_, i) => ({
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      })));
    },
    async tap(at) {
      await gesture([at]);
      // Past the editor's 300ms double-tap window, so a tap and whatever the
      // test does next are two gestures rather than one double tap.
      await page.waitForTimeout(350);
    },
  };
}

async function openBoard(browser: Browser, device: Device, subject: string): Promise<Board> {
  const base = await newAuthenticatedContext(browser, `tools-${subject}-${crypto.randomUUID()}`);
  const storageState = await base.storageState();
  await base.close();
  const context: BrowserContext = await browser.newContext(device.name === 'phone'
    ? { storageState, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
    : { storageState, viewport: { width: 1280, height: 720 } });
  /*
   * Chromium has the File System Access picker, which Playwright cannot drive.
   * Without it the editor falls back to <input type="file"> -- the same path
   * Safari, Firefox and every iPhone browser take -- and that one it can.
   */
  await context.addInitScript(() => {
    delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker;
    delete (Window.prototype as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });
  const page = await context.newPage();
  await createRoomWithMaxUsers(page, 'ToolHost', 2);
  await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();
  await page.waitForFunction(() => !!(window as any).__debugExcalidrawApi, null, { timeout: 15000 });
  // The editor applies the room's snapshot just after mount and ignores input
  // while it does; the same settle appendElement waits for.
  await page.waitForTimeout(400);
  return {
    page,
    device,
    input: device.name === 'phone' ? touchPointer(page) : mousePointer(page),
    close: () => context.close(),
  };
}

interface SceneElement {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly points: number;
  readonly text: string | null;
  readonly fileId: string | null;
  readonly frameId: string | null;
}

async function scene(page: Page): Promise<SceneElement[]> {
  return page.evaluate(() => ((window as any).__debugExcalidrawApi?.getSceneElements?.() ?? [])
    .map((element: any) => ({
      id: element.id,
      type: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      points: element.points?.length ?? 0,
      text: element.text ?? null,
      fileId: element.fileId ?? null,
      frameId: element.frameId ?? null,
    })));
}

async function ofType(page: Page, type: string): Promise<SceneElement[]> {
  return (await scene(page)).filter((element) => element.type === type);
}

/** What the room's shared document holds, tombstones left out. */
async function shared(page: Page): Promise<{ id: string; type: string; x: number }[]> {
  return page.evaluate(() => ((window as any).__whiteboardCollab?.provider?.doc?.getArray('elements')?.toArray?.() ?? [])
    .filter((element: any) => element.get('isDeleted') !== true)
    .map((element: any) => ({ id: element.get('id'), type: element.get('type'), x: element.get('x') })));
}

async function sharedTypes(page: Page, id: string): Promise<string | null> {
  return (await shared(page)).find((element) => element.id === id)?.type ?? null;
}

async function appState(page: Page): Promise<{ tool: string; locked: boolean; scrollX: number; scrollY: number; zoom: number; selected: string[] }> {
  return page.evaluate(() => {
    const state = (window as any).__debugExcalidrawApi.getAppState();
    return {
      tool: state.activeTool.type,
      locked: Boolean(state.activeTool.locked),
      scrollX: state.scrollX,
      scrollY: state.scrollY,
      zoom: state.zoom.value,
      selected: Object.keys(state.selectedElementIds).filter((id) => state.selectedElementIds[id]),
    };
  });
}

/** The label a person presses: the radio inside it sits under its own icon. */
async function pressToolbar(board: Board, testId: string) {
  const label = board.page.locator('label', { has: board.page.getByTestId(testId) }).first();
  await expect(label).toBeVisible();
  if (board.device.name === 'phone') await label.tap();
  else await label.click();
}

async function chooseTool(board: Board, testId: string, tool: string) {
  await pressToolbar(board, testId);
  await expect.poll(async () => (await appState(board.page)).tool, { timeout: 10000 }).toBe(tool);
}

/**
 * From "More tools". By name rather than test id: the fork gives Web Embed and
 * Mermaid the same `toolbar-embeddable` id.
 */
async function chooseExtraTool(board: Board, name: string) {
  const trigger = board.page.getByTitle('More tools');
  if (board.device.name === 'phone') await trigger.tap();
  else await trigger.click();
  const item = board.page.locator('.App-toolbar__extra-tools-dropdown').getByText(name, { exact: true });
  await expect(item).toBeInViewport();
  if (board.device.name === 'phone') await item.tap();
  else await item.click();
}

function spot(device: Device, fx: number, fy: number): Point {
  const { left, top, right, bottom } = device.area;
  return { x: left + (right - left) * fx, y: top + (bottom - top) * fy };
}

const SHAPE_TOOLS = [
  { testId: 'toolbar-rectangle', type: 'rectangle' },
  { testId: 'toolbar-diamond', type: 'diamond' },
  { testId: 'toolbar-ellipse', type: 'ellipse' },
] as const;

const LINEAR_TOOLS = [
  { testId: 'toolbar-arrow', type: 'arrow' },
  { testId: 'toolbar-line', type: 'line' },
] as const;

for (const device of [DESKTOP, PHONE]) {
  test.describe(`board tools on a ${device.name}`, () => {
    test.describe.configure({ timeout: 60_000 });

    for (const { testId, type } of SHAPE_TOOLS) {
      test(`${type} draws a ${type} the size of the drag and shares it`, async ({ browser }) => {
        const board = await openBoard(browser, device, type);
        try {
          await chooseTool(board, testId, type);
          const from = spot(device, 0.2, 0.2);
          const to = spot(device, 0.7, 0.8);
          await board.input.drag(from, to);

          await expect.poll(() => ofType(board.page, type)).toHaveLength(1);
          const [element] = await ofType(board.page, type);
          const { zoom } = await appState(board.page);
          expect(Math.abs(element.width)).toBeGreaterThan(((to.x - from.x) / zoom) * 0.8);
          expect(Math.abs(element.height)).toBeGreaterThan(((to.y - from.y) / zoom) * 0.8);
          await expect.poll(() => sharedTypes(board.page, element.id)).toBe(type);
          // Unlocked, a drawing tool hands back to selection once it is used.
          await expect.poll(async () => (await appState(board.page)).tool).toBe('selection');
        } finally {
          await board.close();
        }
      });
    }

    for (const { testId, type } of LINEAR_TOOLS) {
      test(`${type} draws a two-point ${type} from where the drag starts to where it ends`, async ({ browser }) => {
        const board = await openBoard(browser, device, type);
        try {
          await chooseTool(board, testId, type);
          const from = spot(device, 0.15, 0.3);
          const to = spot(device, 0.85, 0.7);
          await board.input.drag(from, to);

          await expect.poll(() => ofType(board.page, type)).toHaveLength(1);
          const [element] = await ofType(board.page, type);
          const { zoom } = await appState(board.page);
          expect(element.points).toBe(2);
          expect(element.width).toBeGreaterThan(((to.x - from.x) / zoom) * 0.8);
          expect(element.height).toBeGreaterThan(((to.y - from.y) / zoom) * 0.8);
          await expect.poll(() => sharedTypes(board.page, element.id)).toBe(type);
        } finally {
          await board.close();
        }
      });
    }

    test('draw follows the stroke rather than joining its ends', async ({ browser }) => {
      const board = await openBoard(browser, device, 'freedraw');
      try {
        await chooseTool(board, 'toolbar-freedraw', 'freedraw');
        await board.input.drag(spot(device, 0.1, 0.5), spot(device, 0.9, 0.4));

        await expect.poll(async () => (await ofType(board.page, 'freedraw'))[0]?.points ?? 0).toBeGreaterThan(8);
        const [stroke] = await ofType(board.page, 'freedraw');
        await expect.poll(() => sharedTypes(board.page, stroke.id)).toBe('freedraw');
        // Draw stays in hand: a pen that dropped back to selection after every
        // stroke would make handwriting impossible.
        expect((await appState(board.page)).tool).toBe('freedraw');
      } finally {
        await board.close();
      }
    });

    test('text writes what was typed where the board was pressed', async ({ browser }) => {
      const board = await openBoard(browser, device, 'text');
      try {
        await chooseTool(board, 'toolbar-text', 'text');
        await board.input.tap(spot(device, 0.3, 0.4));
        const editor = board.page.locator('textarea.excalidraw-wysiwyg');
        await expect(editor).toBeVisible();
        await board.page.keyboard.type('Photosynthesis');
        await board.page.keyboard.press('Escape');

        await expect.poll(async () => (await ofType(board.page, 'text'))[0]?.text ?? null).toBe('Photosynthesis');
        const [text] = await ofType(board.page, 'text');
        await expect.poll(() => sharedTypes(board.page, text.id)).toBe('text');
      } finally {
        await board.close();
      }
    });

    test('insert image puts the chosen picture on the board', async ({ browser }) => {
      const board = await openBoard(browser, device, 'image');
      try {
        const chooser = board.page.waitForEvent('filechooser');
        await pressToolbar(board, 'toolbar-image');
        await (await chooser).setFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: makeNoisePng(64, 48) });
        /*
         * A mouse carries the picture until the board is clicked; a finger has
         * no hover, so the editor drops it straight onto the board instead.
         */
        if (device.name === 'desktop') {
          await expect.poll(async () => (await appState(board.page)).tool).toBe('image');
          await board.page.mouse.move(spot(device, 0.4, 0.4).x, spot(device, 0.4, 0.4).y);
          await board.input.tap(spot(device, 0.5, 0.5));
        }

        await expect.poll(async () => (await ofType(board.page, 'image'))[0]?.fileId ?? null, { timeout: 15000 }).not.toBeNull();
        const [image] = await ofType(board.page, 'image');
        const hasFile = await board.page.evaluate(
          (fileId) => Boolean(fileId && (window as any).__debugExcalidrawApi.getFiles()[fileId]),
          image.fileId,
        );
        expect(hasFile).toBe(true);
        await expect.poll(() => sharedTypes(board.page, image.id)).toBe('image');
      } finally {
        await board.close();
      }
    });

    test('eraser removes a shape it is dragged across, for everyone', async ({ browser }) => {
      const board = await openBoard(browser, device, 'eraser');
      try {
        await chooseTool(board, 'toolbar-rectangle', 'rectangle');
        await board.input.drag(spot(device, 0.3, 0.3), spot(device, 0.7, 0.7));
        await expect.poll(() => ofType(board.page, 'rectangle')).toHaveLength(1);
        const [rectangle] = await ofType(board.page, 'rectangle');
        await expect.poll(() => sharedTypes(board.page, rectangle.id)).toBe('rectangle');

        await chooseTool(board, 'toolbar-eraser', 'eraser');
        // Across both upright edges: an unfilled shape is hit on its outline.
        await board.input.drag(spot(device, 0.1, 0.5), spot(device, 0.9, 0.5));

        await expect.poll(() => ofType(board.page, 'rectangle')).toHaveLength(0);
        await expect.poll(() => sharedTypes(board.page, rectangle.id)).toBeNull();
      } finally {
        await board.close();
      }
    });

    test('selection picks a shape up with a marquee and moves it by its edge', async ({ browser }) => {
      const board = await openBoard(browser, device, 'selection');
      try {
        await chooseTool(board, 'toolbar-rectangle', 'rectangle');
        const corner = spot(device, 0.35, 0.35);
        await board.input.drag(corner, spot(device, 0.65, 0.65));
        await expect.poll(() => ofType(board.page, 'rectangle')).toHaveLength(1);
        const [before] = await ofType(board.page, 'rectangle');

        await chooseTool(board, 'toolbar-selection', 'selection');
        await board.input.tap(spot(device, 0.95, 0.05));
        await expect.poll(async () => (await appState(board.page)).selected).toEqual([]);

        await board.input.drag(spot(device, 0.2, 0.2), spot(device, 0.8, 0.8));
        await expect.poll(async () => (await appState(board.page)).selected).toEqual([before.id]);

        const { zoom } = await appState(board.page);
        const edge = { x: corner.x, y: spot(device, 0, 0.5).y };
        await board.input.drag(edge, { x: edge.x + 60, y: edge.y });

        await expect.poll(async () => (await ofType(board.page, 'rectangle'))[0].x).toBeGreaterThan(before.x + (60 / zoom) * 0.7);
        const [after] = await ofType(board.page, 'rectangle');
        await expect.poll(async () => (await shared(board.page)).find((element) => element.id === before.id)?.x).toBe(after.x);
      } finally {
        await board.close();
      }
    });

    test('hand pans the board without drawing on it', async ({ browser }) => {
      const board = await openBoard(browser, device, 'hand');
      try {
        await chooseTool(board, 'toolbar-hand', 'hand');
        const before = await appState(board.page);
        await board.input.drag(spot(device, 0.3, 0.3), spot(device, 0.6, 0.5));

        const dx = spot(device, 0.6, 0).x - spot(device, 0.3, 0).x;
        await expect.poll(async () => (await appState(board.page)).scrollX - before.scrollX).toBeGreaterThan((dx / before.zoom) * 0.7);
        expect(await scene(board.page)).toEqual([]);
      } finally {
        await board.close();
      }
    });

    test('lock keeps a drawing tool in hand for the next shape', async ({ browser }) => {
      const board = await openBoard(browser, device, 'lock');
      try {
        await pressToolbar(board, 'toolbar-lock');
        await chooseTool(board, 'toolbar-rectangle', 'rectangle');
        await board.input.drag(spot(device, 0.05, 0.1), spot(device, 0.4, 0.4));
        await expect.poll(() => ofType(board.page, 'rectangle')).toHaveLength(1);
        expect(await appState(board.page)).toMatchObject({ tool: 'rectangle', locked: true });

        // No trip back to the toolbar in between.
        await board.input.drag(spot(device, 0.55, 0.55), spot(device, 0.95, 0.9));
        await expect.poll(() => ofType(board.page, 'rectangle')).toHaveLength(2);
      } finally {
        await board.close();
      }
    });

    test('frame gathers the shapes it is drawn around', async ({ browser }) => {
      const board = await openBoard(browser, device, 'frame');
      try {
        await chooseTool(board, 'toolbar-rectangle', 'rectangle');
        await board.input.drag(spot(device, 0.4, 0.4), spot(device, 0.6, 0.6));
        await expect.poll(() => ofType(board.page, 'rectangle')).toHaveLength(1);

        await chooseExtraTool(board, 'Frame tool');
        await expect.poll(async () => (await appState(board.page)).tool).toBe('frame');
        await board.input.drag(spot(device, 0.1, 0.1), spot(device, 0.9, 0.9));

        await expect.poll(() => ofType(board.page, 'frame')).toHaveLength(1);
        const [frame] = await ofType(board.page, 'frame');
        await expect.poll(async () => (await ofType(board.page, 'rectangle'))[0].frameId).toBe(frame.id);
        await expect.poll(() => sharedTypes(board.page, frame.id)).toBe('frame');
      } finally {
        await board.close();
      }
    });

    test('web embed places an embed on the board', async ({ browser }) => {
      const board = await openBoard(browser, device, 'embeddable');
      try {
        await chooseExtraTool(board, 'Web Embed');
        await expect.poll(async () => (await appState(board.page)).tool).toBe('embeddable');
        await board.input.drag(spot(device, 0.2, 0.2), spot(device, 0.8, 0.8));

        await expect.poll(() => ofType(board.page, 'embeddable')).toHaveLength(1);
        const [embed] = await ofType(board.page, 'embeddable');
        await expect.poll(() => sharedTypes(board.page, embed.id)).toBe('embeddable');
      } finally {
        await board.close();
      }
    });

    test('laser pointer draws nothing that stays on the board', async ({ browser }) => {
      const board = await openBoard(browser, device, 'laser');
      try {
        await chooseExtraTool(board, 'Laser pointer');
        await expect.poll(async () => (await appState(board.page)).tool).toBe('laser');
        await board.input.drag(spot(device, 0.2, 0.5), spot(device, 0.8, 0.5));

        expect(await scene(board.page)).toEqual([]);
        expect(await shared(board.page)).toEqual([]);
        expect((await appState(board.page)).tool).toBe('laser');
      } finally {
        await board.close();
      }
    });

    test('mermaid turns a flowchart definition into shapes on the board', async ({ browser }) => {
      const board = await openBoard(browser, device, 'mermaid');
      try {
        await chooseExtraTool(board, 'Mermaid to Excalidraw');
        const dialog = board.page.locator('.ttd-dialog');
        const input = dialog.locator('.ttd-dialog-input');
        await expect(input).toBeVisible({ timeout: 15000 });
        /*
         * Insert quietly does nothing until the preview has converted, and it
         * inserts whatever the preview last held. A person presses it once they
         * can see their own diagram, so wait for the preview of the new text:
         * the example's canvas is marked, and a fresh canvas replaces it.
         */
        const preview = dialog.locator('.ttd-dialog-output-canvas-container canvas');
        await expect(preview).toBeVisible({ timeout: 15000 });
        await preview.evaluate((canvas) => canvas.setAttribute('data-stale', ''));
        await input.fill('flowchart LR\n  Seed --> Sprout --> Tree');
        await expect(dialog.locator('.ttd-dialog-output-canvas-container canvas:not([data-stale])')).toBeVisible({ timeout: 15000 });
        const insert = dialog.getByRole('button', { name: 'Insert' });
        if (device.name === 'phone') await insert.tap();
        else await insert.click();

        await expect(dialog).toHaveCount(0);
        await expect.poll(async () => (await scene(board.page)).filter((element) => element.type === 'text').map((element) => element.text).sort(), { timeout: 15000 })
          .toEqual(['Seed', 'Sprout', 'Tree']);
        await expect.poll(async () => (await ofType(board.page, 'arrow')).length).toBe(2);
        const ids = (await scene(board.page)).map((element) => element.id).sort();
        await expect.poll(async () => (await shared(board.page)).map((element) => element.id).sort()).toEqual(ids);
      } finally {
        await board.close();
      }
    });
  });
}

test.describe('desktop-only board controls', () => {
  test('the collaboration laser button picks up the laser', async ({ browser }) => {
    const board = await openBoard(browser, DESKTOP, 'laser-button');
    try {
      await chooseTool(board, 'toolbar-LaserPointer', 'laser');
    } finally {
      await board.close();
    }
  });

  test('zoom in, zoom out and reset zoom change the board scale', async ({ browser }) => {
    const board = await openBoard(browser, DESKTOP, 'zoom');
    try {
      const zoom = async () => (await appState(board.page)).zoom;
      await board.page.getByTitle(/^Zoom in/).click();
      await expect.poll(zoom).toBeGreaterThan(1);
      await board.page.getByTitle('Reset zoom').click();
      await expect.poll(zoom).toBe(1);
      await board.page.getByTitle(/^Zoom out/).click();
      await expect.poll(zoom).toBeLessThan(1);
    } finally {
      await board.close();
    }
  });
});

test.describe('what each tool draws reaches a peer', () => {
  test('a peer sees every kind of mark the host made', async ({ browser }) => {
    test.setTimeout(120_000);
    const board = await openBoard(browser, DESKTOP, 'peer-host');
    const peerContext = await newAuthenticatedContext(browser);
    const peer = await peerContext.newPage();
    try {
      for (const { testId, type } of [...SHAPE_TOOLS, ...LINEAR_TOOLS]) {
        await chooseTool(board, testId, type);
        const row = SHAPE_TOOLS.length + LINEAR_TOOLS.length;
        const index = [...SHAPE_TOOLS, ...LINEAR_TOOLS].findIndex((tool) => tool.type === type);
        await board.input.drag(spot(DESKTOP, index / row + 0.02, 0.1), spot(DESKTOP, (index + 1) / row - 0.02, 0.4));
        await expect.poll(() => ofType(board.page, type)).toHaveLength(1);
      }
      await chooseTool(board, 'toolbar-freedraw', 'freedraw');
      await board.input.drag(spot(DESKTOP, 0.1, 0.6), spot(DESKTOP, 0.5, 0.7));
      await expect.poll(() => ofType(board.page, 'freedraw')).toHaveLength(1);
      await chooseTool(board, 'toolbar-text', 'text');
      await board.input.tap(spot(DESKTOP, 0.7, 0.8));
      await expect(board.page.locator('textarea.excalidraw-wysiwyg')).toBeVisible();
      await board.page.keyboard.type('Hello class');
      await board.page.keyboard.press('Escape');
      await expect.poll(async () => (await ofType(board.page, 'text'))[0]?.text ?? null).toBe('Hello class');

      const kinds = async (page: Page) => (await scene(page)).map((element) => element.type).sort();
      const drawn = await kinds(board.page);
      expect(drawn).toEqual(['arrow', 'diamond', 'ellipse', 'freedraw', 'line', 'rectangle', 'text']);

      await joinRoomApproved(peer, board.page, roomIdFromPageUrl(board.page), 'ToolPeer');
      await peer.waitForFunction(() => !!(window as any).__debugExcalidrawApi, null, { timeout: 15000 });
      await expect.poll(() => kinds(peer), { timeout: 30000 }).toEqual(drawn);
      await expect.poll(async () => (await ofType(peer, 'text'))[0]?.text ?? null).toBe('Hello class');
    } finally {
      await peerContext.close();
      await board.close();
    }
  });
});
