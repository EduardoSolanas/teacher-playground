import { test, expect } from './fixtures';
import type { Cookie } from '@playwright/test';
import { appUrl, expectSessionCookie, newAuthenticatedContext, createRoomWithMaxUsers } from './helpers';

/**
 * Auth and security boundary coverage that complements access-session.spec.ts
 * (Access edge verification, forged assertions, expired sessions) and
 * room-authorization.spec.ts (cross-account CSRF/authorization matrix).
 *
 * This file focuses on: CSP nonce wiring as seen by a real browser, session
 * cookie security attributes, the origin guard's read/write boundary, full
 * session lifecycle (bootstrap -> logout -> re-bootstrap), cookie-swap
 * account isolation, blanket security headers, and the destructive-action
 * reauthentication gate.
 */

const SESSION_COOKIE = '__Host-teacher-session';

function sessionCookieOf(cookies: Cookie[]) {
  return cookies.find((c) => c.name === SESSION_COOKIE);
}

test.describe('CSP nonce wiring (browser-rendered)', () => {
  test('the /whiteboard response carries a CSP nonce and the page hydrates past the loading screen', async ({ page }) => {
    const response = await page.goto(appUrl('/whiteboard'));
    expect(response?.status()).toBe(200);

    const csp = response?.headers()['content-security-policy'] ?? '';
    const nonce = /nonce-([a-f0-9]+)/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("'strict-dynamic'");
    expect(response?.headers()['cache-control']).toBe('no-store');

    // Would fail if nonces were generated but never wired into the CSP
    // header, or vice versa: the app would hang on the loading screen
    // because 'self' script-src blocks Next's inline bootstrap scripts.
    await expect(page.getByText('Loading secure session…')).toHaveCount(0, { timeout: 15000 });
    await expectSessionCookie(page);
    await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');

    // Browsers hide the nonce DOM attribute after parsing (CSP nonce-hiding),
    // so verify the raw HTTP response body carries nonces on every script tag.
    const rawHtml = await response!.text();
    const scriptTags = rawHtml.match(/<script[^>]*>/g) ?? [];
    expect(scriptTags.length).toBeGreaterThan(0);
    const withoutNonce = scriptTags.filter((tag) => !tag.includes(`nonce="${nonce}"`));
    expect(withoutNonce).toEqual([]);
  });

  test('each page load gets a unique nonce', async ({ page }) => {
    const first = await page.goto(appUrl('/whiteboard'));
    const firstNonce = /nonce-([a-f0-9]+)/.exec(first?.headers()['content-security-policy'] ?? '')?.[1];
    const second = await page.reload();
    const secondNonce = /nonce-([a-f0-9]+)/.exec(second?.headers()['content-security-policy'] ?? '')?.[1];

    expect(firstNonce).toBeTruthy();
    expect(secondNonce).toBeTruthy();
    expect(firstNonce).not.toBe(secondNonce);
  });
});

test.describe('session cookie security properties', () => {
  test('the session cookie carries the __Host- security contract', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);

    const cookie = sessionCookieOf(await page.context().cookies());
    expect(cookie).toMatchObject({
      name: SESSION_COOKIE,
      secure: true,
      httpOnly: true,
      path: '/',
      sameSite: 'Lax',
    });
    // __Host- prefixed cookies are Domain-less by spec (enforced by the
    // browser, not just convention); the request guard depends on that.
    expect(cookie?.domain).not.toMatch(/^\./);
  });

  test('the session cookie value is unchanged across a page reload', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);
    const before = sessionCookieOf(await page.context().cookies())?.value;

    await page.reload();
    await expectSessionCookie(page);
    const after = sessionCookieOf(await page.context().cookies())?.value;

    expect(after).toBe(before);
  });

  test('logout clears the session cookie with Max-Age=0', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);

    // page.request is a Node-side HTTP client: unlike a real page fetch() it
    // does not attach Origin automatically, so the origin guard needs it set
    // explicitly here.
    const logoutResponse = await page.request.post(appUrl('/auth/session/logout'), {
      headers: { Origin: new URL(appUrl('/')).origin },
    });
    expect(logoutResponse.status()).toBe(204);
    const setCookie = logoutResponse.headers()['set-cookie'] ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=;`);
    expect(setCookie).toMatch(/Max-Age=0/);

    expect(sessionCookieOf(await page.context().cookies())).toBeUndefined();
  });
});

test.describe('origin guard on mutations', () => {
  test('a POST without an Origin header is rejected, with an Origin it is accepted, and reads bypass the guard', async ({ page }) => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL;
    if (!baseURL) throw new Error('PLAYWRIGHT_BASE_URL is not set; run via npm run test:e2e');

    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);
    const cookie = (await page.context().cookies())
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    const roomId = `origin-guard-${Date.now()}`;

    // No Origin header at all (raw fetch outside the browser's automatic
    // Origin attachment, mirroring a non-browser client or a bare CSRF POST).
    const noOrigin = await fetch(new URL(`/api/whiteboard/room/${roomId}`, baseURL), {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    });
    expect(noOrigin.status).toBe(403);
    expect(await noOrigin.json()).toEqual({ error: 'Origin required' });

    // Wrong Origin.
    const wrongOrigin = await fetch(new URL(`/api/whiteboard/room/${roomId}`, baseURL), {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    });
    expect(wrongOrigin.status).toBe(403);

    // Correct Origin succeeds.
    const correctOrigin = await fetch(new URL(`/api/whiteboard/room/${roomId}`, baseURL), {
      method: 'POST',
      headers: { Cookie: cookie, Origin: new URL(baseURL).origin, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    });
    expect(correctOrigin.status).toBe(200);

    // Safe methods are exempt from the guard even with no Origin header.
    const get = await fetch(new URL(`/api/whiteboard/room/${roomId}`, baseURL), { headers: { Cookie: cookie } });
    expect(get.status).toBe(200);

    const head = await fetch(new URL(`/api/whiteboard/room/${roomId}`, baseURL), { method: 'HEAD', headers: { Cookie: cookie } });
    expect(head.status).not.toBe(403);
  });
});

test.describe('session lifecycle', () => {
  test('bootstrap, use, logout, and re-bootstrap all work in sequence', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);
    const firstToken = sessionCookieOf(await page.context().cookies())?.value;

    const beforeLogout = await page.evaluate(async () => (await fetch('/auth/session/current')).status);
    expect(beforeLogout).toBe(200);

    const logoutStatus = await page.evaluate(async () => (await fetch('/auth/session/logout', { method: 'POST' })).status);
    expect(logoutStatus).toBe(204);

    const afterLogout = await page.evaluate(async () => (await fetch('/auth/session/current')).status);
    expect(afterLogout).toBe(401);

    // App logout alone leaves CF_Authorization, so a fresh navigation can mint a new local session.
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);
    const secondToken = sessionCookieOf(await page.context().cookies())?.value;
    expect(secondToken).toBeTruthy();
    expect(secondToken).not.toBe(firstToken);

    const afterRebootstrap = await page.evaluate(async () => (await fetch('/auth/session/current')).status);
    expect(afterRebootstrap).toBe(200);
  });

  test('profile Sign out clears CF_Authorization so the next visit does not auto-enter', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);

    await page.getByTestId('whiteboard-profile-btn').click();
    await page.getByTestId('whiteboard-logout-btn').click();
    await expect(page).toHaveURL(appUrl('/'));

    expect((await page.context().cookies()).find((cookie) => cookie.name === 'CF_Authorization')).toBeUndefined();

    await page.goto(appUrl('/whiteboard'));
    expect((await page.context().cookies()).find((cookie) => cookie.name === '__Host-teacher-session')).toBeUndefined();
  });

  test('concurrent sessions for two different accounts stay isolated', async ({ browser }) => {
    const userA = await newAuthenticatedContext(browser);
    const userB = await newAuthenticatedContext(browser);
    try {
      const pageA = await userA.newPage();
      const pageB = await userB.newPage();
      await pageA.goto(appUrl('/whiteboard'));
      await pageB.goto(appUrl('/whiteboard'));
      await expectSessionCookie(pageA);
      await expectSessionCookie(pageB);

      const accountIdA = await pageA.evaluate(async () => (await (await fetch('/auth/session/current')).json()).accountId);
      const accountIdB = await pageB.evaluate(async () => (await (await fetch('/auth/session/current')).json()).accountId);
      expect(accountIdA).toBeTruthy();
      expect(accountIdB).toBeTruthy();
      expect(accountIdA).not.toBe(accountIdB);

      // Logging one account out must not affect the other's session.
      await pageA.evaluate(async () => fetch('/auth/session/logout', { method: 'POST' }));
      expect(await pageA.evaluate(async () => (await fetch('/auth/session/current')).status)).toBe(401);
      expect(await pageB.evaluate(async () => (await fetch('/auth/session/current')).status)).toBe(200);
    } finally {
      await userA.close();
      await userB.close();
    }
  });
});

test.describe('account isolation via cookie swap', () => {
  test('account A\'s session cookie does not authenticate account B\'s Access identity', async ({ browser }) => {
    const contextA = await newAuthenticatedContext(browser, `swap-a-${Date.now()}`);
    const contextB = await newAuthenticatedContext(browser, `swap-b-${Date.now()}`);
    try {
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();
      await pageA.goto(appUrl('/whiteboard'));
      await pageB.goto(appUrl('/whiteboard'));
      await expectSessionCookie(pageA);
      await expectSessionCookie(pageB);

      const sessionCookieA = sessionCookieOf(await contextA.cookies());
      expect(sessionCookieA).toBeTruthy();

      // Graft A's local session token onto B's browser, which still carries
      // B's own CF_Authorization (Access identity) cookie.
      await contextB.addCookies([{
        name: SESSION_COOKIE,
        value: sessionCookieA!.value,
        domain: sessionCookieA!.domain,
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      }]);

      const status = await pageB.evaluate(async () => (await fetch('/auth/session/current')).status);
      expect(status).toBe(401);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

test.describe('security headers on every response', () => {
  test('the shared header baseline is present on HTML, JSON API, and unknown-route responses', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);

    const htmlResponse = await page.request.get(appUrl('/whiteboard'));
    const apiResponse = await page.request.get(appUrl('/auth/session/current'));
    const missingResponse = await page.request.get(appUrl('/this-route-does-not-exist'));

    for (const response of [htmlResponse, apiResponse, missingResponse]) {
      const headers = response.headers();
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['permissions-policy']).toContain('camera=()');
      expect(headers['permissions-policy']).toContain('microphone=()');
      expect(headers['cache-control']).toBe('no-store');
    }
  });
});

test.describe('re-authentication for destructive actions', () => {
  test('a freshly bootstrapped session may delete its own room without a separate confirmation', async ({ page }) => {
    // sessionAllowsDestructiveAction() treats any session younger than 5
    // minutes as fresh, so a room created moments after bootstrap can be
    // deleted immediately. The 403-after-staleness branch itself needs a
    // session older than 5 minutes to trigger, which src/do/roomDelete.workers.test.ts
    // already covers by backdating the session row directly in the DB; that
    // isn't reachable from an HTTP-only e2e client in a 30s test budget.
    const roomId = await createRoomWithMaxUsers(page, 'ReauthHost', 2);
    const status = await page.evaluate(async (id) => (await fetch(`/api/whiteboard/room/${id}`, { method: 'DELETE' })).status, roomId);
    expect(status).toBe(200);
  });

  test('POST /auth/session/confirm re-confirms the session and keeps destructive actions available', async ({ page }) => {
    const roomId = await createRoomWithMaxUsers(page, 'ReauthConfirmHost', 2);

    const confirmed = await page.evaluate(async () => {
      const response = await fetch('/auth/session/confirm', { method: 'POST' });
      return { status: response.status, body: await response.json() };
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.confirmedAt).toBeGreaterThan(0);

    const status = await page.evaluate(async (id) => (await fetch(`/api/whiteboard/room/${id}`, { method: 'DELETE' })).status, roomId);
    expect(status).toBe(200);
  });
});
