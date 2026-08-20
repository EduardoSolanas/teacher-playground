import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import {
  newAuthenticatedContext,
  expectSessionCookie,
} from './helpers';

const SECRET_ELEMENT_ID = 'P3-SECRET-MARKER-RECT';

/** Room page is SSG; landing `/whiteboard` can stick on session hydration. */
async function bootstrapSecureSession(page: Page) {
  await page.goto(`/whiteboard/${'0'.repeat(32)}`);
  await expectSessionCookie(page);
}

/** Same-origin fetch from the page so the session cookie is sent. */
function pageFetch(
  page: Page,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; json: unknown; text: string }> {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: response.status, json, text };
    },
    { path, init: init ?? null } as { path: string; init: RequestInit | null },
  );
}

test.describe('Phase 3 raw-client adversarial scene access', () => {
  test('waiting peer GET room is 403 and leaks no board bytes', async ({ browser }) => {
    test.setTimeout(60_000);
    const roomId = `adv-wait-${Date.now()}`;
    const hostContext = await newAuthenticatedContext(browser);
    const peerContext = await newAuthenticatedContext(browser);
    const hostPage = await hostContext.newPage();
    const peerPage = await peerContext.newPage();

    try {
      await bootstrapSecureSession(hostPage);
      await bootstrapSecureSession(peerPage);

      expect((await pageFetch(hostPage, `/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        body: JSON.stringify({ elements: [{ id: SECRET_ELEMENT_ID }] }),
      })).status).toBe(200);

      expect((await pageFetch(peerPage, `/api/whiteboard/room/${roomId}/requests`, {
        method: 'POST',
        body: JSON.stringify({ userName: 'AdvWaiting' }),
      })).status).toBe(201);

      const leaked = await pageFetch(peerPage, `/api/whiteboard/room/${roomId}`);
      expect(leaked.status).toBe(403);
      expect(leaked.text).not.toContain(SECRET_ELEMENT_ID);
      const payload = JSON.stringify(leaked.json);
      expect(payload).not.toContain(SECRET_ELEMENT_ID);
      expect(payload).not.toMatch(/"elements"/);
      if (leaked.json && typeof leaked.json === 'object' && !Array.isArray(leaked.json)) {
        expect(leaked.json).not.toHaveProperty('elements');
      }
    } finally {
      await hostContext.close();
      await peerContext.close();
    }
  });

  test('viewer POST scene is 403 and does not replace the owner element', async ({ browser }) => {
    test.setTimeout(60_000);
    const roomId = `adv-view-${Date.now()}`;
    const hostContext = await newAuthenticatedContext(browser);
    const peerContext = await newAuthenticatedContext(browser);
    const hostPage = await hostContext.newPage();
    const peerPage = await peerContext.newPage();

    try {
      await bootstrapSecureSession(hostPage);
      await bootstrapSecureSession(peerPage);

      expect((await pageFetch(hostPage, `/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        body: JSON.stringify({ elements: [{ id: SECRET_ELEMENT_ID }] }),
      })).status).toBe(200);

      const requested = await pageFetch(peerPage, `/api/whiteboard/room/${roomId}/requests`, {
        method: 'POST',
        body: JSON.stringify({ userName: 'AdvViewer' }),
      });
      expect(requested.status).toBe(201);
      const requestId = (requested.json as { requestId?: string }).requestId;
      expect(requestId).toBeTruthy();

      const approved = await pageFetch(hostPage, `/api/whiteboard/room/${roomId}/requests/${requestId}`, {
        method: 'POST',
        body: JSON.stringify({ action: 'approve', role: 'viewer' }),
      });
      expect(approved.status).toBe(200);
      expect(approved.json).toMatchObject({ success: true, role: 'viewer' });

      const write = await pageFetch(peerPage, `/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        body: JSON.stringify({ elements: [{ id: 'hijack-viewer-write' }] }),
      });
      expect(write.status).toBe(403);

      const ownerScene = await pageFetch(hostPage, `/api/whiteboard/room/${roomId}`);
      expect(ownerScene.status).toBe(200);
      const ids = ((ownerScene.json as { elements?: Array<{ id: string }> }).elements ?? [])
        .map((element) => element.id);
      expect(ids).toContain(SECRET_ELEMENT_ID);
      expect(ids).not.toContain('hijack-viewer-write');
    } finally {
      await hostContext.close();
      await peerContext.close();
    }
  });
});
