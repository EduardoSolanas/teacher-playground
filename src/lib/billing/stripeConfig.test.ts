import { describe, expect, it } from 'vitest';
import { readBillingEnv, STRIPE_API_VERSION } from './stripeConfig';

describe('readBillingEnv', () => {
  it('defaults the api base and returns null secrets when nothing is configured', () => {
    expect(readBillingEnv({})).toEqual({
      apiBaseUrl: 'https://api.stripe.com',
      secretKey: null,
      webhookSecret: null,
      apiBaseAllowed: true,
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
      apiBaseAllowed: true,
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

describe('readBillingEnv STRIPE_API_BASE validation (SEC-A17)', () => {
  it('falls back to the Stripe default and marks the config unallowed for non-HTTPS or non-Stripe hosts', () => {
    for (const base of [
      'http://evil.example',
      'https://api.stripe.com.evil.example',
      'ftp://api.stripe.com',
      'not a url',
      'https://user:pass@api.stripe.com',
    ]) {
      const env = readBillingEnv({ STRIPE_API_BASE: base, STRIPE_SECRET_KEY: 'sk_test_alpha' });
      expect(env.apiBaseUrl, base).toBe('https://api.stripe.com');
      expect(env.apiBaseAllowed, base).toBe(false);
    }
  });

  it('accepts a test-mode key pointed at a non-Stripe base and normalizes it to its origin', () => {
    const env = readBillingEnv({
      STRIPE_API_BASE: 'https://stripe.example.test/prefix',
      STRIPE_SECRET_KEY: 'sk_test_alpha',
    });
    expect(env.apiBaseUrl).toBe('https://stripe.example.test');
    expect(env.apiBaseAllowed).toBe(true);
  });

  it('refuses a live key pointed at anything but api.stripe.com', () => {
    const env = readBillingEnv({
      STRIPE_API_BASE: 'https://stripe.example.test',
      STRIPE_SECRET_KEY: 'sk_live_alpha',
    });
    expect(env.apiBaseUrl).toBe('https://api.stripe.com');
    expect(env.apiBaseAllowed).toBe(false);
  });

  it('accepts the production base with a live or test key', () => {
    expect(readBillingEnv({
      STRIPE_API_BASE: 'https://api.stripe.com',
      STRIPE_SECRET_KEY: 'sk_live_alpha',
    }).apiBaseAllowed).toBe(true);
    expect(readBillingEnv({
      STRIPE_API_BASE: 'https://api.stripe.com',
      STRIPE_SECRET_KEY: 'sk_test_alpha',
    }).apiBaseAllowed).toBe(true);
  });

  it('treats an absent base as the allowed production default', () => {
    const env = readBillingEnv({ STRIPE_SECRET_KEY: 'sk_live_alpha' });
    expect(env.apiBaseUrl).toBe('https://api.stripe.com');
    expect(env.apiBaseAllowed).toBe(true);
  });
});

describe('STRIPE_API_VERSION', () => {
  it('pins 2026-08-26.dahlia per the D12 record (spec §12 lines ~1318-1325)', () => {
    expect(STRIPE_API_VERSION).toBe('2026-08-26.dahlia');
  });
});