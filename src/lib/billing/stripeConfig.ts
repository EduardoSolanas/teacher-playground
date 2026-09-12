/**
 * Stripe integration configuration and environment reads.
 *
 * The API version is pinned so the paused-collection decision (D12) holds on
 * the version this client actually speaks: spec §12 (D12 prerequisite,
 * lines ~1318-1325) records that the Subscription object exposes
 * `pause_collection` and the Customer Portal cannot pause or un-pause
 * payment collection, so option (a) stands.
 */
export const STRIPE_API_VERSION = '2026-08-26.dahlia';

export const STRIPE_API_BASE_DEFAULT = 'https://api.stripe.com';

const STRIPE_API_HOST = 'api.stripe.com';

export interface BillingEnv {
  apiBaseUrl: string;
  secretKey: string | null;
  webhookSecret: string | null;
  apiBaseAllowed: boolean;
}

function resolveApiBase(
  value: string | null | undefined,
  secretKey: string | null,
): { apiBaseUrl: string; apiBaseAllowed: boolean } {
  if (!value) {
    return { apiBaseUrl: STRIPE_API_BASE_DEFAULT, apiBaseAllowed: true };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { apiBaseUrl: STRIPE_API_BASE_DEFAULT, apiBaseAllowed: false };
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return { apiBaseUrl: STRIPE_API_BASE_DEFAULT, apiBaseAllowed: false };
  }
  if (url.host === STRIPE_API_HOST) {
    return { apiBaseUrl: url.origin, apiBaseAllowed: true };
  }
  if (url.hostname.includes(STRIPE_API_HOST)) {
    return { apiBaseUrl: STRIPE_API_BASE_DEFAULT, apiBaseAllowed: false };
  }
  return secretKey !== null && secretKey.startsWith('sk_test_')
    ? { apiBaseUrl: url.origin, apiBaseAllowed: true }
    : { apiBaseUrl: STRIPE_API_BASE_DEFAULT, apiBaseAllowed: false };
}

/**
 * Reads the billing-relevant environment bindings. Secret bindings live in
 * Worker secrets (spec §5.5); a missing binding reads as null and never
 * throws, so callers can distinguish "not configured" from a misconfigured
 * deployment.
 */
export function readBillingEnv(
  env: Readonly<Record<string, string | null | undefined>>,
): BillingEnv {
  const secretKey = env.STRIPE_SECRET_KEY ?? null;
  const { apiBaseUrl, apiBaseAllowed } = resolveApiBase(env.STRIPE_API_BASE, secretKey);
  return {
    apiBaseUrl,
    secretKey,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
    apiBaseAllowed,
  };
}
