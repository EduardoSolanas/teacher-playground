import { test, expect } from './fixtures';
import { Page } from '@playwright/test';

function appUrl(path: string) {
  return new URL(path, process.env.PLAYWRIGHT_BASE_URL).toString();
}

async function createRoom(page: Page, name: string) {
  await page.goto(appUrl('/whiteboard'));
  await expect(page.locator('h1')).toContainText('Collaborative Whiteboard');
  await page.getByTestId('whiteboard-create-room-btn').click();
  await expect(page.getByTestId('whiteboard-username-input')).toBeVisible();
  await page.getByTestId('whiteboard-username-input').fill(name);
  await page.getByTestId('whiteboard-join-room-btn').click();
  await expect(page.getByTestId('whiteboard-canvas-area')).toBeVisible({ timeout: 15000 });
}

test('moving the pointer does not flood signaling into a disconnect', async ({ page }) => {
  test.setTimeout(120_000);

  const frames: number[] = [];
  let closes = 0;
  page.on('websocket', (ws) => {
    ws.on('framesent', () => frames.push(Date.now()));
    ws.on('close', () => { closes += 1; });
  });

  await createRoom(page, 'FloodHost');
  await page.waitForTimeout(2000);

  const box = (await page.getByTestId('whiteboard-canvas-area').boundingBox())!;
  frames.length = 0;
  closes = 0;

  // ~2 seconds of continuous pointer movement.
  for (let i = 0; i < 120; i += 1) {
    await page.mouse.move(box.x + 100 + (i % 50) * 4, box.y + 100 + (i % 30) * 4);
  }
  await page.waitForTimeout(1500);

  // Peak outbound rate must stay under the Worker's 60 msg/sec signaling cap,
  // which closes the socket with 1008 and drops the user back to "Connecting".
  let peakPerSecond = 0;
  for (const t of frames) {
    const inWindow = frames.filter((o) => o >= t && o < t + 1000).length;
    if (inWindow > peakPerSecond) peakPerSecond = inWindow;
  }
  console.log(`SENT_FRAMES=${frames.length} PEAK_PER_SEC=${peakPerSecond} CLOSES=${closes}`);

  expect(peakPerSecond, 'outbound signaling messages in any 1s window').toBeLessThan(60);
  expect(closes, 'signaling socket closures while moving the pointer').toBe(0);
  await expect(page.getByText('Connecting to room...')).toHaveCount(0);
});
