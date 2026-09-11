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

const DEFAULT_API_BASE_URL = 'https://api.stripe.com';

export interface BillingEnv {
  apiBaseUrl: string;
  secretKey: string | null;
  webhookSecret: string | null;
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
  return {
    apiBaseUrl: env.STRIPE_API_BASE ?? DEFAULT_API_BASE_URL,
    secretKey: env.STRIPE_SECRET_KEY ?? null,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
  };
}