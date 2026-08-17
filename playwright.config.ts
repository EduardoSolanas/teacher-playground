import { defineConfig, devices } from "@playwright/test";

const appPort = Number(process.env.E2E_PORT);
if (!Number.isInteger(appPort)) {
  throw new Error("Run E2E tests through `npm run test:e2e` so dynamic ports are allocated.");
}

// Chromium permits Secure cookies on the loopback `localhost` origin. Keep
// the cookie Secure/__Host- prefixed in local browser coverage.
const baseURL = `http://localhost:${appPort}`;
const accessIssuer = process.env.E2E_ACCESS_ISSUER;
const accessToken = process.env.E2E_ACCESS_TOKEN;
if (!accessIssuer || !accessToken) {
  throw new Error("Run E2E tests through npm run test:e2e so the local Access issuer is configured.");
}

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
    storageState: {
      cookies: [{
        name: "CF_Authorization",
        value: accessToken,
        domain: "localhost",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 3_600,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      }],
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
