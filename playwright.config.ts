import { defineConfig, devices } from "@playwright/test";

const appPort = Number(process.env.E2E_PORT);
const signalingPort = Number(process.env.E2E_SIGNALING_PORT);
if (!Number.isInteger(appPort) || !Number.isInteger(signalingPort)) {
  throw new Error("Run E2E tests through `npm run test:e2e` so dynamic ports are allocated.");
}

const baseURL = `http://127.0.0.1:${appPort}`;
const signalingURL = `ws://127.0.0.1:${signalingPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "html",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
    },
  ],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: false,
    env: {
      PORT: String(appPort),
      SIGNALING_PORT: String(signalingPort),
      NEXT_PUBLIC_YWEBRTC_SIGNALING_URL: signalingURL,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120000,
  },
});
