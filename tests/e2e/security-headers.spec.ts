import { test, expect } from './fixtures';
import type { APIRequestContext, Browser } from '@playwright/test';
import {
  appUrl,
  createRoomWithMaxUsers,
  expectSessionCookie,
  liveKitConfigured,
  unusedHexRoomId,
  waitForExcalidrawApi,
} from './helpers';
import { guestOrigin, marketingOrigin } from './origins';

/**
 * Per-host response-header evidence for SEC-A22 and SEC-A23.
 *
 * `withSecurityHeaders` (src/lib/worker/requestGuard.ts) is host-agnostic, but
 * the audit acceptance is per host kind: teacher, guest, and marketing all
 * have to prove it from the outside, and the COOP/CORP/CSP trio has to survive
 * a real Excalidraw board with the A/V affordance intact.
 *
 * `form-action` is asserted on HTML only. `withSecurityHeaders` emits
 * `Content-Security-Policy` on `text/html` and not on JSON, so an API probe
 * proves the transport/origin trio, and the policy directives are proven on
 * the HTML each host serves.
 *
 * HSTS is asserted exactly, which pins the deliberate omission of `preload`
 * recorded in spec/IMPLEMENTATION_SPEC.md §12 Phase 7: a preload token would
 * commit the whole `sen-tutor.co.uk` zone, which is the zone owner's call.
 */

const HSTS = 'max-age=31536000; includeSubDomains';
const COOP = 'same-origin';
const CORP = 'same-origin';
const CSP_FORM_ACTION = "form-action 'self'";

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

/** A fresh request per retry, so a slow Worker is waited out rather than sampled. */
function headerPoll(request: APIRequestContext, url: string, name: string) {
  return expect.poll(
    async () => (await request.get(url)).headers()[name] ?? '',
    { message: `${name} missing on ${url}` },
  );
}

function statusPoll(request: APIRequestContext, url: string, expected: number) {
  return expect.poll(
    async () => (await request.get(url)).status(),
    { message: `${url} did not answer ${expected}` },
  ).toBe(expected);
}

async function expectBaselineHeaders(request: APIRequestContext, url: string) {
  await headerPoll(request, url, 'strict-transport-security').toBe(HSTS);
  await headerPoll(request, url, 'cross-origin-opener-policy').toBe(COOP);
  await headerPoll(request, url, 'cross-origin-resource-policy').toBe(CORP);
}

async function expectFormActionCsp(request: APIRequestContext, url: string) {
  await headerPoll(request, url, 'content-security-policy').toContain(CSP_FORM_ACTION);
}

function cookieFreeContext(browser: Browser) {
  return browser.newContext({ storageState: { cookies: [], origins: [] } });
}

test.describe('per-host security headers (SEC-A22/A23)', () => {
  test('teacher host carries HSTS, COOP, and CORP on API 2xx and 4xx, and form-action on HTML', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);

    const htmlUrl = appUrl('/whiteboard');
    await statusPoll(page.request, htmlUrl, 200);
    await expectBaselineHeaders(page.request, htmlUrl);
    await expectFormActionCsp(page.request, htmlUrl);

    const listUrl = appUrl('/api/whiteboard/rooms');
    await statusPoll(page.request, listUrl, 200);
    await expectBaselineHeaders(page.request, listUrl);

    const forbiddenUrl = appUrl(`/api/whiteboard/room/${unusedHexRoomId()}`);
    await statusPoll(page.request, forbiddenUrl, 403);
    await expectBaselineHeaders(page.request, forbiddenUrl);

    const missingUrl = appUrl('/api/whiteboard/no-such-route');
    await statusPoll(page.request, missingUrl, 404);
    await expectBaselineHeaders(page.request, missingUrl);
  });

  test('guest host carries the same four headers on a guest room page', async ({ browser }) => {
    const context = await cookieFreeContext(browser);
    try {
      const guestPage = await context.newPage();
      const roomUrl = new URL(`/whiteboard/${unusedHexRoomId()}`, guestOrigin()).toString();

      await guestPage.goto(roomUrl);
      await expect(guestPage.getByTestId('guest-join-prompt')).toBeVisible({ timeout: 15000 });

      await statusPoll(guestPage.request, roomUrl, 200);
      await expectBaselineHeaders(guestPage.request, roomUrl);
      await expectFormActionCsp(guestPage.request, roomUrl);
    } finally {
      await context.close();
    }
  });

  test('marketing host carries the same four headers on /pricing', async ({ browser }) => {
    const context = await cookieFreeContext(browser);
    try {
      const marketingPage = await context.newPage();
      const pricingUrl = new URL('/pricing', marketingOrigin()).toString();

      await marketingPage.goto(pricingUrl);
      await expect(marketingPage.locator('h1')).toBeVisible({ timeout: 15000 });

      await statusPoll(marketingPage.request, pricingUrl, 200);
      await expectBaselineHeaders(marketingPage.request, pricingUrl);
      await expectFormActionCsp(marketingPage.request, pricingUrl);
    } finally {
      await context.close();
    }
  });

  test('a board still renders and the A/V panel still starts under the policy', async ({ page }) => {
    test.setTimeout(60_000);
    const roomId = await createRoomWithMaxUsers(page, 'SecurityHeadersHost', 1);
    const boardUrl = appUrl(`/whiteboard/${roomId}`);

    await expectBaselineHeaders(page.request, boardUrl);
    await expectFormActionCsp(page.request, boardUrl);

    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();
    await waitForExcalidrawApi(page);
    await expect(page.locator('canvas.excalidraw__canvas.interactive').first()).toBeAttached();

    /*
     * COOP can sever the LiveKit session and CORP can refuse its media, so the
     * panel has to actually start, not merely exist. LiveKit is optional in an
     * E2E environment: without it the room answers 503 and the test proves the
     * affordance survived the policy instead of skipping everything.
     */
    if (await liveKitConfigured(page, roomId)) {
      await page.getByTestId('av-start-call').click();
      await expect(page.getByTestId('av-session-panel')).toBeVisible({ timeout: 20000 });
    } else {
      await expect(page.getByTestId('av-start-call')).toBeVisible();
    }
  });
});
