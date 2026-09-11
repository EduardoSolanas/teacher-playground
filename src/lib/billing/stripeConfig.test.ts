import { describe, expect, it } from 'vitest';
import { readBillingEnv, STRIPE_API_VERSION } from './stripeConfig';

describe('readBillingEnv', () => {
  it('defaults the api base and returns null secrets when nothing is configured', () => {
    expect(readBillingEnv({})).toEqual({
      apiBaseUrl: 'https://api.stripe.com',
      secretKey: null,
      webhookSecret: null,
    });
  });

  it('reads STRIPE_API_BASE, STRIPE_SECRET_KEY, and STRIPE_WEBHOOK_SECRET from env', () => {
    const env = readBillingEnv({
      STRIPE_API_BASE: 'https://stripe.example.test',
      STRIPE_SECRET_KEY: 'sk_test_alpha',
      STRIPE_WEBHOOK_SECRET: 'whsec_alpha',
    });
    expect(env).toEqual({
      apiBaseUrl: 'https://stripe.example.test',
      secretKey: 'sk_test_alpha',
      webhookSecret: 'whsec_alpha',
    });
  });

  it('returns null (never throws) for an absent secret key', () => {
    const env = readBillingEnv({ STRIPE_SECRET_KEY: undefined });
    expect(env.secretKey).toBeNull();
  });

  it('returns null (never throws) for an absent webhook secret', () => {
    const env = readBillingEnv({});
    expect(env.webhookSecret).toBeNull();
  });
});

describe('STRIPE_API_VERSION', () => {
  it('pins 2026-08-26.dahlia per the D12 record (spec §12 lines ~1318-1325)', () => {
    expect(STRIPE_API_VERSION).toBe('2026-08-26.dahlia');
  });
});