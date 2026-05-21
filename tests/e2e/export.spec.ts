import { test, expect } from '@playwright/test';

function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function joinRoom(page: any, name: string, joinCode?: string) {
  await page.context().addInitScript((n) => {
    localStorage.removeItem('whiteboard_username');
    localStorage.removeItem('whiteboard_user_color');
    // @ts-ignore
    localStorage.setItem('whiteboard_user_color', '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'));
  }, name);

  await page.goto('/whiteboard');
  await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');

  if (joinCode) {
    await page.getByTestId('whiteboard-room-code-input').fill(joinCode);
    await page.getByTestId('whiteboard-join-room-btn').click();
  } else {
    await page.getByTestId('whiteboard-create-room-btn').click();
  }

  await expect(page.getByTestId('whiteboard-username-input')).toBeVisible();
  await page.getByTestId('whiteboard-username-input').fill(name);
  await page.getByTestId('whiteboard-join-room-btn').click();

  await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
}

async function addElement(page: any, element: any) {
  await page.evaluate((el) => {
    // @ts-ignore
    const store = window.__whiteboardStore;
    if (store) store.addElement(el);
  }, element);
}

test.describe('Export', () => {
  test('PNG export triggers download with correct filename', async ({ page, browser }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const testPage = await context.newPage();

    let downloadEvent: any = null;

    testPage.on('download', (d) => {
      downloadEvent = d;
    });

    await joinRoom(testPage, 'ExportUser');

    // Add an element so the canvas isn't empty
    await addElement(testPage, {
      id: generateId(),
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      fill: '#3498db',
      stroke: '#2980b9',
      strokeWidth: 2,
    });

    await testPage.waitForTimeout(500);

    // Open export dropdown
    await testPage.getByTestId('whiteboard-export-btn').click();
    await testPage.waitForTimeout(300);

    // Expect PNG dropdown to be visible
    await expect(testPage.getByTestId('whiteboard-export-png-1x')).toBeVisible();
    await expect(testPage.getByTestId('whiteboard-export-png-2x')).toBeVisible();
    await expect(testPage.getByTestId('whiteboard-export-png-4x')).toBeVisible();
    await expect(testPage.getByTestId('whiteboard-export-svg')).toBeVisible();

    // Trigger PNG export and capture download
    await testPage.getByTestId('whiteboard-export-png-2x').click();

    // Wait a bit for export to complete
    await testPage.waitForTimeout(2000);

    expect(downloadEvent).toBeTruthy();
    if (downloadEvent) {
      const fname = downloadEvent.suggestedFilename();
      expect(fname).toContain('whiteboard-');
      expect(fname.endsWith('.png')).toBe(true);
    }

    await context.close();
  });

  test('SVG export triggers download with correct filename', async ({ page, browser }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const testPage = await context.newPage();

    let downloadEvent: any = null;

    testPage.on('download', (d) => {
      downloadEvent = d;
    });

    await joinRoom(testPage, 'ExportUser');

    // Add an element
    await addElement(testPage, {
      id: generateId(),
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      fill: '#3498db',
      stroke: '#2980b9',
      strokeWidth: 2,
    });

    await testPage.waitForTimeout(500);

    // Open export dropdown
    await testPage.getByTestId('whiteboard-export-btn').click();
    await testPage.waitForTimeout(300);

    // Trigger SVG export and capture download
    await testPage.getByTestId('whiteboard-export-svg').click();

    await testPage.waitForTimeout(2000);

    expect(downloadEvent).toBeTruthy();
    if (downloadEvent) {
      const fname = downloadEvent.suggestedFilename();
      expect(fname).toContain('whiteboard-');
      expect(fname.endsWith('.svg')).toBe(true);
    }

    await context.close();
  });

  test('export works on empty canvas', async ({ page, browser }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const testPage = await context.newPage();

    let downloadEvent: any = null;

    testPage.on('download', (d) => {
      downloadEvent = d;
    });

    await joinRoom(testPage, 'EmptyExportUser');

    // Don't add any elements - export on empty canvas
    await testPage.getByTestId('whiteboard-export-btn').click();
    await testPage.waitForTimeout(300);

    await testPage.getByTestId('whiteboard-export-png-1x').click();

    await testPage.waitForTimeout(2000);

    expect(downloadEvent).toBeTruthy();
    if (downloadEvent) {
      const fname = downloadEvent.suggestedFilename();
      expect(fname).toContain('whiteboard-');
      expect(fname.endsWith('.png')).toBe(true);
    }

    await context.close();
  });
});
