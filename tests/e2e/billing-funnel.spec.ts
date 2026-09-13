/**
 * Local unpaid-browser billing evidence.
 *
 * IMPLEMENTATION_SPEC.md §7.6 local e2e row: the browser path reachable with
 * Stripe unset and nothing seeded — Free behavior, route guards, guest denial,
 * and the checkout/portal unavailable state. §13 names this file; §11.2 is the
 * profile plan section; §14 asks the redirect page to show Free and the guest
 * e2e to deny a student any billing route.
 *
 * What this spec does not do, by design (§7.6): it never seeds paid state,
 * never fakes a webhook, and never claims a redirect grants an entitlement.
 * The paid, multi-seat, and webhook paths are worker/staging evidence.
 */

import { test, expect } from './fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import {
  appUrl,
  createRoomWithMaxUsers,
  expectSessionCookie,
} from './helpers';
import { guestOrigin } from './origins';

const PLAN_SUMMARY = 'whiteboard-profile-plan';
const UPGRADE_BUTTON = 'whiteboard-profile-plan-upgrade';
const BILLING_ERROR = 'whiteboard-profile-plan-error';
const CHECKOUT_PATH = '/api/billing/checkout';
const PORTAL_PATH = '/api/billing/portal';

const CARD_FIELD_SELECTORS = [
  'input[autocomplete^="cc-"]',
  'input[name*="card" i]',
  'input[name*="cvc" i]',
  'input[name*="cvv" i]',
  'input[name*="expiry" i]',
  'input[placeholder*="card number" i]',
  'iframe[src*="js.stripe.com"]',
  'iframe[src*="checkout.stripe.com"]',
];

function newGuestContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    storageState: { cookies: [], origins: [] },
    baseURL: guestOrigin(),
  });
}

function guestRoomUrl(roomId: string): string {
  return new URL(`/whiteboard/${roomId}`, guestOrigin()).toString();
}

async function openProfileMenu(page: Page) {
  await page.getByTestId('whiteboard-profile-btn').click();
}

async function expectFreePlan(page: Page) {
  await expect(page.getByTestId(PLAN_SUMMARY)).toHaveText('Free');
}

/** A browser POST from the page, so it carries the session cookie and Origin. */
function billingPost(
  page: Page,
  path: string,
  body: unknown,
): Promise<{ status: number; text: string }> {
  return page.evaluate(
    async (request: { path: string; body: unknown }) => {
      const response = await fetch(request.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
      });
      return { status: response.status, text: await response.text() };
    },
    { path, body },
  );
}

/**
 * Mirrors guest-join.spec.ts: mints a real PIN on the room row so the guest
 * below is admitted through the product, not a shortcut.
 */
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

test.describe('billing funnel with Stripe unset', () => {
  test('a Free teacher sees the Free plan summary and no client-invented billing URL', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);

    await openProfileMenu(page);
    await expectFreePlan(page);
    await expect(page.getByTestId('whiteboard-profile-plan-manage')).toHaveCount(0);

    const upgrade = page.getByTestId(UPGRADE_BUTTON);
    await expect(upgrade).toBeVisible();
    await expect(upgrade).toHaveJSProperty('tagName', 'BUTTON');
    await expect(upgrade).not.toHaveAttribute('href', /.+/);

    const menu = page.getByRole('menu');
    await expect(menu.locator('a[href*="stripe"], a[href*="billing"], a[href*="checkout"]'))
      .toHaveCount(0);
  });

  test('authenticated checkout and portal answer 503 Billing unavailable while Stripe is unset', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);

    const checkout = await billingPost(page, CHECKOUT_PATH, {
      planId: 'tutor_pro_monthly',
      operationId: 'op_e2e_checkout_unset',
    });
    expect(checkout.status).toBe(503);
    expect(JSON.parse(checkout.text)).toEqual({ error: 'Billing unavailable' });
    expect(checkout.text).not.toContain('url');
    expect(checkout.text).not.toContain('stripe.com');

    const portal = await billingPost(page, PORTAL_PATH, {
      operationId: 'op_e2e_portal_unset',
    });
    expect(portal.status).toBe(503);
    expect(JSON.parse(portal.text)).toEqual({ error: 'Billing unavailable' });
    expect(portal.text).not.toContain('url');
  });

  test('pressing Upgrade surfaces the unavailable state and does not navigate', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);
    await openProfileMenu(page);
    await expectFreePlan(page);

    const [response] = await Promise.all([
      page.waitForResponse(
        (candidate) => new URL(candidate.url()).pathname === CHECKOUT_PATH,
      ),
      page.getByTestId(UPGRADE_BUTTON).click(),
    ]);
    expect(response.status()).toBe(503);
    expect(response.headers()['content-type']).toContain('application/json');
    expect(response.headers()['location']).toBeUndefined();

    await expect(page.getByTestId(BILLING_ERROR)).toBeVisible();
    await expect(page.getByTestId(BILLING_ERROR)).toContainText('Could not open billing');
    await expect(page).toHaveURL(appUrl('/whiteboard'));
  });

  test('a billing redirect alone grants nothing: the badge stays Free', async ({ page }) => {
    for (const returnPath of ['/whiteboard?billing=success', '/whiteboard?billing=portal']) {
      await page.goto(appUrl(returnPath));
      await expectSessionCookie(page);
      await openProfileMenu(page);
      await expectFreePlan(page);

      await expect.poll(
        () => page.evaluate(async () => {
          const response = await fetch('/auth/session/current');
          const body: unknown = await response.json();
          if (!body || typeof body !== 'object') return null;
          const plan = (body as { plan?: unknown }).plan;
          if (!plan || typeof plan !== 'object') return null;
          return (plan as { planId?: unknown }).planId ?? null;
        }),
        { timeout: 15000, message: `${returnPath} must not change the server-resolved plan` },
      ).toBe('free');
    }
  });

  test('no billing entry surface renders card fields', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);
    await openProfileMenu(page);
    await page.getByTestId(UPGRADE_BUTTON).click();
    await expect(page.getByTestId(BILLING_ERROR)).toBeVisible();

    for (const selector of CARD_FIELD_SELECTORS) {
      await expect(page.locator(selector)).toHaveCount(0);
    }

    await page.goto(appUrl('/pricing'));
    await expect(page.locator('h1')).toContainText('Plain pricing for tutors');
    for (const selector of CARD_FIELD_SELECTORS) {
      await expect(page.locator(selector)).toHaveCount(0);
    }
  });

  test('an authenticated guest cannot reach checkout or portal from the guest host', async ({ browser, page }) => {
    test.setTimeout(60_000);
    const roomId = await createRoomWithMaxUsers(page, 'BillingGuestHost', 2);
    const pin = await enableGuestAndReadPin(page, roomId);

    const guestContext = await newGuestContext(browser);
    const guestPage = await guestContext.newPage();
    try {
      await guestPage.goto(guestRoomUrl(roomId));
      await expect(guestPage.getByTestId('guest-join-prompt')).toBeVisible({ timeout: 15000 });
      await guestPage.getByTestId('guest-join-name').fill('BillingStudent');
      await guestPage.getByTestId('guest-join-pin').fill(pin);
      await guestPage.getByTestId('guest-join-submit').click();

      await expect.poll(
        async () => (await guestContext.cookies(guestOrigin()))
          .find((cookie) => cookie.name === '__Host-teacher-guest')?.value ?? null,
        { timeout: 15000, message: 'guest PIN admission should issue a real guest session' },
      ).toBeTruthy();

      const checkout = await billingPost(guestPage, CHECKOUT_PATH, {
        planId: 'tutor_pro_monthly',
        operationId: 'op_e2e_guest_checkout',
      });
      expect(checkout.status).toBe(404);
      expect(checkout.text).not.toContain('Billing unavailable');
      expect(checkout.text).not.toContain('operationId');
      expect(checkout.text).not.toContain('accountId');
      expect(checkout.text).not.toContain('stripe');

      const portal = await billingPost(guestPage, PORTAL_PATH, {
        operationId: 'op_e2e_guest_portal',
      });
      expect(portal.status).toBe(404);
      expect(portal.text).not.toContain('Billing unavailable');
      expect(portal.text).not.toContain('operationId');
      expect(portal.text).not.toContain('accountId');
      expect(portal.text).not.toContain('stripe');
    } finally {
      await guestContext.close();
    }
  });
});
