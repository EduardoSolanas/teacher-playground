/*
 * UX screenshot capture.
 *
 * Regenerate the audit evidence with:
 *
 *   UX_CAPTURE=1 npm run test:e2e -- tests/e2e/ux-capture.spec.ts
 *
 * (PowerShell: $env:UX_CAPTURE='1'; npm run test:e2e -- tests/e2e/ux-capture.spec.ts)
 *
 * Every other e2e run skips this file, so it costs nothing normally. Captures
 * land in test-results/ux-captures/ as <state>-<viewport>.png at 1440x900,
 * 768x1024 and 390x844, against the real local Worker and Access issuer.
 *
 * LiveKit is never joined and "Start call" is never clicked: the only call UI
 * captured is the untouched pre-join control, which the header comment here
 * records so no reader mistakes it for a live call. Waiting is driven with
 * expect()/expect.poll(), never a fixed sleep.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  appUrl,
  clickCreateRoom,
  createRoomWithMaxUsers,
  expectSessionCookie,
  expectWaiting,
  joinExistingRoom,
  newAuthenticatedContext,
  waitForExcalidrawApi,
} from './helpers';

test.skip(
  process.env.UX_CAPTURE !== '1',
  'set UX_CAPTURE=1 to regenerate UX screenshots',
);

const CAPTURE_DIR = join(process.cwd(), 'test-results', 'ux-captures');

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
] as const;

type CaptureViewport = (typeof VIEWPORTS)[number];

async function capture(page: Page, state: string, viewport: CaptureViewport) {
  mkdirSync(CAPTURE_DIR, { recursive: true });
  await page.screenshot({
    path: join(CAPTURE_DIR, `${state}-${viewport.width}x${viewport.height}.png`),
    animations: 'disabled',
  });
}

/** Fonts loaded and two frames painted, so a resized layout is not captured mid-reflow. */
async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

test('captures the teacher room list', async ({ page }) => {
  // A real room first: the list state worth capturing has a row on it.
  await createRoomWithMaxUsers(page, 'UX Capture Teacher', 2);
  await page.goto(appUrl('/whiteboard'));

  const firstRoom = page.locator('[data-testid^="whiteboard-room-list-item-"]').first();
  await expect(firstRoom).toBeVisible({ timeout: 20000 });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await settle(page);
    await expect(firstRoom).toBeVisible();
    await capture(page, 'room-list', viewport);
  }

  // The widest the controls row ever gets: a live PIN plus a rotated one.
  await page.setViewportSize(VIEWPORTS[0]);
  const pinNew = page.locator('[data-testid^="whiteboard-room-pin-new-"]').first();
  await pinNew.click();
  await expect(pinNew).toHaveText(/New PIN/, { timeout: 15000 });
  await settle(page);
  await capture(page, 'room-list-pin-live', VIEWPORTS[0]);

  await pinNew.click();
  await expect(page.locator('[data-testid^="whiteboard-room-pin-old-"]').first())
    .toBeVisible({ timeout: 15000 });
  await settle(page);
  await capture(page, 'room-list-pin-rotated', VIEWPORTS[0]);
});

test('captures the loaded room, presence, title menu and pre-join call control', async ({ page }) => {
  // The host, on a room they own: this is where the owner-only chrome lives.
  await createRoomWithMaxUsers(page, 'UX Capture Teacher', 2);
  await waitForExcalidrawApi(page);
  await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 20000 });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await settle(page);
    await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible();

    // Collapsed is the room's default for everybody; the roster opens on ask.
    await expect(page.getByTestId('whiteboard-people-button'))
      .toHaveAttribute('aria-expanded', 'false');
    await capture(page, 'board-presence-collapsed', viewport);

    await page.getByTestId('whiteboard-people-button').click();
    await expect(page.getByTestId('whiteboard-presence-panel')).toBeVisible({ timeout: 15000 });
    await settle(page);
    await capture(page, 'board-presence-expanded', viewport);

    await page.getByTestId('whiteboard-people-button').click();
    await expect(page.getByTestId('whiteboard-presence-panel')).toHaveCount(0);

    await page.getByTestId('room-title-trigger').click();
    await expect(page.getByTestId('room-title-menu')).toBeVisible();
    await settle(page);
    await capture(page, 'room-title-menu', viewport);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('room-title-menu')).toHaveCount(0);

    // Default/unavailable call state only: the button is shown, never pressed.
    await expect(page.getByTestId('av-start-call')).toBeVisible();
    await settle(page);
    await capture(page, 'call-prejoin', viewport);
  }
});

test('captures the username prompt', async ({ page }) => {
  await page.goto(appUrl('/whiteboard'));
  await expectSessionCookie(page);
  await page.evaluate(() => localStorage.removeItem('whiteboard_username'));
  await clickCreateRoom(page);

  const usernameInput = page.getByTestId('whiteboard-username-input');
  await expect(usernameInput).toBeVisible({ timeout: 20000 });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await settle(page);
    await expect(usernameInput).toBeVisible();
    await capture(page, 'username-prompt', viewport);
  }
});

test('captures the waiting student view', async ({ browser }) => {
  const hostContext = await newAuthenticatedContext(browser);
  const studentContext = await newAuthenticatedContext(browser);
  const hostPage = await hostContext.newPage();
  const studentPage = await studentContext.newPage();

  try {
    const roomId = await createRoomWithMaxUsers(hostPage, 'UX Capture Host', 2);
    await joinExistingRoom(studentPage, roomId, 'UX Capture Student');
    await expectWaiting(studentPage);

    for (const viewport of VIEWPORTS) {
      await studentPage.setViewportSize(viewport);
      await settle(studentPage);
      await expect(studentPage.getByRole('heading', { name: /Room is Full/ })).toBeVisible();
      await capture(studentPage, 'waiting-student', viewport);
    }
  } finally {
    await hostContext.close();
    await studentContext.close();
  }
});

test('captures the marketing pages', async ({ page }) => {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);

    await page.goto(appUrl('/'), { waitUntil: 'load' });
    await expect(page.locator('h1')).toBeVisible();
    await settle(page);
    await capture(page, 'marketing-home', viewport);

    await page.goto(appUrl('/pricing'), { waitUntil: 'load' });
    await expect(page.locator('h1')).toBeVisible();
    await settle(page);
    await capture(page, 'marketing-pricing', viewport);
  }
});
