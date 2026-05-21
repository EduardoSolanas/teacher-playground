import { test, expect, Page } from '@playwright/test';

function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function joinRoom(page: Page, name: string, joinCode?: string) {
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

async function getTextElement(page: Page, id: string) {
  return await page.evaluate((eid) => {
    // @ts-ignore
    const state = window.__whiteboardStore?.getState?.() || {};
    return state.elements?.find((e: any) => e.id === eid);
  }, id);
}

async function createTextElement(page: Page, text: string) {
  // Click the text tool
  await page.getByTestId('whiteboard-tool-text').click();
  await page.waitForTimeout(200);

  // Click on canvas to place text
  const canvas = page.getByTestId('whiteboard-canvas-area');
  await canvas.click({ position: { x: 100, y: 100 } });
  await page.waitForTimeout(300);

  // Type text
  await page.getByTestId('text-editor-textarea').fill(text);
  await page.waitForTimeout(200);

  return page;
}

test.describe('Text Tool', () => {
  test('creates text element with content', async ({ page }) => {
    await joinRoom(page, 'TextUser');

    const textId = 'text-test-' + Date.now();
    await page.evaluate((id) => {
      // @ts-ignore
      const store = window.__whiteboardStore;
      if (store) {
        store.addElement({
          id,
          type: 'text',
          x: 100,
          y: 100,
          width: 200,
          height: 30,
          text: 'Hello World',
          color: '#000000',
          fontSize: 16,
          fontFamily: 'Arial',
          bold: false,
          italic: false,
          underline: false,
        });
      }
    }, textId);

    await page.waitForTimeout(300);

    const el = await getTextElement(page, textId);
    expect(el).toBeTruthy();
    expect(el.type).toBe('text');
    expect(el.text).toBe('Hello World');
  });

  test('bold formatting toggles and persists', async ({ page }) => {
    await joinRoom(page, 'BoldUser');

    const textId = 'text-bold-' + Date.now();
    await page.evaluate((id) => {
      // @ts-ignore
      const store = window.__whiteboardStore;
      if (store) {
        store.addElement({
          id,
          type: 'text',
          x: 100,
          y: 100,
          width: 200,
          height: 30,
          text: 'Bold Text',
          color: '#000000',
          fontSize: 16,
          fontFamily: 'Arial',
          bold: false,
          italic: false,
          underline: false,
        });
      }
    }, textId);

    await page.waitForTimeout(300);

    let el = await getTextElement(page, textId);
    expect(el.bold).toBe(false);

    await page.getByTestId('whiteboard-tool-text').click();
    await page.waitForTimeout(200);

    const canvas = page.getByTestId('whiteboard-canvas-area');
    await canvas.click({ position: { x: 100, y: 100 } });
    await page.waitForTimeout(300);

    await page.getByTestId('text-editor-textarea').fill('Test Bold');
    await page.waitForTimeout(200);

    await page.getByTestId('text-editor-bold').click();
    await page.waitForTimeout(200);

    await page.getByTestId('text-editor-apply').click();
    await page.waitForTimeout(300);

    el = await getTextElement(page, textId);
    expect(el.bold).toBe(true);
  });

  test('italic formatting toggles and persists', async ({ page }) => {
    await joinRoom(page, 'ItalicUser');

    const textId = 'text-italic-' + Date.now();
    await page.evaluate((id) => {
      // @ts-ignore
      const store = window.__whiteboardStore;
      if (store) {
        store.addElement({
          id,
          type: 'text',
          x: 100,
          y: 100,
          width: 200,
          height: 30,
          text: 'Italic Text',
          color: '#000000',
          fontSize: 16,
          fontFamily: 'Arial',
          bold: false,
          italic: false,
          underline: false,
        });
      }
    }, textId);

    await page.waitForTimeout(300);

    let el = await getTextElement(page, textId);
    expect(el.italic).toBe(false);

    await page.getByTestId('whiteboard-tool-text').click();
    await page.waitForTimeout(200);

    const canvas = page.getByTestId('whiteboard-canvas-area');
    await canvas.click({ position: { x: 100, y: 100 } });
    await page.waitForTimeout(300);

    await page.getByTestId('text-editor-textarea').fill('Test Italic');
    await page.waitForTimeout(200);

    await page.getByTestId('text-editor-italic').click();
    await page.waitForTimeout(200);

    await page.getByTestId('text-editor-apply').click();
    await page.waitForTimeout(300);

    el = await getTextElement(page, textId);
    expect(el.italic).toBe(true);
  });

  test('underline formatting toggles and persists', async ({ page }) => {
    await joinRoom(page, 'UnderlineUser');

    const textId = 'text-underline-' + Date.now();
    await page.evaluate((id) => {
      // @ts-ignore
      const store = window.__whiteboardStore;
      if (store) {
        store.addElement({
          id,
          type: 'text',
          x: 100,
          y: 100,
          width: 200,
          height: 30,
          text: 'Underlined Text',
          color: '#000000',
          fontSize: 16,
          fontFamily: 'Arial',
          bold: false,
          italic: false,
          underline: false,
        });
      }
    }, textId);

    await page.waitForTimeout(300);

    let el = await getTextElement(page, textId);
    expect(el.underline).toBe(false);

    await page.getByTestId('whiteboard-tool-text').click();
    await page.waitForTimeout(200);

    const canvas = page.getByTestId('whiteboard-canvas-area');
    await canvas.click({ position: { x: 100, y: 100 } });
    await page.waitForTimeout(300);

    await page.getByTestId('text-editor-textarea').fill('Test Underline');
    await page.waitForTimeout(200);

    await page.getByTestId('text-editor-underline').click();
    await page.waitForTimeout(200);

    await page.getByTestId('text-editor-apply').click();
    await page.waitForTimeout(300);

    el = await getTextElement(page, textId);
    expect(el.underline).toBe(true);
  });

  test('font size changes and persists', async ({ page }) => {
    await joinRoom(page, 'FontSizeUser');

    const textId = 'text-size-' + Date.now();
    await page.evaluate((id) => {
      // @ts-ignore
      const store = window.__whiteboardStore;
      if (store) {
        store.addElement({
          id,
          type: 'text',
          x: 100,
          y: 100,
          width: 200,
          height: 30,
          text: 'Size Test',
          color: '#000000',
          fontSize: 16,
          fontFamily: 'Arial',
          bold: false,
          italic: false,
          underline: false,
        });
      }
    }, textId);

    await page.waitForTimeout(300);

    let el = await getTextElement(page, textId);
    expect(el.fontSize).toBe(16);

    await page.getByTestId('whiteboard-tool-text').click();
    await page.waitForTimeout(200);

    const canvas = page.getByTestId('whiteboard-canvas-area');
    await canvas.click({ position: { x: 100, y: 100 } });
    await page.waitForTimeout(300);

    await page.getByTestId('text-editor-textarea').fill('Size Test');
    await page.waitForTimeout(200);

    await page.getByTestId('text-editor-font-size').selectOption('32');
    await page.waitForTimeout(200);

    await page.getByTestId('text-editor-apply').click();
    await page.waitForTimeout(300);

    el = await getTextElement(page, textId);
    expect(el.fontSize).toBe(32);
  });

  test('font family changes and persists', async ({ page }) => {
    await joinRoom(page, 'FontFamilyUser');

    const textId = 'text-family-' + Date.now();
    await page.evaluate((id) => {
      // @ts-ignore
      const store = window.__whiteboardStore;
      if (store) {
        store.addElement({
          id,
          type: 'text',
          x: 100,
          y: 100,
          width: 200,
          height: 30,
          text: 'Family Test',
          color: '#000000',
          fontSize: 16,
          fontFamily: 'Arial',
          bold: false,
          italic: false,
          underline: false,
        });
      }
    }, textId);

    await page.waitForTimeout(300);

    let el = await getTextElement(page, textId);
    expect(el.fontFamily).toBe('Arial');

    await page.getByTestId('whiteboard-tool-text').click();
    await page.waitForTimeout(200);

    const canvas = page.getByTestId('whiteboard-canvas-area');
    await canvas.click({ position: { x: 100, y: 100 } });
    await page.waitForTimeout(300);

    await page.getByTestId('text-editor-textarea').fill('Family Test');
    await page.waitForTimeout(200);

    await page.getByTestId('text-editor-font-family').selectOption('Times New Roman');
    await page.waitForTimeout(200);

    await page.getByTestId('text-editor-apply').click();
    await page.waitForTimeout(300);

    el = await getTextElement(page, textId);
    expect(el.fontFamily).toBe('Times New Roman');
  });

  test('text color changes and persists', async ({ page }) => {
    await joinRoom(page, 'ColorUser');

    const textId = 'text-color-' + Date.now();
    await page.evaluate((id) => {
      // @ts-ignore
      const store = window.__whiteboardStore;
      if (store) {
        store.addElement({
          id,
          type: 'text',
          x: 100,
          y: 100,
          width: 200,
          height: 30,
          text: 'Color Test',
          color: '#000000',
          fontSize: 16,
          fontFamily: 'Arial',
          bold: false,
          italic: false,
          underline: false,
        });
      }
    }, textId);

    await page.waitForTimeout(300);

    let el = await getTextElement(page, textId);
    expect(el.color).toBe('#000000');

    await page.getByTestId('whiteboard-tool-text').click();
    await page.waitForTimeout(200);

    const canvas = page.getByTestId('whiteboard-canvas-area');
    await canvas.click({ position: { x: 100, y: 100 } });
    await page.waitForTimeout(300);

    await page.getByTestId('text-editor-textarea').fill('Color Test');
    await page.waitForTimeout(200);

    await page.getByTestId('text-editor-color-ef4444').click();
    await page.waitForTimeout(200);

    await page.getByTestId('text-editor-apply').click();
    await page.waitForTimeout(300);

    el = await getTextElement(page, textId);
    expect(el.color).toBe('#ef4444');
  });

  test('combining bold, italic, and underline works', async ({ page }) => {
    await joinRoom(page, 'ComboUser');

    const textId = 'text-combo-' + Date.now();
    await page.evaluate((id) => {
      // @ts-ignore
      const store = window.__whiteboardStore;
      if (store) {
        store.addElement({
          id,
          type: 'text',
          x: 100,
          y: 100,
          width: 200,
          height: 30,
          text: 'Combo Test',
          color: '#000000',
          fontSize: 16,
          fontFamily: 'Arial',
          bold: false,
          italic: false,
          underline: false,
        });
      }
    }, textId);

    await page.waitForTimeout(300);

    await page.getByTestId('whiteboard-tool-text').click();
    await page.waitForTimeout(200);

    const canvas = page.getByTestId('whiteboard-canvas-area');
    await canvas.click({ position: { x: 100, y: 100 } });
    await page.waitForTimeout(300);

    await page.getByTestId('text-editor-textarea').fill('Combo Test');
    await page.waitForTimeout(200);

    await page.getByTestId('text-editor-bold').click();
    await page.getByTestId('text-editor-italic').click();
    await page.getByTestId('text-editor-underline').click();
    await page.waitForTimeout(200);

    await page.getByTestId('text-editor-apply').click();
    await page.waitForTimeout(300);

    const el = await getTextElement(page, textId);
    expect(el.bold).toBe(true);
    expect(el.italic).toBe(true);
    expect(el.underline).toBe(true);
  });

  test('toolbar is visible when editing text', async ({ page }) => {
    await joinRoom(page, 'ToolbarUser');

    await page.getByTestId('whiteboard-tool-text').click();
    await page.waitForTimeout(200);

    const canvas = page.getByTestId('whiteboard-canvas-area');
    await canvas.click({ position: { x: 100, y: 100 } });
    await page.waitForTimeout(300);

    // Check toolbar elements are visible
    await expect(page.getByTestId('text-editor-textarea')).toBeVisible();
    await expect(page.getByTestId('text-editor-font-size')).toBeVisible();
    await expect(page.getByTestId('text-editor-font-family')).toBeVisible();
    await expect(page.getByTestId('text-editor-bold')).toBeVisible();
    await expect(page.getByTestId('text-editor-italic')).toBeVisible();
    await expect(page.getByTestId('text-editor-underline')).toBeVisible();
    await expect(page.getByTestId('text-editor-apply')).toBeVisible();

    // Cleanup
    await page.getByTestId('text-editor-apply').click();
  });

  test('font size dropdown has expected options', async ({ page }) => {
    await joinRoom(page, 'FontOptionsUser');

    await page.getByTestId('whiteboard-tool-text').click();
    await page.waitForTimeout(200);

    const canvas = page.getByTestId('whiteboard-canvas-area');
    await canvas.click({ position: { x: 100, y: 100 } });
    await page.waitForTimeout(300);

    await page.getByTestId('text-editor-textarea').fill('Options Test');
    await page.waitForTimeout(200);

    const select = page.getByTestId('text-editor-font-size');
    await select.click();
    await page.waitForTimeout(200);

    const options = await page.locator('text-editor-font-size option').allTextContents();
    // Check that some expected sizes exist
    const optionTexts = await page.evaluate(() => {
      const select = document.querySelector('select[data-testid="text-editor-font-size"]');
      if (!select) return [];
      return Array.from((select as HTMLSelectElement).options).map(o => o.value);
    });
    expect(optionTexts).toContain('16');
    expect(optionTexts).toContain('32');

    // Cleanup
    await page.getByTestId('text-editor-apply').click();
  });
});
