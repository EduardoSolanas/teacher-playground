import { test, expect } from './fixtures';
import type { Browser, Page } from '@playwright/test';
import { request as httpRequest } from 'node:http';
import {
  appUrl,
  appendElement,
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

function rectangle(id: string, x: number, y: number) {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 200,
    height: 120,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 12345,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

async function sceneElementIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const api = (window as unknown as { __debugExcalidrawApi?: { getSceneElements?: () => { id: string }[] } }).__debugExcalidrawApi;
    return (api?.getSceneElements?.() ?? []).map((element) => element.id);
  });
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
    await list.getByTestId(`whiteboard-room-menu-${roomId}`).click();
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

  test('guest joins with PIN, is admitted, draws, and is kicked', async ({ page, browser }) => {
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

      const elementId = 'guest-drawn-rect-1';
      await appendElement(guestPage, rectangle(elementId, 160, 120));
      await expect.poll(async () => sceneElementIds(page), { timeout: 20000 }).toContain(elementId);

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
