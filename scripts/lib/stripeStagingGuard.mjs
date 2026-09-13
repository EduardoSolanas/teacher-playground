/**
 * Where a staging run may send a Stripe key, decided before any request exists
 * (SEC-A17).
 *
 * The staging workflow takes STRIPE_API_BASE from a free-text dispatch input
 * and hands it to the runner beside STRIPE_SECRET_KEY, so whoever dispatches
 * the run names the host the key would go to. Stripe serves test mode from the
 * same host as live mode, so a staging run never has a reason to use any other
 * base, and never a reason to hold a live key.
 *
 * Returns a message saying what is wrong, or null when the pair is acceptable.
 *
 * @param {{ apiBase: string, secretKey: string }} target
 * @returns {string | null}
 */
export function stagingStripeTargetError({ apiBase, secretKey }) {
  if (!/^(sk|rk)_test_/.test(secretKey ?? '')) {
    return 'STRIPE_SECRET_KEY must be a Stripe test-mode key (sk_test_ or rk_test_); a staging run never holds a live key.';
  }
  let url;
  try {
    url = new URL(apiBase);
  } catch {
    return 'STRIPE_API_BASE must be https://api.stripe.com.';
  }
  const exact = url.protocol === 'https:'
    && url.hostname === 'api.stripe.com'
    && url.port === ''
    && url.username === ''
    && url.password === ''
    && (url.pathname === '/' || url.pathname === '');
  return exact ? null : 'STRIPE_API_BASE must be https://api.stripe.com.';
}
