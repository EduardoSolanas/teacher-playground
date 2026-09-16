import { test, expect } from './fixtures';
import type { Browser, Page } from '@playwright/test';
import { appUrl, expectSessionCookie } from './helpers';
import { cfAuthorizationCookie } from './origins';

/**
 * The /admin surface through the real local Access edge and workerd.
 *
 * `scripts/run-e2e.mjs` starts the worker with `ADMIN_EMAILS:admin@example.test`,
 * so this file hardcodes that address for the admin subject. The disabled
 * surface (404 when the allowlist is unset) cannot be reached from this
 * environment and is owned by src/worker.admin.workers.test.ts.
 */

const ADMIN_EMAIL = 'admin@example.test';

/**
 * Mints a fresh Access assertion for `subject`, optionally carrying `email`.
 * The local issuer only writes claims.email when the query parameter is
 * non-empty, so a token without it is the "stranger with no email" identity.
 */
async function accessTokenFor(subject: string, email?: string): Promise<string> {
  const issuer = process.env.E2E_ACCESS_ISSUER;
  if (!issuer) throw new Error('E2E_ACCESS_ISSUER is not set; run via npm run test:e2e');
  const params = new URLSearchParams({ sub: subject });
  if (email) params.set('email', email);
  const response = await fetch(`${issuer}/token?${params.toString()}`);
  if (!response.ok) throw new Error(`local issuer token failed: ${response.status}`);
  return ((await response.json()) as { token: string }).token;
}

/**
 * Signs in on the teacher host and returns its page. The session bootstrap
 * component is mounted under /whiteboard only, so the local session has to be
 * minted there before /admin's panel can talk to its API.
 */
async function signedInPage(
  browser: Browser,
  subject: string,
  email?: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const token = await accessTokenFor(subject, email);
  const context = await browser.newContext({
    storageState: {
      cookies: [cfAuthorizationCookie(token)],
      origins: [],
    },
  });
  const page = await context.newPage();
  await page.goto(appUrl('/whiteboard'));
  await expectSessionCookie(page);
  return { page, close: () => context.close() };
}

/** Same-origin fetch from inside the page, so it carries the session cookie. */
function apiStatus(page: Page, path: string, init?: RequestInit): Promise<number> {
  return page.evaluate(
    async ({ path, init }) => (await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    } as RequestInit)).status,
    { path, init: init ?? null } as { path: string; init: RequestInit | null },
  );
}

function apiCall(
  page: Page,
  path: string,
): Promise<{ status: number; json: unknown }> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, {
      headers: { 'content-type': 'application/json' },
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, json };
  }, path);
}

test.describe('the admin surface across accounts', () => {
  test('the allowlisted admin sees the account list', async ({ browser }) => {
    const admin = await signedInPage(browser, 'admin-e2e', ADMIN_EMAIL);

    try {
      await admin.page.goto(appUrl('/admin'));
      const rows = admin.page.locator('[data-testid^="admin-user-"]');
      await expect(admin.page.getByTestId('admin-users')).toBeVisible();
      await expect(rows.first()).toBeVisible();
      await expect(admin.page.getByTestId('admin-users-total')).toContainText(/^[1-9]\d* accounts?$/);

      // The signed-in account itself is on the list.
      const current = await apiCall(admin.page, '/auth/session/current');
      expect(current.status).toBe(200);
      const accountId = (current.json as { accountId?: string }).accountId;
      expect(accountId).toBeTruthy();
      await expect(admin.page.getByTestId(`admin-user-${accountId}`)).toBeVisible();

      expect(await apiStatus(admin.page, '/api/admin/users')).toBe(200);
    } finally {
      await admin.close();
    }
  });

  test('a stranger without an allowlisted email is denied and sees no account ids', async ({ browser }) => {
    // No email query parameter: the issuer omits claims.email entirely, and a
    // principal with no email must never satisfy the allowlist.
    const stranger = await signedInPage(browser, `admin-stranger-${Date.now()}`);

    try {
      await stranger.page.goto(appUrl('/admin'));
      await expect(stranger.page.getByTestId('admin-denied')).toBeVisible();

      const denied = await apiCall(stranger.page, '/api/admin/users');
      expect(denied.status).toBe(403);
      expect(denied.json).toEqual({ error: 'Forbidden' });

      // The stranger's own account exists, and its id must not appear anywhere
      // on the page the denial renders.
      const current = await apiCall(stranger.page, '/auth/session/current');
      expect(current.status).toBe(200);
      const accountId = (current.json as { accountId?: string }).accountId;
      expect(accountId).toBeTruthy();
      expect(await stranger.page.content()).not.toContain(accountId!);
      expect(await apiStatus(stranger.page, '/api/admin/users')).toBe(403);
    } finally {
      await stranger.close();
    }
  });

  test('the denial response carries the COOP and CORP headers', async ({ browser }) => {
    const stranger = await signedInPage(browser, `admin-headers-${Date.now()}`);

    try {
      await stranger.page.goto(appUrl('/admin'));
      await expect(stranger.page.getByTestId('admin-denied')).toBeVisible();

      // One fresh request per retry, so a slow Worker is waited out rather
      // than sampled (mirrors security-headers.spec.ts).
      await expect.poll(
        async () => {
          const response = await stranger.page.request.get(appUrl('/api/admin/users'));
          const headers = response.headers();
          return {
            status: response.status(),
            coop: headers['cross-origin-opener-policy'] ?? '',
            corp: headers['cross-origin-resource-policy'] ?? '',
          };
        },
        { message: 'the admin denial did not carry COOP/CORP same-origin' },
      ).toEqual({ status: 403, coop: 'same-origin', corp: 'same-origin' });
    } finally {
      await stranger.close();
    }
  });
});
