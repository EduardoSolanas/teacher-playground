import { test, expect } from './fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import {
  appendElement,
  appUrl,
  clickCreateRoom,
  excalidrawRectangle,
  expectSessionCookie,
  expandPresenceIfCollapsed,
  newAuthenticatedContext,
} from './helpers';

/*
 * A room's boards, in the real browser: the tab strip over the canvas, a
 * scene of its own per board, peers reading the same document, and the
 * owner's per-board clear reaching everybody.
 *
 * Elements are drawn through Excalidraw's own API (appendElement) rather
 * than by replaying pointer sequences: what a board test is about is which
 * scene holds which element, and the publish path out of updateScene is the
 * one drawing takes anyway.
 */

/** Join a fresh room as its owner and wait for the editor to be usable. */
async function openOwnedRoom(page: Page, name: string) {
  await page.goto(appUrl('/whiteboard'));
  await expectSessionCookie(page);
  await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');
  await page.evaluate(() => {
    localStorage.removeItem('whiteboard_username');
    localStorage.setItem(
      'whiteboard_user_color',
      '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
    );
  });
  await clickCreateRoom(page);

  const canvasArea = page.getByTestId('whiteboard-canvas-area');
  const usernameInput = page.getByTestId('whiteboard-username-input');
  const nextView = await Promise.race([
    canvasArea.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'canvas' as const).catch(() => null),
    usernameInput.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'prompt' as const).catch(() => null),
  ]);
  if (nextView === 'prompt') {
    await usernameInput.fill(name);
    await page.getByTestId('whiteboard-join-room-btn').click();
  }

  await expect(page.getByTestId('toolbar-selection')).toBeVisible({ timeout: 15000 });
  await expect(canvasArea).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => !!(window as any).__debugExcalidrawApi, { timeout: 15000 });
}

/**
 * A second browser as a member of the owner's room, admitted if the room asks
 * the owner first. Tolerant on purpose: with spare capacity the member is let
 * straight in and there is nothing to approve.
 */
async function joinMember(
  browser: Browser,
  roomUrl: string,
  name: string,
  ownerPage: Page,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await newAuthenticatedContext(browser);
  const page = await context.newPage();
  await context.addInitScript(() => {
    localStorage.removeItem('whiteboard_username');
    localStorage.removeItem('whiteboard_user_color');
  });
  await page.goto(roomUrl);

  const canvasArea = page.getByTestId('whiteboard-canvas-area');
  const usernameInput = page.getByTestId('whiteboard-username-input');
  const nextView = await Promise.race([
    canvasArea.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'canvas' as const).catch(() => null),
    usernameInput.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'prompt' as const).catch(() => null),
  ]);
  if (nextView === 'prompt') {
    await usernameInput.fill(name);
    await page.getByTestId('whiteboard-join-room-btn').click();
  }

  await expandPresenceIfCollapsed(ownerPage);
  const waiting = ownerPage
    .locator('[data-testid="whiteboard-waiting-section"] [data-testid^="whiteboard-user-"]')
    .first();
  try {
    await waiting.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    // Admitted directly; the canvas assertion below still has to hold.
  }
  await waiting.getByRole('button', { name: 'Let in' }).click().catch(() => undefined);

  // The open roster overlays the right edge of the tab strip, where the
  // clear control sits -- fold it away the way a teacher would before
  // reaching for the strip again.
  const panel = ownerPage.getByTestId('whiteboard-presence-panel');
  if (await panel.isVisible().catch(() => false)) {
    const toggle = ownerPage.getByTestId('whiteboard-people-button');
    await expect
      .poll(async () => {
        if (!(await panel.isVisible().catch(() => false))) return 'closed';
        await toggle.click({ force: true }).catch(() => undefined);
        return 'open';
      }, { timeout: 15000 })
      .toBe('closed');
  }

  await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
  return { context, page };
}

async function waitForProviderConnected(page: Page, timeout = 20000) {
  await expect
    .poll(
      async () => page.evaluate(() => (window as any).__whiteboardCollab?.status ?? ''),
      { timeout },
    )
    .toMatch(/connected|synced/);
}

function boardTabs(page: Page) {
  return page.getByTestId('board-tabs').locator('button[data-testid^="board-tab-"]');
}

/**
 * The tab a board add created, once the strip has settled at two boards.
 *
 * Board ids live in the shared document, so the same id names the tab on
 * every peer -- unlike a peer id, nothing re-mints it at an admission or
 * suspend boundary.
 */
async function addedBoardTestId(page: Page) {
  const tabs = boardTabs(page);
  await expect(tabs).toHaveCount(2, { timeout: 15000 });
  const testId = await tabs.nth(1).getAttribute('data-testid');
  expect(testId, 'the added board tab').toMatch(/^board-tab-board-/);
  return testId!;
}

/** Ids of what the editor is showing -- the active board's scene only. */
async function getSceneIds(page: Page) {
  return page.evaluate(() => ((window as any).__debugExcalidrawApi?.getSceneElements?.() ?? [])
    .filter((element: { isDeleted?: boolean }) => element.isDeleted !== true)
    .map((element: { id: string }) => element.id)
    .sort());
}

function expectScene(page: Page, ids: string[], timeout = 15000) {
  return expect
    .poll(() => getSceneIds(page), { timeout, message: `the scene never became ${JSON.stringify(ids)}` })
    .toEqual(ids);
}

/**
 * What the shared document holds for one board, read the way the editor
 * reads it: an element without a stamp belongs to main.
 */
async function getSharedBoardIds(page: Page, boardId: string) {
  return page.evaluate((board) => ((window as any).__whiteboardCollab?.provider?.doc?.getArray('elements')
    ?.toArray?.() ?? [])
    .filter((element: { get: (key: string) => unknown }) => element.get('isDeleted') !== true)
    .filter((element: { get: (key: string) => unknown }) => {
      const stamp = element.get('boardId');
      return (typeof stamp === 'string' && stamp.length > 0 ? stamp : 'main') === board;
    })
    .map((element: { get: (key: string) => unknown }) => element.get('id'))
    .filter((id: unknown): id is string => typeof id === 'string')
    .sort(), boardId);
}

function expectSharedBoard(page: Page, boardId: string, ids: string[], timeout = 15000) {
  return expect
    .poll(() => getSharedBoardIds(page, boardId), { timeout })
    .toEqual(ids);
}

function expectSharedBoardToContain(page: Page, boardId: string, id: string, timeout = 15000) {
  return expect
    .poll(() => getSharedBoardIds(page, boardId), { timeout })
    .toContain(id);
}

test.describe('Multi-board rooms', () => {
  test('the owner can add a board and the room follows', async ({ page }) => {
    await openOwnedRoom(page, 'TabsOwner');
    await waitForProviderConnected(page);

    // A fresh room holds one board, and it is the one being looked at.
    await expect(boardTabs(page)).toHaveCount(1);
    await expect(page.getByTestId('board-tab-main')).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('board-tabs-add').click();

    const tabs = boardTabs(page);
    await expect(tabs).toHaveCount(2);
    // Main stays first; the room moved to the board that was just added.
    await expect(tabs.nth(0)).toHaveAttribute('data-testid', 'board-tab-main');
    await expect(tabs.nth(0)).toHaveAttribute('aria-pressed', 'false');
    await expect(tabs.nth(1)).toHaveAttribute('data-testid', /^board-tab-board-/);
    await expect(tabs.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(tabs.nth(0)).toHaveText('Board 1');
    await expect(tabs.nth(1)).toHaveText('Board 2');
  });

  test('each board keeps its own scene', async ({ page }) => {
    await openOwnedRoom(page, 'SceneOwner');
    await waitForProviderConnected(page);

    await appendElement(page, excalidrawRectangle('boards-main-stroke', 100, 100));
    await expectScene(page, ['boards-main-stroke']);

    await page.getByTestId('board-tabs-add').click();
    const secondTab = await addedBoardTestId(page);
    await expect(page.getByTestId(secondTab)).toHaveAttribute('aria-pressed', 'true');
    await expectScene(page, []);

    // A board swap swaps the scene, not the document: what the left board
    // holds is still there while nobody is looking at it.
    await expectSharedBoard(page, 'main', ['boards-main-stroke']);

    await page.getByTestId('board-tab-main').click();
    await expect(page.getByTestId('board-tab-main')).toHaveAttribute('aria-pressed', 'true');
    await expectScene(page, ['boards-main-stroke']);
  });

  test('peers see the same boards and the same active scene', async ({ page, browser }) => {
    test.slow();
    await openOwnedRoom(page, 'ShareOwner');
    await waitForProviderConnected(page);

    await appendElement(page, excalidrawRectangle('shared-main-stroke', 100, 100));
    await expectScene(page, ['shared-main-stroke']);

    const { context: memberContext, page: memberPage } = await joinMember(browser, page.url(), 'ShareMember', page);
    try {
      await waitForProviderConnected(memberPage);

      // The member mounts onto the owner's board, not an empty one.
      await expectScene(memberPage, ['shared-main-stroke']);

      // A board the owner adds reaches the member's strip without a reload.
      await page.getByTestId('board-tabs-add').click();
      const secondTab = await addedBoardTestId(page);
      await expect(boardTabs(memberPage)).toHaveCount(2, { timeout: 15000 });
      await expect(boardTabs(memberPage).nth(0)).toHaveAttribute('data-testid', 'board-tab-main');
      await expect(boardTabs(memberPage).nth(1)).toHaveAttribute('data-testid', secondTab);

      // The owner draws on the new board; the member follows it there.
      await appendElement(page, excalidrawRectangle('shared-board2-stroke', 220, 220));
      await expectScene(page, ['shared-board2-stroke']);

      await memberPage.getByTestId(secondTab).click();
      await expect(memberPage.getByTestId(secondTab)).toHaveAttribute('aria-pressed', 'true');
      await expectScene(memberPage, ['shared-board2-stroke']);

      // And main's work is still main's, on the way back.
      await memberPage.getByTestId('board-tab-main').click();
      await expect(memberPage.getByTestId('board-tab-main')).toHaveAttribute('aria-pressed', 'true');
      await expectScene(memberPage, ['shared-main-stroke']);
    } finally {
      await memberContext.close();
    }
  });

  test('clearing a board empties it for everyone and leaves the others standing', async ({ page, browser }) => {
    test.slow();
    await openOwnedRoom(page, 'ClearOwner');
    await waitForProviderConnected(page);

    await appendElement(page, excalidrawRectangle('clear-main-stroke', 100, 100));
    await expectScene(page, ['clear-main-stroke']);

    const { context: memberContext, page: memberPage } = await joinMember(browser, page.url(), 'ClearMember', page);
    try {
      await waitForProviderConnected(memberPage);
      await expectScene(memberPage, ['clear-main-stroke']);

      // The footer's clear is the owner's control; a member never sees it.
      await expect(memberPage.getByTestId('whiteboard-clear-btn')).toHaveCount(0);
      await expect(page.getByTestId('whiteboard-clear-btn')).toBeVisible();

      await page.getByTestId('board-tabs-add').click();
      const secondTab = await addedBoardTestId(page);
      const secondBoardId = secondTab.replace('board-tab-', '');
      await expect(boardTabs(memberPage)).toHaveCount(2, { timeout: 15000 });

      await appendElement(page, excalidrawRectangle('clear-board2-stroke', 220, 220));
      await expectScene(page, ['clear-board2-stroke']);

      await memberPage.getByTestId(secondTab).click();
      await expectScene(memberPage, ['clear-board2-stroke']);

      // The owner empties the board they are looking at -- the footer's
      // clear acts on the current selection, asked first.
      await page.getByTestId('whiteboard-clear-btn').click();
      await expect(page.getByText(/'Board 2'/)).toBeVisible();
      await page.getByTestId('whiteboard-clear-confirm-btn').click();

      // The board empties for everyone -- and keeps its tab.
      await expectScene(page, []);
      await expectScene(memberPage, []);
      await expect(boardTabs(page)).toHaveCount(2);
      await expect(boardTabs(memberPage)).toHaveCount(2);

      // And it has to stay empty: a stale save landing after the clear would
      // quietly bring the board back, the way it once could the whole room.
      await page.waitForTimeout(1500);
      expect(await getSceneIds(page)).toEqual([]);
      expect(await getSceneIds(memberPage)).toEqual([]);
      await expectSharedBoard(page, secondBoardId, []);

      // The board that was not cleared is untouched, for both of them.
      // Survival at the document level is "at least one live entry": a peer
      // that joined mid-lesson can leave the array carrying a concurrent
      // insert of an element it already held, which the editor dedupes by id
      // -- the scene assertions below are the strict ones.
      await expectSharedBoardToContain(page, 'main', 'clear-main-stroke');
      await page.getByTestId('board-tab-main').click();
      await expectScene(page, ['clear-main-stroke']);
      await memberPage.getByTestId('board-tab-main').click();
      await expectScene(memberPage, ['clear-main-stroke']);
    } finally {
      await memberContext.close();
    }
  });

  test('a board can be renamed and every peer sees the new name', async ({ page, browser }) => {
    test.slow();
    await openOwnedRoom(page, 'RenameOwner');
    await waitForProviderConnected(page);

    const { context: memberContext, page: memberPage } = await joinMember(browser, page.url(), 'RenameMember', page);
    try {
      await waitForProviderConnected(memberPage);

      await page.getByTestId('board-tabs-add').click();
      const secondTab = await addedBoardTestId(page);
      await expect(boardTabs(memberPage)).toHaveCount(2, { timeout: 15000 });

      // The main board is canonical: no pencil, and double-clicking it opens
      // no editor.
      await expect(page.getByTestId('board-pencil-main')).toHaveCount(0);
      await page.getByTestId('board-tab-main').dblclick();
      await expect(page.getByTestId('board-name-input')).toHaveCount(0);

      // The pencil on the tab is the visible way in; double-click and F2 are
      // the shortcuts.
      await expect(page.getByTestId(secondTab.replace('board-tab-', 'board-pencil-'))).toBeVisible();
      await page.getByTestId(secondTab.replace('board-tab-', 'board-pencil-')).click();
      const input = page.getByTestId('board-name-input');
      await expect(input).toBeVisible();
      await expect(input).toHaveValue('Board 2');
      await input.fill('Algebra');
      await input.press('Enter');

      // The label is the shared document's own, so the member's strip shows
      // it without a reload.
      await expect(page.getByTestId(secondTab)).toHaveText('Algebra');
      await expect(boardTabs(memberPage).nth(1)).toHaveText('Algebra', { timeout: 15000 });
    } finally {
      await memberContext.close();
    }
  });

  test('deleting a board removes it for everyone and the room lands on main', async ({ page, browser }) => {
    test.slow();
    await openOwnedRoom(page, 'DeleteOwner');
    await waitForProviderConnected(page);

    await appendElement(page, excalidrawRectangle('delete-main-stroke', 100, 100));
    await expectScene(page, ['delete-main-stroke']);

    const { context: memberContext, page: memberPage } = await joinMember(browser, page.url(), 'DeleteMember', page);
    try {
      await waitForProviderConnected(memberPage);
      await expectScene(memberPage, ['delete-main-stroke']);

      // The main board has no delete control for anybody: it is the room's
      // floor, not a board.
      await expect(page.getByTestId('board-tabs-delete')).toHaveCount(0);

      await page.getByTestId('board-tabs-add').click();
      const secondTab = await addedBoardTestId(page);
      const secondBoardId = secondTab.replace('board-tab-', '');
      await expect(boardTabs(memberPage)).toHaveCount(2, { timeout: 15000 });

      // Deleting is the owner's control; a member never sees the button,
      // even standing on the board that would be deleted.
      await memberPage.getByTestId(secondTab).click();
      await expect(memberPage.getByTestId('board-tabs-delete')).toHaveCount(0);
      await expect(page.getByTestId('board-tabs-delete')).toBeVisible();

      await appendElement(page, excalidrawRectangle('delete-board2-stroke', 220, 220));
      await expectScene(page, ['delete-board2-stroke']);
      await memberPage.getByTestId(secondTab).click();
      await expectScene(memberPage, ['delete-board2-stroke']);

      await page.getByTestId('board-tabs-delete').click();
      await page.getByTestId('board-delete-confirm-btn').click();
      await expect(page.getByTestId('board-tabs-delete-done')).toBeVisible({ timeout: 10000 });

      // The tab disappears on both strips -- it was the document's own --
      // and both rooms land back on main.
      await expect(boardTabs(page)).toHaveCount(1);
      await expect(boardTabs(memberPage)).toHaveCount(1, { timeout: 15000 });
      await expect(page.getByTestId('board-tab-main')).toHaveAttribute('aria-pressed', 'true');
      await expect(memberPage.getByTestId('board-tab-main')).toHaveAttribute('aria-pressed', 'true');

      // The deleted board's elements are gone from the shared document for
      // both of them; main's stroke survives.
      await expectSharedBoard(page, secondBoardId, []);
      await expectSharedBoard(memberPage, secondBoardId, []);
      await expectSharedBoardToContain(page, 'main', 'delete-main-stroke');
      await expectScene(page, ['delete-main-stroke']);
      await expectScene(memberPage, ['delete-main-stroke']);
    } finally {
      await memberContext.close();
    }
  });
});
