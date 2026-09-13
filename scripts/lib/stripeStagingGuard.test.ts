import { describe, expect, it } from 'vitest';
import { stagingStripeTargetError } from './stripeStagingGuard.mjs';

describe('stagingStripeTargetError (SEC-A17)', () => {
  it('accepts a test key bound for the real Stripe API', () => {
    expect(stagingStripeTargetError({ apiBase: 'https://api.stripe.com', secretKey: 'sk_test_abc' })).toBeNull();
    expect(stagingStripeTargetError({ apiBase: 'https://api.stripe.com/', secretKey: 'rk_test_abc' })).toBeNull();
  });

  it('refuses to let a staging run hold a live key at all', () => {
    expect(stagingStripeTargetError({ apiBase: 'https://api.stripe.com', secretKey: 'sk_live_abc' }))
      .toMatch(/test-mode key/);
    expect(stagingStripeTargetError({ apiBase: 'https://api.stripe.com', secretKey: 'rk_live_abc' }))
      .toMatch(/test-mode key/);
    expect(stagingStripeTargetError({ apiBase: 'https://api.stripe.com', secretKey: '' }))
      .toMatch(/test-mode key/);
  });

  it('refuses any destination for the key other than https://api.stripe.com', () => {
    for (const apiBase of [
      'http://api.stripe.com',
      'https://api.stripe.com.evil.example',
      'https://evil.example',
      'https://evil.example/api.stripe.com',
      'https://user@api.stripe.com',
      'https://api.stripe.com:8443',
      'not a url',
      '',
    ]) {
      expect(stagingStripeTargetError({ apiBase, secretKey: 'sk_test_abc' }), apiBase).toMatch(/api\.stripe\.com/);
    }
  });
});
