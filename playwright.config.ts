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
  /*
   * Four was more than a developer machine can actually run.
   *
   * Measured, not guessed: at four workers the suite went green 1 run in 10,
   * and the failures were the multi-peer sync cases -- a late joiner given 15s
   * to receive three elements, missing it. Run serially the same suite is
   * 26/27, and every case that failed in parallel passes on its own. Four
   * Chromium instances, a wrangler dev server and workerd on one box do not
   * leave enough CPU for a sync deadline to mean what it says, so the suite was
   * reporting the machine's load as the product's flakiness.
   *
   * Two keeps the parallelism worth having and leaves the deadlines honest.
   * `E2E_WORKERS` overrides it on a machine with cores to spare.
   *
   * CI is tested first and is not overridable: one worker there is not a
   * performance choice but a correctness one -- IdentityDO is a singleton, and
   * several workers minting Access subjects at once queue session issue past
   * the bootstrap abort. An override that could reach that setting would be a
   * way to break it from a workflow file.
   */
  workers: process.env.CI
    ? 1
    : Number(process.env.E2E_WORKERS ?? 2),
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
