import { test, expect } from './fixtures';
import { request as httpRequest } from 'node:http';
import { appUrl, createRoomWithMaxUsers, expectSessionCookie, clickCreateRoom } from './helpers';

function rawProxyRequest(baseURL: string, cookie: string, assertion: string) {
  return new Promise<{ status: number; cacheControl?: string }>((resolve, reject) => {
    const request = httpRequest(new URL('/whiteboard', baseURL), {
      headers: {
        Cookie: cookie,
        'Cf-Access-Jwt-Assertion': assertion,
      },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        cacheControl: response.headers['cache-control'],
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

test.describe('local Access edge and session bootstrap', () => {
  test('bootstraps a secure session, reaches the API, and opens authenticated signaling', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);
    await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');

    // 403, not 401: the request cleared the Access edge and the local session,
    // and was then refused by room authorization for a room it does not belong
    // to. A non-member sees the same answer whether or not the room exists.
    const apiStatus = await page.evaluate(async () => (await fetch('/api/whiteboard/room/access-edge-probe')).status);
    expect(apiStatus).toBe(403);

    const roomId = await createRoomWithMaxUsers(page, 'AccessEdgeHost', 2);
    const signalingResult = await page.evaluate((room) => new Promise<string>((resolve) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/signaling?room=${encodeURIComponent(room)}`);
      const timer = window.setTimeout(() => {
        socket.close();
        resolve('timeout');
      }, 10000);
      socket.onopen = () => {
        window.clearTimeout(timer);
        socket.close();
        resolve('open');
      };
      socket.onerror = () => {
        window.clearTimeout(timer);
        resolve('error');
      };
    }), roomId);
    expect(signalingResult).toBe('open');
  });

  test('sends migrated SPA calls as same-origin AJAX and handles an expired Access session as JSON 401', async ({ page }) => {
    const issuer = process.env.E2E_ACCESS_ISSUER;
    if (!issuer) throw new Error('E2E_ACCESS_ISSUER is missing');

    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);
    await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');
    const originalURL = page.url();

    const tokenResponse = await fetch(`${issuer}/token?sub=e2e-expired-spa&variant=expired`);
    expect(tokenResponse.ok).toBe(true);
    const expiredToken = (await tokenResponse.json()).token as string;
    await page.context().addCookies([{
      name: 'CF_Authorization',
      value: expiredToken,
      domain: 'localhost',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 3_600,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }]);

    const apiRequest = page.waitForRequest((request) => (
      request.method() === 'POST'
      && new URL(request.url()).pathname.startsWith('/api/whiteboard/room/')
    ));
    const apiResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname.startsWith('/api/whiteboard/room/')
    ));
    await clickCreateRoom(page);

    const request = await apiRequest;
    expect((await request.allHeaders())['x-requested-with']).toBe('XMLHttpRequest');
    const response = await apiResponse;
    expect(response.status()).toBe(401);
    expect(response.headers()['content-type']).toContain('application/json');
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(response.headers()['location']).toBeUndefined();
    expect(page.url()).toBe(originalURL);
    await expect(page.getByText('This secure session is unavailable. Sign in again to continue.')).toBeVisible();
  });

  test('strips a forged assertion when a signed browser cookie is present', async ({ page }) => {
    const validToken = process.env.E2E_ACCESS_TOKEN;
    if (!validToken) throw new Error('E2E harness variables are missing');

    expect((await page.context().cookies()).find((cookie) => cookie.name === 'CF_Authorization')).toMatchObject({
      secure: true,
      httpOnly: true,
      path: '/',
    });
    await page.setExtraHTTPHeaders({ 'Cf-Access-Jwt-Assertion': 'forged-header-token' });
    const response = await page.goto(appUrl('/whiteboard'));

    expect(response?.status()).toBe(200);
    await expectSessionCookie(page);
    await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');
  });

  test('rejects caller assertions and malformed browser cookies', async ({ browser }) => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL;
    const validToken = process.env.E2E_ACCESS_TOKEN;
    if (!baseURL || !validToken) throw new Error('E2E harness variables are missing');

    const rejectedCookies = [
      { name: 'absent', cookies: [] },
      {
        name: 'malformed',
        cookies: [{
          name: 'CF_Authorization',
          value: 'not-a-jwt',
          domain: 'localhost',
          path: '/',
          expires: Math.floor(Date.now() / 1000) + 3_600,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax' as const,
        }],
      },
    ];

    for (const rejected of rejectedCookies) {
      const context = await browser.newContext({
        storageState: { cookies: rejected.cookies, origins: [] },
        extraHTTPHeaders: {
          'Cf-Access-Jwt-Assertion': validToken,
        },
      });
      try {
        const page = await context.newPage();
        const response = await page.goto(`${baseURL}/whiteboard`);
        expect(response?.status(), rejected.name).toBe(401);
        expect(response?.headers()['cache-control'], rejected.name).toBe('no-store');
        await expect(page.locator('body')).toContainText('Unauthorized');
      } finally {
        await context.close();
      }
    }

    for (const rejected of [
      { name: 'duplicate', cookie: `CF_Authorization=${validToken}; CF_Authorization=${validToken}` },
      { name: 'oversize', cookie: `CF_Authorization=${'x'.repeat(16_385)}` },
    ]) {
      const response = await rawProxyRequest(baseURL, rejected.cookie, validToken);
      expect(response.status, rejected.name).toBe(401);
      expect(response.cacheControl, rejected.name).toBe('no-store');
    }
  });

  test('rejects signaling upgrades without a signed browser cookie', async ({ browser }) => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL;
    const validToken = process.env.E2E_ACCESS_TOKEN;
    if (!baseURL || !validToken) throw new Error('E2E harness variables are missing');

    for (const rejected of [
      { name: 'absent', cookies: [] },
      {
        name: 'malformed',
        cookies: [{
          name: 'CF_Authorization',
          value: 'not-a-jwt',
          domain: 'localhost',
          path: '/',
          expires: Math.floor(Date.now() / 1000) + 3_600,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax' as const,
        }],
      },
    ]) {
      const context = await browser.newContext({
        storageState: { cookies: rejected.cookies, origins: [] },
        extraHTTPHeaders: {
          'Cf-Access-Jwt-Assertion': validToken,
        },
      });
      try {
        const page = await context.newPage();
        const response = await page.goto(`${baseURL}/whiteboard`);
        expect(response?.status(), rejected.name).toBe(401);
        expect(new URL(page.url()).origin, rejected.name).toBe(new URL(baseURL).origin);
        const signalingURL = new URL('/signaling?room=rejected-access', baseURL);
        signalingURL.protocol = 'ws:';
        const result = await page.evaluate((url) => new Promise<string>((resolve) => {
          const socket = new WebSocket(url);
          const timer = window.setTimeout(() => {
            socket.close();
            resolve('timeout');
          }, 10_000);
          socket.onopen = () => {
            window.clearTimeout(timer);
            socket.close();
            resolve('open');
          };
          socket.onerror = () => {
            window.clearTimeout(timer);
            resolve('error');
          };
        }), signalingURL.toString());
        expect(result, rejected.name).toBe('error');
      } finally {
        await context.close();
      }
    }
  });

  test('Sign out returns to the marketing landing, not the Access team logout URL', async ({ page }) => {
    await page.goto(appUrl('/whiteboard'));
    await expectSessionCookie(page);
    await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');

    await page.getByTestId('whiteboard-logout-btn').click();

    await expect(page).toHaveURL(appUrl('/'));
    expect(page.url()).not.toContain('cloudflareaccess.com');
    await expect(page.locator('h1')).toContainText('board remembers');
  });
});
