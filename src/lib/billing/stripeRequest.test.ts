import { describe, expect, it } from 'vitest';
import { STRIPE_API_VERSION } from './stripeConfig';
import {
  checkoutSessionRequest,
  collectionStateRequest,
  eventsFetchMapRequest,
  portalSessionRequest,
} from './stripeRequest';

const BASE = 'https://api.stripe.com';
const KEY = 'sk_test_alpha';

function expectStripeHeaders(request: Request): void {
  expect(request.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  expect(request.headers.get('stripe-version')).toBe(STRIPE_API_VERSION);
}

describe('eventsFetchMapRequest', () => {
  it('maps checkout.session.* to GET /v1/checkout/sessions/{id}', () => {
    const request = eventsFetchMapRequest(BASE, KEY, 'checkout.session.completed', 'cs_123');
    expect(request).not.toBeNull();
    const url = new URL(request!.url);
    expect(request!.method).toBe('GET');
    expect(url.pathname).toBe('/v1/checkout/sessions/cs_123');
    expectStripeHeaders(request!);
  });

  it('maps customer.subscription.* to GET /v1/subscriptions/{id}', () => {
    const request = eventsFetchMapRequest(BASE, KEY, 'customer.subscription.updated', 'sub_123');
    expect(request).not.toBeNull();
    const url = new URL(request!.url);
    expect(request!.method).toBe('GET');
    expect(url.pathname).toBe('/v1/subscriptions/sub_123');
    expectStripeHeaders(request!);
  });

  it('maps invoice.* to GET /v1/invoices/{id} with the expand[] query', () => {
    const request = eventsFetchMapRequest(BASE, KEY, 'invoice.paid', 'in_123');
    expect(request).not.toBeNull();
    const url = new URL(request!.url);
    expect(request!.method).toBe('GET');
    expect(url.pathname).toBe('/v1/invoices/in_123');
    expect(url.searchParams.get('expand[]')).toBe('parent.subscription_details.subscription');
    expectStripeHeaders(request!);
  });

  it('maps charge.refunded to GET /v1/charges/{id}', () => {
    const request = eventsFetchMapRequest(BASE, KEY, 'charge.refunded', 'ch_123');
    expect(request).not.toBeNull();
    const url = new URL(request!.url);
    expect(request!.method).toBe('GET');
    expect(url.pathname).toBe('/v1/charges/ch_123');
    expectStripeHeaders(request!);
  });

  it('maps charge.dispute.* to GET /v1/disputes/{id}', () => {
    const request = eventsFetchMapRequest(BASE, KEY, 'charge.dispute.created', 'dp_123');
    expect(request).not.toBeNull();
    const url = new URL(request!.url);
    expect(request!.method).toBe('GET');
    expect(url.pathname).toBe('/v1/disputes/dp_123');
    expectStripeHeaders(request!);
  });

  it('returns null for an unknown event type', () => {
    expect(eventsFetchMapRequest(BASE, KEY, 'charge.created', 'ch_123')).toBeNull();
  });
});

describe('collectionStateRequest', () => {
  it('deletes the subscription for canceled with the versioned idempotency key', () => {
    const request = collectionStateRequest(BASE, KEY, 'sub_123', 'canceled', 7);
    expect(request.method).toBe('DELETE');
    expect(new URL(request.url).pathname).toBe('/v1/subscriptions/sub_123');
    expect(request.headers.get('idempotency-key')).toBe('collection:sub_123:7');
    expectStripeHeaders(request);
  });

  it('posts pause_collection[behavior]=void for paused', async () => {
    const request = collectionStateRequest(BASE, KEY, 'sub_123', 'paused', 7);
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/v1/subscriptions/sub_123');
    expect(request.headers.get('idempotency-key')).toBe('collection:sub_123:7');
    const params = new URLSearchParams(await request.text());
    expect(params.get('pause_collection[behavior]')).toBe('void');
    expectStripeHeaders(request);
  });

  it('posts a cleared pause_collection for active', async () => {
    const request = collectionStateRequest(BASE, KEY, 'sub_123', 'active', 7);
    expect(request.method).toBe('POST');
    expect(request.headers.get('idempotency-key')).toBe('collection:sub_123:7');
    const params = new URLSearchParams(await request.text());
    expect(params.get('pause_collection')).toBe('');
    expect(params.get('pause_collection[behavior]')).toBeNull();
    expectStripeHeaders(request);
  });
});

describe('checkoutSessionRequest', () => {
  it('checkout builder ignores client priceId and amount', async () => {
    const base = {
      accountId: 'acc_1',
      planId: 'tutor_pro_monthly' as const,
      priceId: 'price_server_monthly',
      operationId: 'op_1',
      successUrl: 'https://app.example/whiteboard?billing=ok',
      cancelUrl: 'https://app.example/pricing',
      clientPriceId: 'price_client_evil',
      amount: 999,
    };
    const monthlyRequest = checkoutSessionRequest(BASE, KEY, base);
    expect(monthlyRequest.method).toBe('POST');
    expect(new URL(monthlyRequest.url).pathname).toBe('/v1/checkout/sessions');
    expect(monthlyRequest.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expectStripeHeaders(monthlyRequest);
    const monthlyBody = Object.fromEntries(new URLSearchParams(await monthlyRequest.text()));
    expect(monthlyBody).toEqual({
      mode: 'subscription',
      'line_items[0][price]': 'price_server_monthly',
      'line_items[0][quantity]': '1',
      client_reference_id: 'acc_1',
      success_url: 'https://app.example/whiteboard?billing=ok',
      cancel_url: 'https://app.example/pricing',
    });

    const annualRequest = checkoutSessionRequest(BASE, KEY, {
      ...base,
      planId: 'tutor_pro_annual' as const,
      priceId: 'price_server_annual',
    });
    const annualBody = Object.fromEntries(new URLSearchParams(await annualRequest.text()));
    expect(annualBody).toEqual({
      ...monthlyBody,
      'line_items[0][price]': 'price_server_annual',
    });

    const serialized = JSON.stringify([monthlyBody, annualBody]);
    expect(serialized).not.toContain('price_client_evil');
    expect(serialized).not.toContain('999');
    expect(serialized).not.toContain('amount');
  });

  it('sends the account-scoped idempotency key for the operation', () => {
    const request = checkoutSessionRequest(BASE, KEY, {
      accountId: 'acc_1',
      planId: 'tutor_pro_monthly',
      priceId: 'price_server_monthly',
      operationId: 'op_9',
      successUrl: 'https://app.example/whiteboard?billing=ok',
      cancelUrl: 'https://app.example/pricing',
    });
    expect(request.headers.get('idempotency-key')).toBe('op:account:acc_1:op_9');
  });

  it('adds referral metadata only when a referral code is supplied', async () => {
    const input = {
      accountId: 'acc_1',
      planId: 'tutor_pro_monthly' as const,
      priceId: 'price_server_monthly',
      operationId: 'op_1',
      successUrl: 'https://app.example/whiteboard?billing=ok',
      cancelUrl: 'https://app.example/pricing',
    };
    const withCode = checkoutSessionRequest(BASE, KEY, { ...input, referralCode: 'PARTNER7' });
    const withBody = Object.fromEntries(new URLSearchParams(await withCode.text()));
    expect(withBody['metadata[referrer_code]']).toBe('PARTNER7');
    expect(withBody['subscription_data[metadata][referrer_code]']).toBe('PARTNER7');

    const withoutCode = checkoutSessionRequest(BASE, KEY, input);
    const withoutBody = Object.fromEntries(new URLSearchParams(await withoutCode.text()));
    expect(withoutBody).not.toHaveProperty('metadata[referrer_code]');
    expect(withoutBody).not.toHaveProperty('subscription_data[metadata][referrer_code]');
  });

  it('adds the mirrored promotion code as a discount only when supplied', async () => {
    const input = {
      accountId: 'acc_1',
      planId: 'tutor_pro_annual' as const,
      priceId: 'price_server_annual',
      operationId: 'op_1',
      successUrl: 'https://app.example/whiteboard?billing=ok',
      cancelUrl: 'https://app.example/pricing',
      referralCode: 'PARTNER7',
    };
    const withPromo = checkoutSessionRequest(BASE, KEY, { ...input, promotionCodeId: 'promo_7' });
    const withBody = Object.fromEntries(new URLSearchParams(await withPromo.text()));
    expect(withBody['discounts[0][promotion_code]']).toBe('promo_7');

    const withoutPromo = checkoutSessionRequest(BASE, KEY, input);
    const withoutBody = Object.fromEntries(new URLSearchParams(await withoutPromo.text()));
    expect(withoutBody).not.toHaveProperty('discounts[0][promotion_code]');
  });
});

describe('portalSessionRequest', () => {
  it('posts the customer and return_url to /v1/billing_portal/sessions', async () => {
    const request = portalSessionRequest(BASE, KEY, {
      accountId: 'acc_1',
      processorCustomerId: 'cus_123',
      operationId: 'op_1',
      returnUrl: 'https://app.example/whiteboard?billing=portal',
    });
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/v1/billing_portal/sessions');
    expect(request.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expectStripeHeaders(request);
    const params = new URLSearchParams(await request.text());
    expect(params.get('customer')).toBe('cus_123');
    expect(params.get('return_url')).toBe('https://app.example/whiteboard?billing=portal');
  });

  it('sends the account-scoped idempotency key for the operation', () => {
    const request = portalSessionRequest(BASE, KEY, {
      accountId: 'acc_1',
      processorCustomerId: 'cus_123',
      operationId: 'op_9',
      returnUrl: 'https://app.example/whiteboard?billing=portal',
    });
    expect(request.headers.get('idempotency-key')).toBe('op:account:acc_1:op_9');
  });
});
