import { describe, expect, it } from 'vitest';
import { STRIPE_API_VERSION } from './stripeConfig';
import { collectionStateRequest, eventsFetchMapRequest } from './stripeRequest';

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