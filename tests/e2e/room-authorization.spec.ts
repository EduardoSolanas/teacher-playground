import { test, expect, type Browser, type Page } from '@playwright/test';
import { appUrl, expectSessionCookie } from './helpers';

/**
 * Room authorization through the real local Access edge and workerd.
 *
 * Each browser context bootstraps its own local session, so these exercise two
 * genuinely different accounts rather than two tabs of one identity.
 */

/**
 * Mints a fresh Access assertion for `subject`. The shared storageState token
 * in playwright.config identifies a single human, so without this every context
 * would be the same account and these tests would prove nothing.
 */
async function accessTokenFor(subject: string): Promise<string> {
  const issuer = process.env.E2E_ACCESS_ISSUER;
  if (!issuer) throw new Error('E2E_ACCESS_ISSUER is not set; run via npm run test:e2e');
  const response = await fetch(`${issuer}/token?sub=${encodeURIComponent(subject)}`);
  if (!response.ok) throw new Error(`local issuer token failed: ${response.status}`);
  return ((await response.json()) as { token: string }).token;
}

async function signedInPage(
  browser: Browser,
  subject: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const token = await accessTokenFor(subject);
  const context = await browser.newContext({
    storageState: {
      cookies: [{
        name: 'CF_Authorization',
        value: token,
        domain: 'localhost',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3_600,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      }],
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
    })).status,
    { path, init: init ?? null } as { path: string; init: RequestInit | null },
  );
}

function apiJson(page: Page, path: string): Promise<unknown> {
  return page.evaluate(async (path) => {
    const response = await fetch(path);
    return response.ok ? response.json() : null;
  }, path);
}

test.describe('room authorization across accounts', () => {
  test('a room created by one account is unreadable to another', async ({ browser }) => {
    const roomId = `authz-private-${Date.now()}`;
    const owner = await signedInPage(browser, `owner-${roomId}`);
    const outsider = await signedInPage(browser, `outsider-${roomId}`);

    try {
      expect(await apiStatus(owner.page, `/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        body: JSON.stringify({ elements: [], name: 'Private lesson' }),
      })).toBe(200);

      // The creator can read its own board.
      expect(await apiJson(owner.page, `/api/whiteboard/room/${roomId}`))
        .toMatchObject({ name: 'Private lesson' });

      // A different signed-in account cannot read, overwrite, or delete it.
      expect(await apiStatus(outsider.page, `/api/whiteboard/room/${roomId}`)).toBe(403);
      expect(await apiStatus(outsider.page, `/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        body: JSON.stringify({ elements: [], name: 'Hijacked' }),
      })).toBe(403);
      expect(await apiStatus(outsider.page, `/api/whiteboard/room/${roomId}`, {
        method: 'DELETE',
      })).toBe(403);

      // The board survived every attempt unchanged.
      expect(await apiJson(owner.page, `/api/whiteboard/room/${roomId}`))
        .toMatchObject({ name: 'Private lesson' });
    } finally {
      await owner.close();
      await outsider.close();
    }
  });

  test('answers alike for an absent room and someone else\'s room', async ({ browser }) => {
    const existing = `authz-exists-${Date.now()}`;
    const absent = `authz-absent-${Date.now()}`;
    const owner = await signedInPage(browser, `owner-${existing}`);
    const outsider = await signedInPage(browser, `outsider-${existing}`);

    try {
      expect(await apiStatus(owner.page, `/api/whiteboard/room/${existing}`, {
        method: 'POST',
        body: JSON.stringify({ elements: [] }),
      })).toBe(200);

      // Identical responses, so the API cannot be used to discover room ids.
      expect(await apiStatus(outsider.page, `/api/whiteboard/room/${existing}`)).toBe(403);
      expect(await apiStatus(outsider.page, `/api/whiteboard/room/${absent}`)).toBe(403);
    } finally {
      await owner.close();
      await outsider.close();
    }
  });

  test('an outsider cannot moderate the waiting queue or admit itself', async ({ browser }) => {
    const roomId = `authz-moderation-${Date.now()}`;
    const owner = await signedInPage(browser, `owner-${roomId}`);
    const outsider = await signedInPage(browser, `outsider-${roomId}`);

    try {
      await apiStatus(owner.page, `/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        body: JSON.stringify({ elements: [] }),
      });
      await apiStatus(owner.page, `/api/whiteboard/room/${roomId}/presence`, {
        method: 'POST',
        body: JSON.stringify({ peerId: 'host-peer', userName: 'Host', color: '#3498db' }),
      });
      await apiStatus(outsider.page, `/api/whiteboard/room/${roomId}/presence`, {
        method: 'POST',
        body: JSON.stringify({ peerId: 'guest-peer', userName: 'Guest', color: '#e74c3c' }),
      });

      expect(await apiStatus(outsider.page, `/api/whiteboard/room/${roomId}/waiting`)).toBe(403);
      expect(await apiStatus(outsider.page, `/api/whiteboard/room/${roomId}/waiting`, {
        method: 'POST',
        body: JSON.stringify({ peerId: 'guest-peer', action: 'approve' }),
      })).toBe(403);
      expect(await apiStatus(outsider.page, `/api/whiteboard/room/${roomId}/presence`, {
        method: 'POST',
        body: JSON.stringify({ action: 'kick', peerId: 'host-peer' }),
      })).toBe(403);

      // Still shut out of the board after trying to let itself in.
      expect(await apiStatus(outsider.page, `/api/whiteboard/room/${roomId}`)).toBe(403);
    } finally {
      await owner.close();
      await outsider.close();
    }
  });

  test('the host approving a waiting peer grants it the board', async ({ browser }) => {
    const roomId = `authz-approval-${Date.now()}`;
    const owner = await signedInPage(browser, `owner-${roomId}`);
    const guest = await signedInPage(browser, `guest-${roomId}`);

    try {
      await apiStatus(owner.page, `/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        body: JSON.stringify({ elements: [], name: 'Lesson' }),
      });
      await apiStatus(owner.page, `/api/whiteboard/room/${roomId}/presence`, {
        method: 'POST',
        body: JSON.stringify({ peerId: 'host-peer', userName: 'Host', color: '#3498db' }),
      });

      await apiStatus(guest.page, `/api/whiteboard/room/${roomId}/presence`, {
        method: 'POST',
        body: JSON.stringify({ peerId: 'guest-peer', userName: 'Guest', color: '#e74c3c' }),
      });
      expect(await apiStatus(guest.page, `/api/whiteboard/room/${roomId}`)).toBe(403);

      expect(await apiStatus(owner.page, `/api/whiteboard/room/${roomId}/waiting`, {
        method: 'POST',
        body: JSON.stringify({ peerId: 'guest-peer', action: 'approve' }),
      })).toBe(200);

      expect(await apiJson(guest.page, `/api/whiteboard/room/${roomId}`))
        .toMatchObject({ name: 'Lesson' });

      // Admitted, but still not the owner.
      expect(await apiStatus(guest.page, `/api/whiteboard/room/${roomId}`, {
        method: 'DELETE',
      })).toBe(403);
    } finally {
      await owner.close();
      await guest.close();
    }
  });
});
