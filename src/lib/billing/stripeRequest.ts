/**
 * Pure Stripe API request builders (spec §7.1 fetch map, §7.2 collection
 * state).  Every function returns a real `Request`; nothing is executed
 * here — execution is the responsibility of stripeClient.
 */
import { STRIPE_API_VERSION } from './stripeConfig';
import type { PlanId } from '../plan/catalog';

type CollectionState = 'active' | 'paused' | 'canceled';

export interface CheckoutSessionInput {
  accountId: string;
  planId: PlanId;
  priceId: string;
  operationId: string;
  successUrl: string;
  cancelUrl: string;
  referralCode?: string;
  promotionCodeId?: string;
}

function stripeHeaders(secretKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${secretKey}`,
    'Stripe-Version': STRIPE_API_VERSION,
  };
}

function endpoint(apiBaseUrl: string, path: string, search?: string): string {
  const url = new URL(path, apiBaseUrl);
  if (search) url.search = search;
  return url.toString();
}

/**
 * §7.1 fetch map: given an event type and object id, returns the GET
 * `Request` needed to re-fetch the authoritative Stripe object, or `null`
 * for an event type that requires no re-fetch.
 */
export function eventsFetchMapRequest(
  apiBaseUrl: string,
  secretKey: string,
  eventType: string,
  id: string,
): Request | null {
  let path: string;
  let search: string | undefined;
  if (eventType.startsWith('checkout.session.')) {
    path = `/v1/checkout/sessions/${id}`;
  } else if (eventType.startsWith('customer.subscription.')) {
    path = `/v1/subscriptions/${id}`;
  } else if (eventType.startsWith('invoice.')) {
    path = `/v1/invoices/${id}`;
    const params = new URLSearchParams();
    params.append('expand[]', 'parent.subscription_details.subscription');
    search = params.toString();
  } else if (eventType === 'charge.refunded') {
    path = `/v1/charges/${id}`;
  } else if (eventType.startsWith('charge.dispute.')) {
    path = `/v1/disputes/${id}`;
  } else {
    return null;
  }
  return new Request(endpoint(apiBaseUrl, path, search), {
    method: 'GET',
    headers: stripeHeaders(secretKey),
  });
}

/**
 * §7.2 step 2: builder for the collection-state call (pause, resume,
 * or cancel) with the deterministic idempotency key.
 */
export function collectionStateRequest(
  apiBaseUrl: string,
  secretKey: string,
  subscriptionId: string,
  desired: CollectionState,
  version: number,
): Request {
  const url = endpoint(apiBaseUrl, `/v1/subscriptions/${subscriptionId}`);
  const headers: Record<string, string> = {
    ...stripeHeaders(secretKey),
    'Idempotency-Key': `collection:${subscriptionId}:${version}`,
  };

  if (desired === 'canceled') {
    return new Request(url, { method: 'DELETE', headers });
  }

  const params = new URLSearchParams();
  if (desired === 'paused') {
    params.append('pause_collection[behavior]', 'void');
  } else {
    params.append('pause_collection', '');
  }
  headers['Content-Type'] = 'application/x-www-form-urlencoded';
  return new Request(url, { method: 'POST', headers, body: params.toString() });
}

export function checkoutSessionRequest(
  apiBaseUrl: string,
  secretKey: string,
  input: CheckoutSessionInput,
): Request {
  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', input.priceId);
  params.append('line_items[0][quantity]', '1');
  params.append('client_reference_id', input.accountId);
  params.append('success_url', input.successUrl);
  params.append('cancel_url', input.cancelUrl);
  if (input.referralCode) {
    params.append('metadata[referrer_code]', input.referralCode);
    params.append('subscription_data[metadata][referrer_code]', input.referralCode);
  }
  if (input.promotionCodeId) {
    params.append('discounts[0][promotion_code]', input.promotionCodeId);
  }

  const headers: Record<string, string> = {
    ...stripeHeaders(secretKey),
    'Content-Type': 'application/x-www-form-urlencoded',
    'Idempotency-Key': `op:account:${input.accountId}:${input.operationId}`,
  };
  return new Request(endpoint(apiBaseUrl, '/v1/checkout/sessions'), {
    method: 'POST',
    headers,
    body: params.toString(),
  });
}

export interface PortalSessionInput {
  accountId: string;
  processorCustomerId: string;
  operationId: string;
  returnUrl: string;
}

export function portalSessionRequest(
  apiBaseUrl: string,
  secretKey: string,
  input: PortalSessionInput,
): Request {
  const params = new URLSearchParams();
  params.append('customer', input.processorCustomerId);
  params.append('return_url', input.returnUrl);

  const headers: Record<string, string> = {
    ...stripeHeaders(secretKey),
    'Content-Type': 'application/x-www-form-urlencoded',
    'Idempotency-Key': `op:account:${input.accountId}:${input.operationId}`,
  };
  return new Request(endpoint(apiBaseUrl, '/v1/billing_portal/sessions'), {
    method: 'POST',
    headers,
    body: params.toString(),
  });
}
