import { describe, expect, it } from 'vitest';
import { STRIPE_API_VERSION } from './stripeConfig';
import {
  InvalidStripeIdError,
  checkoutSessionRequest,
  collectionStateRequest,
  eventsFetchMapRequest,
  invoiceSubscriptionRequest,
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

describe('Stripe id grammar (SEC-A24)', () => {
  it.each(['../sub_1', 'sub/1', 'sub?1', 'sub#1', 'sub 1', '', 'sub_1\n', 's'.repeat(256)])(
    'builds no webhook fetch for the malformed id %j',
    (id) => {
      expect(eventsFetchMapRequest(BASE, KEY, 'customer.subscription.updated', id)).toBeNull();
    },
  );

  it('refuses to build a collection request from a malformed subscription id', () => {
    expect(() => collectionStateRequest(BASE, KEY, '../sub_1', 'canceled', 7))
      .toThrow(InvalidStripeIdError);
    expect(() => collectionStateRequest(BASE, KEY, 'sub 1', 'paused', 7))
      .toThrow(InvalidStripeIdError);
  });

  it('refuses a checkout referral or promotion code outside the id grammar', () => {
    const input = {
      accountId: 'acc_1',
      planId: 'tutor_pro_monthly' as const,
      priceId: 'price_server_monthly',
      operationId: 'op_1',
      successUrl: 'https://app.example/whiteboard?billing=ok',
      cancelUrl: 'https://app.example/pricing',
    };
    expect(() => checkoutSessionRequest(BASE, KEY, { ...input, referralCode: 'PARTNER 7' }))
      .toThrow(InvalidStripeIdError);
    expect(() => checkoutSessionRequest(BASE, KEY, { ...input, promotionCodeId: 'promo_7?x' }))
      .toThrow(InvalidStripeIdError);
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

describe('invoiceSubscriptionRequest', () => {
  it('creates an invoice-first subscription with the thirty-day due window and invoice link', async () => {
    const request = invoiceSubscriptionRequest(BASE, KEY, {
      companyId: 'co_1',
      operationId: 'op_invoice_1',
      processorCustomerId: 'cus_1',
      priceId: 'price_corporate_seat',
      quantity: 12,
    });
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/v1/subscriptions');
    expect(request.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(request.headers.get('idempotency-key')).toBe(
      'op:company:co_1:op_invoice_1',
    );
    expectStripeHeaders(request);
    const body = Object.fromEntries(new URLSearchParams(await request.text()));
    expect(body).toEqual({
      customer: 'cus_1',
      collection_method: 'send_invoice',
      days_until_due: '30',
      'items[0][price]': 'price_corporate_seat',
      'items[0][quantity]': '12',
      'expand[0]': 'latest_invoice',
    });
  });

  it('refuses malformed Stripe ids and a non-positive quantity', () => {
    const valid = {
      companyId: 'co_1',
      operationId: 'op_invoice_1',
      processorCustomerId: 'cus_1',
      priceId: 'price_corporate_seat',
      quantity: 12,
    };
    expect(() =>
      invoiceSubscriptionRequest(BASE, KEY, { ...valid, processorCustomerId: 'not a customer' }),
    ).toThrow(InvalidStripeIdError);
    expect(() =>
      invoiceSubscriptionRequest(BASE, KEY, { ...valid, priceId: 'price with spaces' }),
    ).toThrow(InvalidStripeIdError);
    expect(() =>
      invoiceSubscriptionRequest(BASE, KEY, { ...valid, quantity: 0 }),
    ).toThrow(InvalidStripeIdError);
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

describe('Stripe request validation hardening', () => {
  const checkoutInput = {
    accountId: 'acc_1',
    planId: 'tutor_pro_monthly' as const,
    priceId: 'price_server_monthly',
    operationId: 'op_1',
    successUrl: 'https://app.example/whiteboard?billing=ok',
    cancelUrl: 'https://app.example/pricing',
  };
  const invoiceInput = {
    companyId: 'co_1',
    operationId: 'op_invoice_1',
    processorCustomerId: 'cus_1',
    priceId: 'price_corporate_seat',
    quantity: 12,
  };

  it('names the InvalidStripeIdError class and keeps its message', () => {
    const error = new InvalidStripeIdError('Invalid Stripe id for subscriptionId');
    expect(error.name).toBe('InvalidStripeIdError');
    expect(error.message).toBe('Invalid Stripe id for subscriptionId');
  });

  it('names the offending field in every id rejection', () => {
    expect(() => collectionStateRequest(BASE, KEY, 'sub 1', 'paused', 7))
      .toThrow('Invalid Stripe id for subscriptionId');
    expect(() => checkoutSessionRequest(BASE, KEY, { ...checkoutInput, referralCode: 'PARTNER 7' }))
      .toThrow('Invalid Stripe id for referralCode');
    expect(() => checkoutSessionRequest(BASE, KEY, { ...checkoutInput, promotionCodeId: 'promo_7?x' }))
      .toThrow('Invalid Stripe id for promotionCodeId');
    expect(() => invoiceSubscriptionRequest(BASE, KEY, { ...invoiceInput, processorCustomerId: 'not a customer' }))
      .toThrow('Invalid Stripe id for processorCustomerId');
    expect(() => invoiceSubscriptionRequest(BASE, KEY, { ...invoiceInput, priceId: 'price with spaces' }))
      .toThrow('Invalid Stripe id for priceId');
    expect(() => invoiceSubscriptionRequest(BASE, KEY, { ...invoiceInput, quantity: 0 }))
      .toThrow('Invalid quantity for subscription');
  });

  it('names the offending field in every idempotency-key rejection', () => {
    expect(() => invoiceSubscriptionRequest(BASE, KEY, { ...invoiceInput, companyId: 'co 1' }))
      .toThrow('Invalid operation key for companyId');
    expect(() => invoiceSubscriptionRequest(BASE, KEY, { ...invoiceInput, operationId: 'op 1' }))
      .toThrow('Invalid operation key for operationId');
  });

  it('accepts the quantity bounds and refuses values outside them', () => {
    expect(invoiceSubscriptionRequest(BASE, KEY, { ...invoiceInput, quantity: 1 }).method).toBe('POST');
    expect(invoiceSubscriptionRequest(BASE, KEY, { ...invoiceInput, quantity: 10_000 }).method).toBe('POST');
    expect(() => invoiceSubscriptionRequest(BASE, KEY, { ...invoiceInput, quantity: 10_001 }))
      .toThrow(InvalidStripeIdError);
    expect(() => invoiceSubscriptionRequest(BASE, KEY, { ...invoiceInput, quantity: 2.5 }))
      .toThrow(InvalidStripeIdError);
  });

  it('refuses an over-long or internally spaced operation key', () => {
    expect(() => invoiceSubscriptionRequest(BASE, KEY, { ...invoiceInput, companyId: 'c'.repeat(129) }))
      .toThrow(InvalidStripeIdError);
    expect(() => invoiceSubscriptionRequest(BASE, KEY, { ...invoiceInput, operationId: 'op 1' }))
      .toThrow(InvalidStripeIdError);
  });

  it('leaves the query string empty for requests that carry no search params', () => {
    expect(new URL(checkoutSessionRequest(BASE, KEY, checkoutInput).url).search).toBe('');
    expect(new URL(collectionStateRequest(BASE, KEY, 'sub_1', 'paused', 1).url).search).toBe('');
    expect(new URL(portalSessionRequest(BASE, KEY, {
      accountId: 'acc_1',
      processorCustomerId: 'cus_1',
      operationId: 'op_1',
      returnUrl: 'https://app.example/whiteboard?billing=portal',
    }).url).search).toBe('');
  });

  it('sets the form content type on collection-state POSTs', () => {
    expect(collectionStateRequest(BASE, KEY, 'sub_1', 'paused', 1).headers.get('content-type'))
      .toBe('application/x-www-form-urlencoded');
    expect(collectionStateRequest(BASE, KEY, 'sub_1', 'active', 1).headers.get('content-type'))
      .toBe('application/x-www-form-urlencoded');
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
