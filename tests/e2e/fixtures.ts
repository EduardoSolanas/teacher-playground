import { test as base, expect } from '@playwright/test';
import './localhostDns';
import { cfAuthorizationCookie } from './origins';

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
export const test = base.extend({
  storageState: async ({}, provide) => {
    await provide(await uniqueAccessStorageState());
  },
});

export { expect };
