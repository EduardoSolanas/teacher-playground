import { test, expect } from './fixtures';
import type { Browser, Page } from '@playwright/test';
import { request as httpRequest } from 'node:http';
import {
  appUrl,
  approveFirstWaitingPeer,
  createRoomWithMaxUsers,
  expectNotWaiting,
  expectWaiting,
  expandPresenceIfCollapsed,
  moderateApprovedPeer,
} from './helpers';
import { guestOrigin } from './origins';

const GUEST_PIN_ERROR = "That PIN didn't work. Check with your teacher and try again.";
const GUEST_SESSION_COOKIE = '__Host-teacher-guest';
const HEX_ROOM = 'a'.repeat(32);

async function sceneElementIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const api = (window as unknown as { __debugExcalidrawApi?: { getSceneElements?: () => { id: string }[] } }).__debugExcalidrawApi;
    return (api?.getSceneElements?.() ?? []).map((element) => element.id);
  });
}

async function drawPenStroke(page: Page, points: Array<{ x: number; y: number }>) {
  await page.getByTestId('whiteboard-tool-pen').click();
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as {
      __debugExcalidrawApi?: { getAppState?: () => { activeTool?: { type?: string } } };
    }).__debugExcalidrawApi?.getAppState?.().activeTool?.type ?? null
  ))).toBe('freedraw');

  const canvasArea = page.getByTestId('whiteboard-canvas-area');
  const box = await canvasArea.boundingBox();
  expect(box).not.toBeNull();
  await page.locator('canvas.excalidraw__canvas.interactive').first().waitFor({
    state: 'attached',
    timeout: 15_000,
  });

  await page.evaluate(async ({ originX, originY, relativePoints }) => {
    const canvas = document.querySelector('canvas.excalidraw__canvas.interactive');
    if (!canvas) throw new Error('Excalidraw interactive canvas not found');
    const pointer = (type: string, x: number, y: number, buttons: number) => new PointerEvent(type, {
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
    const absolute = relativePoints.map((point) => ({
      x: originX + point.x,
      y: originY + point.y,
    }));
    const first = absolute[0];
    const last = absolute.at(-1);
    if (!first || !last) throw new Error('drawPenStroke requires points');
    canvas.dispatchEvent(pointer('pointerdown', first.x, first.y, 1));
    for (const point of absolute.slice(1)) {
      await nextFrame();
      canvas.dispatchEvent(pointer('pointermove', point.x, point.y, 1));
    }
    await nextFrame();
    window.dispatchEvent(pointer('pointerup', last.x, last.y, 0));
  }, { originX: box!.x, originY: box!.y, relativePoints: points });
}

async function expectPenStrokes(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => (
    ((window as unknown as {
      __debugExcalidrawApi?: {
        getSceneElements?: () => Array<{ isDeleted?: boolean; type?: string; points?: unknown[] }>;
      };
    }).__debugExcalidrawApi?.getSceneElements?.() ?? [])
      .filter((element) => !element.isDeleted
        && element.type === 'freedraw'
        && Array.isArray(element.points)
        && element.points.length >= 4).length
  )), { timeout: 20_000 }).toBeGreaterThanOrEqual(count);
}

function guestOriginGet(path: string) {
  const target = new URL(path, guestOrigin());
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: Number(target.port),
      path: `${target.pathname}${target.search}`,
      headers: {
        Host: target.host,
        Origin: target.origin,
      },
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once('error', reject);
    request.end();
  });
}

function newGuestContext(browser: Browser) {
  return browser.newContext({
    storageState: { cookies: [], origins: [] },
    baseURL: guestOrigin(),
  });
}

function guestRoomUrl(roomId: string) {
  return new URL(`/whiteboard/${roomId}`, guestOrigin()).toString();
}

function wrongPin(pin: string) {
  return pin.replace(/\d$/, (digit) => (digit === '9' ? '0' : String(Number(digit) + 1)));
}

async function enableGuestAndReadPin(teacherPage: Page, roomId: string): Promise<string> {
  const list = await teacherPage.context().newPage();
  try {
    await list.goto(appUrl('/whiteboard'));
    await expect(list.getByTestId(`whiteboard-room-list-item-${roomId}`)).toBeVisible({ timeout: 15000 });
    // Guest access is a control on the row now, not an item inside the
    // overflow menu: it is what a teacher does before a lesson, so the menu
    // click this used to need has gone rather than moved.
    await list.getByTestId(`whiteboard-room-guest-${roomId}`).click();
    await expect(list.getByTestId('guest-enable')).toBeVisible({ timeout: 15000 });
    await list.getByTestId('guest-enable').click();
    await expect(list.getByTestId('guest-pin')).toHaveText(/^\d{6}$/, { timeout: 15000 });
    return (await list.getByTestId('guest-pin').innerText()).trim();
  } finally {
    await list.close();
  }
}

async function patchGuestAccess(page: Page, roomId: string, guestAccess: boolean) {
  return page.evaluate(async ({ roomId, guestAccess }) => {
    const response = await fetch(`/api/whiteboard/room/${roomId}/settings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ guestAccess }),
    });
    return { status: response.status, body: await response.json() as { guestPin?: unknown } };
  }, { roomId, guestAccess });
}

async function peerIdByName(hostPage: Page, name: string) {
  await expandPresenceIfCollapsed(hostPage);
  const row = hostPage.locator('[data-testid^="whiteboard-user-"]').filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  const testId = await row.getAttribute('data-testid');
  const peerId = testId?.replace(/^whiteboard-user-(?:host-)?/, '');
  expect(peerId).toBeTruthy();
  return peerId!;
}

test.describe('guest join on split hostnames', () => {
  test('__Host- cookies are stored and sent on the guest origin', async ({ browser }) => {
    const origin = guestOrigin();
    const context = await newGuestContext(browser);
    const page = await context.newPage();
    try {
      const response = await page.goto(guestRoomUrl(HEX_ROOM));
      expect(response?.ok(), `guest origin ${origin} must serve the room page`).toBeTruthy();

      await page.evaluate(() => {
        document.cookie = '__Host-e2e-probe=ok; Secure; Path=/';
      });

      await expect.poll(
        async () => (await context.cookies(origin)).find((cookie) => cookie.name === '__Host-e2e-probe') ?? null,
        { timeout: 5000, message: '__Host- cookie was not stored on join.localhost; do not drop the prefix' },
      ).toMatchObject({
        name: '__Host-e2e-probe',
        value: 'ok',
        secure: true,
        path: '/',
      });

      const probePath = `/api/whiteboard/room/${HEX_ROOM}`;
      const cookieRequest = page.waitForRequest((pending) => {
        const url = new URL(pending.url());
        return url.pathname === probePath && url.searchParams.get('e2e') === 'host-cookie';
      });
      await page.evaluate((path) => fetch(path), `${probePath}?e2e=host-cookie`);
      const cookieHeader = (await (await cookieRequest).allHeaders())['cookie'] ?? '';
      expect(cookieHeader).toContain('__Host-e2e-probe=ok');
    } finally {
      await context.close();
    }
  });

  test('guest joins with PIN, syncs real drawing both ways, and is kicked', async ({ page, browser }) => {
    test.setTimeout(60_000);
    const roomId = await createRoomWithMaxUsers(page, 'GuestHost', 2);
    const pin = await enableGuestAndReadPin(page, roomId);

    const guestContext = await newGuestContext(browser);
    const guestPage = await guestContext.newPage();
    try {
      await guestPage.goto(guestRoomUrl(roomId));
      await expect(guestPage.getByTestId('guest-join-prompt')).toBeVisible({ timeout: 15000 });
      await guestPage.getByTestId('guest-join-name').fill('GuestAda');
      await guestPage.getByTestId('guest-join-pin').fill(pin);
      await guestPage.getByTestId('guest-join-submit').click();
      await expectWaiting(guestPage);

      await approveFirstWaitingPeer(page);
      await expect(guestPage.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
      await expectNotWaiting(guestPage);

      await drawPenStroke(page, [
        { x: 180, y: 180 },
        { x: 230, y: 220 },
        { x: 290, y: 175 },
        { x: 350, y: 230 },
      ]);
      await expectPenStrokes(page, 1);
      await expectPenStrokes(guestPage, 1);

      await drawPenStroke(guestPage, [
        { x: 420, y: 180 },
        { x: 470, y: 225 },
        { x: 530, y: 185 },
        { x: 590, y: 235 },
      ]);
      await expectPenStrokes(guestPage, 2);
      await expectPenStrokes(page, 2);

      const guestPeerId = await peerIdByName(page, 'GuestAda');
      await moderateApprovedPeer(page, guestPeerId, 'kick');

      await expect(guestPage.getByTestId('guest-join-prompt')).toBeVisible({ timeout: 15000 });
      await expect(guestPage.getByTestId('whiteboard-canvas-area')).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });

  test('a guest that never submits cannot reach the room API or signaling', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'GuestGateHost', 2);
    const guestContext = await newGuestContext(browser);
    const guestPage = await guestContext.newPage();
    try {
      await guestPage.goto(guestRoomUrl(roomId));
      await expect(guestPage.getByTestId('guest-join-prompt')).toBeVisible({ timeout: 15000 });

      const roomStatus = await guestPage.evaluate(async (id) => (
        await fetch(`/api/whiteboard/room/${id}`)
      ).status, roomId);
      expect(roomStatus).toBe(401);
      expect(await guestOriginGet(`/api/whiteboard/room/${roomId}`)).toBe(401);
      expect(await guestOriginGet(`/signaling?room=${encodeURIComponent(roomId)}`)).toBe(401);
    } finally {
      await guestContext.close();
    }
  });

  test('a wrong PIN shows the generic error and grants no session', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'GuestWrongPinHost', 2);
    const pin = (await patchGuestAccess(page, roomId, true)).body.guestPin;
    expect(pin).toMatch(/^\d{6}$/);

    const guestContext = await newGuestContext(browser);
    const guestPage = await guestContext.newPage();
    try {
      await guestPage.goto(guestRoomUrl(roomId));
      await expect(guestPage.getByTestId('guest-join-prompt')).toBeVisible({ timeout: 15000 });
      await guestPage.getByTestId('guest-join-name').fill('GuestBea');
      await guestPage.getByTestId('guest-join-pin').fill(wrongPin(String(pin)));
      await guestPage.getByTestId('guest-join-submit').click();

      await expect(guestPage.getByTestId('guest-join-error')).toHaveText(GUEST_PIN_ERROR, { timeout: 15000 });
      await expect(guestPage.getByTestId('guest-join-prompt')).toBeVisible();
      expect((await guestContext.cookies()).find((cookie) => cookie.name === GUEST_SESSION_COOKIE)).toBeUndefined();
    } finally {
      await guestContext.close();
    }
  });

  test('disabling guest access refuses the previous PIN', async ({ page, browser }) => {
    const roomId = await createRoomWithMaxUsers(page, 'GuestDisabledHost', 2);
    const enabled = await patchGuestAccess(page, roomId, true);
    const pin = enabled.body.guestPin;
    expect(enabled.status).toBe(200);
    expect(pin).toMatch(/^\d{6}$/);
    expect((await patchGuestAccess(page, roomId, false)).status).toBe(200);

    const guestContext = await newGuestContext(browser);
    const guestPage = await guestContext.newPage();
    try {
      await guestPage.goto(guestRoomUrl(roomId));
      await expect(guestPage.getByTestId('guest-join-prompt')).toBeVisible({ timeout: 15000 });
      await guestPage.getByTestId('guest-join-name').fill('GuestCara');
      await guestPage.getByTestId('guest-join-pin').fill(String(pin));
      await guestPage.getByTestId('guest-join-submit').click();

      await expect(guestPage.getByTestId('guest-join-error')).toHaveText(GUEST_PIN_ERROR, { timeout: 15000 });
      expect((await guestContext.cookies()).find((cookie) => cookie.name === GUEST_SESSION_COOKIE)).toBeUndefined();
    } finally {
      await guestContext.close();
    }
  });

  test('teacher-only routes 404 on the guest origin', async ({ browser }) => {
    const origin = guestOrigin();
    const guestContext = await newGuestContext(browser);
    const guestPage = await guestContext.newPage();
    try {
      await guestPage.goto(guestRoomUrl(HEX_ROOM));
      const statuses = await guestPage.evaluate(async () => {
        const paths = ['/auth/session', '/auth/account/export', '/api/whiteboard/rooms'];
        const result: Record<string, number> = {};
        for (const path of paths) {
          result[path] = (await fetch(path)).status;
        }
        return result;
      });
      expect(statuses['/auth/session']).toBe(404);
      expect(statuses['/auth/account/export']).toBe(404);
      expect(statuses['/api/whiteboard/rooms']).toBe(404);
      expect(origin).toContain('join.localhost');
    } finally {
      await guestContext.close();
    }
  });

  test('/auth/guest 404s on the teacher origin', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    const status = await page.evaluate(async () => (
      await fetch('/auth/guest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomId: 'a'.repeat(32),
          pin: '000000',
          displayName: 'Ada',
        }),
      })
    ).status);
    expect(status).toBe(404);
  });
});
