import { test, expect } from './fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import {
  appUrl,
  createRoomWithMaxUsers,
  expectSessionCookie,
} from './helpers';
import { guestOrigin } from './origins';

const REFERRAL_PATH = '/api/referrals/me';
const GUEST_SESSION_COOKIE = '__Host-teacher-guest';

function newGuestContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    storageState: { cookies: [], origins: [] },
    baseURL: guestOrigin(),
  });
}

function guestRoomUrl(roomId: string): string {
  return new URL(`/whiteboard/${roomId}`, guestOrigin()).toString();
}

async function enableGuestAndReadPin(teacherPage: Page, roomId: string): Promise<string> {
  const list = await teacherPage.context().newPage();
  try {
    await list.goto(appUrl('/whiteboard'));
    await expect(list.getByTestId(`whiteboard-room-list-item-${roomId}`))
      .toBeVisible({ timeout: 15000 });
    await list.getByTestId(`whiteboard-room-pin-new-${roomId}`).click();
    await expect(list.getByTestId(`whiteboard-room-pin-${roomId}`))
      .toHaveText(/^\d{3} \d{3}$/, { timeout: 15000 });
    const shown = (await list.getByTestId(`whiteboard-room-pin-${roomId}`).innerText()).trim();
    return shown.replace(/\s/g, '');
  } finally {
    await list.close();
  }
}

test('the profile menu lazy-loads the referral summary and shows the empty state without a code', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === REFERRAL_PATH) requests.push(request.url());
  });

  await page.goto(appUrl('/whiteboard'));
  await expectSessionCookie(page);
  const profileButton = page.getByTestId('whiteboard-profile-btn');
  await expect(profileButton).toBeVisible({ timeout: 20000 });
  expect(requests).toEqual([]);

  await profileButton.click();
  await expect(page.getByTestId('referral-empty')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByTestId('referral-panel')).toHaveCount(0);
  await expect(page.getByTestId('referral-code')).toHaveCount(0);
  await expect(page.getByTestId('referral-counter')).toHaveCount(0);
  await expect(page.getByTestId('whiteboard-copy-btn')).toHaveCount(0);

  const summary = await page.evaluate(async (path) => {
    const response = await fetch(path);
    return { status: response.status, body: await response.json() };
  }, REFERRAL_PATH);
  expect(summary.status).toBe(200);
  expect(summary.body).toEqual({
    code: null,
    link: null,
    pendingCount: 0,
    confirmedCount: 0,
    redemptionCount: 0,
  });
});

test('a guest student session cannot reach the referral route', async ({ page, browser }) => {
  test.setTimeout(60_000);
  const roomId = await createRoomWithMaxUsers(page, 'ReferralGuestHost', 2);
  const pin = await enableGuestAndReadPin(page, roomId);

  const guestContext = await newGuestContext(browser);
  const guestPage = await guestContext.newPage();
  try {
    await guestPage.goto(guestRoomUrl(roomId));
    await expect(guestPage.getByTestId('guest-join-prompt')).toBeVisible({ timeout: 15000 });
    await guestPage.getByTestId('guest-join-name').fill('ReferralStudent');
    await guestPage.getByTestId('guest-join-pin').fill(pin);
    await guestPage.getByTestId('guest-join-submit').click();

    await expect.poll(
      async () => (await guestContext.cookies(guestOrigin()))
        .find((cookie) => cookie.name === GUEST_SESSION_COOKIE)?.value ?? null,
      { timeout: 15000, message: 'guest PIN admission should issue a real guest session' },
    ).toBeTruthy();

    const denied = await guestPage.evaluate(async (path) => {
      const response = await fetch(path);
      return { status: response.status, text: await response.text() };
    }, REFERRAL_PATH);
    expect(denied.status).toBe(404);
    expect(denied.text).not.toContain('code');
    expect(denied.text).not.toContain('referral');
  } finally {
    await guestContext.close();
  }
});

test('the referral route requires the app session even when Access authenticated the browser', async ({ page }) => {
  await page.goto(appUrl('/pricing'));
  const cookies = await page.context().cookies(appUrl('/'));
  expect(cookies.find((cookie) => cookie.name === '__Host-teacher-session')).toBeUndefined();

  const denied = await page.evaluate(async (path) => {
    const response = await fetch(path);
    return { status: response.status, text: await response.text() };
  }, REFERRAL_PATH);
  expect(denied.status).toBe(401);
  expect(denied.text).not.toContain('"code"');
  expect(denied.text).not.toContain('"link"');
});

test('a tutor with a live code sees the link, counter and clipboard copy', async () => {
  test.skip(true, 'no production flow mints a referral code and §7.6 forbids seeding paid or referral state, so the code/link/copy state cannot be reached locally.');
});
