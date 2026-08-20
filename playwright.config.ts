import { defineConfig, devices } from "@playwright/test";
import "./tests/e2e/localhostDns";
import { cfAuthorizationCookie, playwrightBaseURL } from "./tests/e2e/origins";

const appPort = Number(process.env.E2E_PORT);
if (!Number.isInteger(appPort)) {
  throw new Error("Run E2E tests through `npm run test:e2e` so dynamic ports are allocated.");
}

const accessIssuer = process.env.E2E_ACCESS_ISSUER;
const accessToken = process.env.E2E_ACCESS_TOKEN;
if (!accessIssuer || !accessToken) {
  throw new Error("Run E2E tests through npm run test:e2e so the local Access issuer is configured.");
}

const baseURL = playwrightBaseURL();

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: process.env.CI ? 60_000 : 30_000,
  expect: {
    timeout: 5_000,
  },
  // Rooms are independent Durable Objects, but IdentityDO is a singleton.
  // CI GitHub runners queue session issue past the bootstrap abort if several
  // Playwright workers mint new Access subjects at once.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : 4,
  reporter: "html",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 720 },
    baseURL,
    // Defaults to 0, meaning an action waits until the whole test times out.
    // A prompt that unmounts mid-fill then costs 60s instead of failing fast.
    actionTimeout: 10_000,
    storageState: {
      cookies: [cfAuthorizationCookie(accessToken)],
      origins: [],
    },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
    },
  ],
});
