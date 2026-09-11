import { test as base, expect } from '@playwright/test';
import './localhostDns';
import { cfAuthorizationCookie } from './origins';
import { BrowserCoverage, COVERAGE_ENABLED, writeTestCoverage } from './coverage';

async function uniqueAccessStorageState() {
  const issuer = process.env.E2E_ACCESS_ISSUER;
  if (!issuer) throw new Error('E2E_ACCESS_ISSUER is missing; use npm run test:e2e');
  const response = await fetch(`${issuer}/token?sub=${encodeURIComponent(`e2e-${crypto.randomUUID()}`)}`);
  if (!response.ok) throw new Error(`E2E local Access token failed: ${response.status}`);
  const token = (await response.json()).token as string;
  return {
    cookies: [cfAuthorizationCookie(token)],
    origins: [],
  };
}

/**
 * Each test gets its own Access subject so parallel workers do not share one
 * account's presence/create rate-limit bucket.
 */
const authenticated = base.extend({
  storageState: async ({}, provide) => {
    await provide(await uniqueAccessStorageState());
  },
});

/*
 * Only a coverage run gets the collector. It depends on `context`, so an
 * ordinary run must not see it at all: a test that only uses `browser` would
 * otherwise pay for a context it never asked for.
 */
const withCoverage = authenticated.extend<{ _coverage: void }>({
  _coverage: [
    async ({ browser, context }, provide, testInfo) => {
      const coverage = new BrowserCoverage();
      await coverage.instrument(context);
      const restore = coverage.wrapBrowser(browser);
      try {
        await provide();
      } finally {
        restore();
        writeTestCoverage(testInfo, await coverage.flushAll());
      }
    },
    { auto: true },
  ],
});

export const test = (COVERAGE_ENABLED ? withCoverage : authenticated) as typeof authenticated;

export { expect };
