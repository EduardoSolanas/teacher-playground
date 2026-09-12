import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import {
  BILLING_OPERATION_RATE_MAX,
  getIdentityObject,
  type IdentityDO,
} from './do/IdentityDO';
import { bootstrapLocalSession, authenticatedFetch, localAccessToken } from './test/workerAuth';
import { writeEntitlement } from './lib/identity/entitlementWriter';

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY: DurableObjectNamespace<IdentityDO>;
      STRIPE_API_BASE: string;
      STRIPE_SECRET_KEY: string;
      STRIPE_WEBHOOK_SECRET: string;
      STRIPE_PRICE_TUTOR_PRO_MONTHLY: string;
    }
  }
}

const TEACHER_BASE = 'https://example.com';
const GUEST_BASE = 'https://join.example.com';
const MARKETING_BASE = 'https://www.example.com';
const WEBHOOK_PATH = '/api/billing/webhook';

function identityStub() {
  return getIdentityObject(env.IDENTITY);
}

function eventBody(
  id: string,
  type: string,
  livemode: boolean,
  created: number,
  objectId: string,
): string {
  return JSON.stringify({
    id,
    type,
    livemode,
    created,
    data: { object: { id: objectId } },
  });
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

async function stripeSignatureHeader(
  body: string,
  options: { secret?: string; timestampSec?: number } = {},
): Promise<Record<string, string>> {
  const secret = options.secret ?? env.STRIPE_WEBHOOK_SECRET;
  const timestamp = options.timestampSec ?? Math.floor(Date.now() / 1000);
  const v1 = await hmacSha256Hex(secret, `${timestamp}.${body}`);
  return { 'stripe-signature': `t=${timestamp},v1=${v1}` };
}

async function postWebhook(
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  return SELF.fetch(`${TEACHER_BASE}${WEBHOOK_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

async function eventRow(eventId: string): Promise<unknown> {
  return runInDurableObject(identityStub(), (instance) =>
    instance.db
      .prepare('SELECT outcome, outcome_detail, event_created FROM billing_events WHERE event_id = ?')
      .get(eventId),
  );
}

describe('Worker POST /api/billing/webhook boundary', () => {
  it('returns 405 for a non-POST webhook and does not route suffix variants', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await SELF.fetch(`${TEACHER_BASE}${WEBHOOK_PATH}`, { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow'), method).toBe('POST');
    }

    const trailing = await SELF.fetch(`${TEACHER_BASE}${WEBHOOK_PATH}/`, { method: 'POST' });
    expect(trailing.status).toBe(404);

    const nested = await SELF.fetch(`${TEACHER_BASE}${WEBHOOK_PATH}/extra`, { method: 'POST' });
    expect(nested.status).toBe(404);
  });

  it('does not route the webhook on the guest or marketing host', async () => {
    const body = eventBody('evt_host_boundary', 'invoice.paid', true, 1, 'in_host_boundary');
    for (const base of [GUEST_BASE, MARKETING_BASE]) {
      const response = await SELF.fetch(`${base}${WEBHOOK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(response.status, base).toBe(404);
    }

    expect(await eventRow('evt_host_boundary')).toBeUndefined();
  });

  it('rejects a body above the 1 MiB webhook cap with 413 and writes no event row', async () => {
    const body = JSON.stringify({
      id: 'evt_oversized',
      type: 'invoice.paid',
      livemode: true,
      created: 1,
      data: {
        object: {
          id: 'in_oversized',
          padding: 'x'.repeat(1_048_576),
        },
      },
    });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(1_048_576);

    const response = await postWebhook(body, {});
    expect(response.status).toBe(413);

    expect(await eventRow('evt_oversized')).toBeUndefined();
  });

  it('rejects a missing or invalid signature with 400 and writes no event row', async () => {
    const body = eventBody(
      'evt_bad_signature',
      'customer.subscription.updated',
      true,
      1,
      'sub_bad_signature',
    );

    const missing = await postWebhook(body, {});
    expect(missing.status).toBe(400);

    const wrongSecret = await postWebhook(
      body,
      await stripeSignatureHeader(body, { secret: 'whsec_wrong' }),
    );
    expect(wrongSecret.status).toBe(400);

    const expired = await postWebhook(
      body,
      await stripeSignatureHeader(body, {
        timestampSec: Math.floor(Date.now() / 1000) - 400,
      }),
    );
    expect(expired.status).toBe(400);

    expect(await eventRow('evt_bad_signature')).toBeUndefined();
  });

  it('rejects malformed JSON after a valid signature with 400', async () => {
    const body = '{not-json';
    const response = await postWebhook(body, await stripeSignatureHeader(body));
    expect(response.status).toBe(400);
  });

  it('short-circuits a duplicate event id to its stored outcome without a Stripe fetch', async () => {
    const eventId = 'evt_duplicate_short_circuit';
    const seeded = await identityStub().fetch('https://identity/billing/events/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: { id: eventId, type: 'invoice.paid', livemode: true, created: 1 },
      }),
    });
    expect(seeded.status).toBe(200);
    expect(await seeded.json()).toEqual({ outcome: 'applied' });

    const body = eventBody(eventId, 'invoice.paid', true, 1, 'in_duplicate_short_circuit');
    const response = await postWebhook(body, await stripeSignatureHeader(body));
    expect(response.status).toBe(200);
    const stored = (await response.json()) as { outcome: string; eventCreated: number };
    expect(stored.outcome).toBe('applied');
    expect(stored.eventCreated).toBe(1);

    const rowCount = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare('SELECT COUNT(*) AS n FROM billing_events WHERE event_id = ?')
        .get(eventId),
    );
    expect(rowCount).toEqual({ n: 1 });
  });

  it('forwards a livemode-mismatch event for recording without fetching Stripe', async () => {
    const body = eventBody(
      'evt_test_livemode',
      'customer.subscription.updated',
      false,
      1,
      'sub_test_livemode',
    );
    const response = await postWebhook(body, await stripeSignatureHeader(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: 'ignored',
      outcomeDetail: 'livemode_mismatch',
    });

    const row = (await eventRow('evt_test_livemode')) as
      | { outcome: string; outcome_detail: string; event_created: number }
      | undefined;
    expect(row?.outcome).toBe('ignored');
    expect(row?.outcome_detail).toBe('livemode_mismatch');
    expect(row?.event_created).toBe(1000);
  });

  it('records an unknown event type as ignored without fetching Stripe', async () => {
    const body = eventBody('evt_unknown_type', 'charge.created', true, 2, 'ch_unknown_type');
    const response = await postWebhook(body, await stripeSignatureHeader(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: 'ignored',
      outcomeDetail: 'unknown_type',
    });

    const row = (await eventRow('evt_unknown_type')) as
      | { outcome: string; outcome_detail: string; event_created: number }
      | undefined;
    expect(row?.outcome).toBe('ignored');
    expect(row?.outcome_detail).toBe('unknown_type');
    expect(row?.event_created).toBe(2000);
  });

  it('returns 500 and writes no event row when the authoritative Stripe fetch fails', async () => {
    const body = eventBody(
      'evt_fetch_failure',
      'customer.subscription.updated',
      true,
      3,
      'sub_fetch_failure',
    );
    const response = await postWebhook(body, await stripeSignatureHeader(body));
    expect(response.status).toBe(500);
    expect(await eventRow('evt_fetch_failure')).toBeUndefined();
  });
});

function takeBillingRateSlot(cookie: string): Promise<Response> {
  return identityStub().fetch('https://identity/billing/rate-limit', {
    method: 'POST',
    headers: { cookie },
  });
}

describe('IdentityDO billing rate limit (spec §6.3)', () => {
  it('refuses a rate-limit take without a session', async () => {
    const response = await identityStub().fetch('https://identity/billing/rate-limit', {
      method: 'POST',
    });
    expect(response.status).toBe(401);
  });

  it('counts 10 slots per account in the DO and refuses the 11th', async () => {
    const session = await bootstrapLocalSession('billing-rate-limit-counter');
    for (let index = 0; index < BILLING_OPERATION_RATE_MAX; index += 1) {
      const response = await takeBillingRateSlot(session.cookie);
      expect(response.status, `take ${index}`).toBe(200);
      const body = await response.json() as { allowed: boolean; retryAfterMs: number };
      expect(body.allowed, `take ${index}`).toBe(true);
      expect(body.retryAfterMs, `take ${index}`).toBeGreaterThan(0);
    }

    const denied = await takeBillingRateSlot(session.cookie);
    expect(denied.status).toBe(200);
    const deniedBody = await denied.json() as { allowed: boolean; retryAfterMs: number };
    expect(deniedBody.allowed).toBe(false);
    expect(deniedBody.retryAfterMs).toBeGreaterThan(0);

    const row = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare('SELECT subject_id, count FROM billing_rate_counters WHERE subject_id = ?')
        .get(session.accountId),
    );
    expect(row).toEqual({
      subject_id: session.accountId,
      count: BILLING_OPERATION_RATE_MAX,
    });
  });
});

describe('IdentityDO billing customer lookup (spec §6.1)', () => {
  it('rejects a customer lookup without a session', async () => {
    const response = await identityStub().fetch('https://identity/billing/customer');
    expect(response.status).toBe(401);
  });

  it('answers the caller customer from the session entitlement and null when none exists', async () => {
    const withCustomer = await bootstrapLocalSession('billing-customer-seeded');
    const withoutCustomer = await bootstrapLocalSession('billing-customer-empty');

    await runInDurableObject(identityStub(), (instance) => {
      writeEntitlement(
        instance.db,
        {
          accountId: withCustomer.accountId,
          source: 'personal',
          state: {
            planId: 'tutor_pro_monthly',
            status: 'active',
            graceUntil: null,
            collectionPaused: false,
            companyId: null,
            currentPeriodEnd: null,
            processorCustomerId: 'cus_do_customer',
            processorSubscriptionId: 'sub_do_customer',
          },
          now: Date.now(),
        },
        {
          kind: 'operator',
          id: 'seed-do-customer',
          actor: 'test-operator',
          reason: 'seed paid state',
        },
      );
    });

    const found = await identityStub().fetch('https://identity/billing/customer', {
      headers: { cookie: withCustomer.cookie },
    });
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ processorCustomerId: 'cus_do_customer' });

    const empty = await identityStub().fetch('https://identity/billing/customer', {
      headers: { cookie: withoutCustomer.cookie },
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ processorCustomerId: null });
  });
});

const CHECKOUT_PATH = '/api/billing/checkout';
const PORTAL_PATH = '/api/billing/portal';

function postCheckout(
  session: Awaited<ReturnType<typeof bootstrapLocalSession>>,
  body: unknown,
): Promise<Response> {
  return authenticatedFetch(CHECKOUT_PATH, session, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function billingOperationRow(
  accountId: string,
  operationId: string,
): Promise<unknown> {
  return runInDurableObject(identityStub(), (instance) =>
    instance.db
      .prepare(
        `SELECT kind, status FROM billing_operations
         WHERE subject_kind = 'account' AND subject_id = ? AND operation_id = ?`,
      )
      .get(accountId, operationId),
  );
}

describe('Worker POST /api/billing/checkout', () => {
  it('routes checkout only as POST on the teacher host', async () => {
    for (const base of [GUEST_BASE, MARKETING_BASE]) {
      const response = await SELF.fetch(`${base}${CHECKOUT_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planId: 'tutor_pro_monthly', operationId: 'op_host' }),
      });
      expect(response.status, base).toBe(404);
    }

    const wrongMethod = await SELF.fetch(`${TEACHER_BASE}${CHECKOUT_PATH}`);
    expect(wrongMethod.status).toBe(404);

    const suffix = await SELF.fetch(`${TEACHER_BASE}${CHECKOUT_PATH}/extra`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'tutor_pro_monthly', operationId: 'op_suffix' }),
    });
    expect(suffix.status).toBe(404);
  });

  it('requires a session and an exact same-origin Origin', async () => {
    const token = await localAccessToken('billing-checkout-no-session');
    const noSession = await SELF.fetch(`${TEACHER_BASE}${CHECKOUT_PATH}`, {
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        Origin: TEACHER_BASE,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ planId: 'tutor_pro_monthly', operationId: 'op_no_session' }),
    });
    expect(noSession.status).toBe(401);

    const session = await bootstrapLocalSession('billing-checkout-no-origin');
    const noOrigin = await SELF.fetch(`${TEACHER_BASE}${CHECKOUT_PATH}`, {
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': session.token,
        Cookie: session.cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ planId: 'tutor_pro_monthly', operationId: 'op_no_origin' }),
    });
    expect(noOrigin.status).toBe(403);
    expect(await noOrigin.json()).toEqual({ error: 'Origin required' });
  });

  it('rejects a checkout body that is not a bounded personal paid plan request', async () => {
    const invalidBodies: unknown[] = [
      { planId: 'free', operationId: 'op_free' },
      { planId: 'corporate_seat', operationId: 'op_corporate' },
      { planId: 'not_a_plan', operationId: 'op_unknown' },
      { planId: 'tutor_pro_monthly' },
      { planId: 'tutor_pro_monthly', operationId: '' },
      { planId: 'tutor_pro_monthly', operationId: 'has space' },
      { planId: 'tutor_pro_monthly', operationId: 'a'.repeat(129) },
      { planId: 'tutor_pro_monthly', operationId: 'op_code', referralCode: 'short' },
      { planId: 'tutor_pro_monthly', operationId: 'op_code', referralCode: 'bad code!' },
    ];
    for (const [index, body] of invalidBodies.entries()) {
      const session = await bootstrapLocalSession(`billing-checkout-invalid-${index}`);
      const response = await postCheckout(session, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }

    const contentSession = await bootstrapLocalSession('billing-checkout-invalid-content-type');
    const wrongType = await authenticatedFetch(CHECKOUT_PATH, contentSession, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'planId=tutor_pro_monthly',
    });
    expect(wrongType.status).toBe(415);

    const jsonSession = await bootstrapLocalSession('billing-checkout-invalid-json');
    const invalidJson = await authenticatedFetch(CHECKOUT_PATH, jsonSession, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    expect(invalidJson.status).toBe(400);
  });

  it('answers 503 and records no operation when the server price is missing', async () => {
    const session = await bootstrapLocalSession('billing-checkout-missing-price');
    const response = await postCheckout(session, {
      planId: 'tutor_pro_annual',
      operationId: 'op_missing_price',
      priceId: 'price_client_evil',
      amount: 999,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Billing unavailable' });
    expect(await billingOperationRow(session.accountId, 'op_missing_price')).toBeUndefined();
  });

  it('checkout resolves the price server-side: a client priceId and amount are ignored (P-1)', async () => {
    const session = await bootstrapLocalSession('billing-checkout-server-price');
    const response = await postCheckout(session, {
      planId: 'tutor_pro_monthly',
      operationId: 'op_server_price',
      priceId: 'price_client_evil',
      amount: 999,
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Stripe request failed' });
    expect(await billingOperationRow(session.accountId, 'op_server_price')).toEqual({
      kind: 'checkout',
      status: 'pending',
    });
  });

  it('ignores a client successUrl or cancelUrl: the hostile URL changes nothing (SEC-A27)', async () => {
    const control = await bootstrapLocalSession('billing-checkout-control-url');
    const hostile = await bootstrapLocalSession('billing-checkout-hostile-url');
    const baseline = await postCheckout(control, {
      planId: 'tutor_pro_monthly',
      operationId: 'op_control_url',
    });
    expect(baseline.status).toBe(502);

    const response = await authenticatedFetch(
      `${CHECKOUT_PATH}?successUrl=${encodeURIComponent('https://attacker.example/steal')}`,
      hostile,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          planId: 'tutor_pro_monthly',
          operationId: 'op_hostile_url',
          successUrl: 'https://attacker.example/steal',
          cancelUrl: 'https://attacker.example/steal',
        }),
      },
    );
    expect(response.status).toBe(502);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).not.toContain('attacker.example');

    const changed = await postCheckout(hostile, {
      planId: 'tutor_pro_monthly',
      operationId: 'op_hostile_url',
      successUrl: 'https://attacker.example/other',
      cancelUrl: 'https://attacker.example/other',
    });
    expect(changed.status).toBe(502);
    expect(await billingOperationRow(hostile.accountId, 'op_hostile_url')).toEqual({
      kind: 'checkout',
      status: 'pending',
    });
  });

  it('records one operation per operationId and conflicts on a changed request', async () => {
    const session = await bootstrapLocalSession('billing-checkout-operation');
    const body = {
      planId: 'tutor_pro_monthly',
      operationId: 'op_checkout_replay',
      referralCode: 'PARTNER7',
    };
    expect((await postCheckout(session, body)).status).toBe(502);
    expect((await postCheckout(session, body)).status).toBe(502);
    expect(await billingOperationRow(session.accountId, body.operationId)).toEqual({
      kind: 'checkout',
      status: 'pending',
    });

    const conflict = await postCheckout(session, {
      ...body,
      referralCode: 'OTHER001',
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'Conflict' });
  });

  it('rate-limits checkout per account with 429 and Retry-After after 10 requests', async () => {
    const session = await bootstrapLocalSession('billing-checkout-rate-limit');
    for (let index = 0; index < BILLING_OPERATION_RATE_MAX; index += 1) {
      const response = await postCheckout(session, {
        planId: 'tutor_pro_monthly',
        operationId: `op_rate_${index}`,
      });
      expect(response.status, `checkout ${index}`).toBe(502);
    }

    const limited = await postCheckout(session, {
      planId: 'tutor_pro_monthly',
      operationId: 'op_rate_over',
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    const retryAfter = limited.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ error: 'Too many requests' });

    const portalLimited = await postPortal(session, { operationId: 'op_rate_portal' });
    expect(portalLimited.status).toBe(429);
    expect(portalLimited.headers.get('retry-after')).not.toBeNull();
  }, 20_000);
});

function postPortal(
  session: Awaited<ReturnType<typeof bootstrapLocalSession>>,
  body: unknown,
): Promise<Response> {
  return authenticatedFetch(PORTAL_PATH, session, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function seedCustomer(accountId: string, processorCustomerId: string): Promise<void> {
  return runInDurableObject(identityStub(), (instance) => {
    writeEntitlement(
      instance.db,
      {
        accountId,
        source: 'personal',
        state: {
          planId: 'tutor_pro_monthly',
          status: 'active',
          graceUntil: null,
          collectionPaused: false,
          companyId: null,
          currentPeriodEnd: null,
          processorCustomerId,
          processorSubscriptionId: 'sub_worker_seeded',
        },
        now: Date.now(),
      },
      {
        kind: 'operator',
        id: `seed-customer-${accountId}`,
        actor: 'test-operator',
        reason: 'seed paid state',
      },
    );
  });
}

describe('Worker POST /api/billing/portal', () => {
  it('routes portal only as POST on the teacher host and requires a session', async () => {
    for (const base of [GUEST_BASE, MARKETING_BASE]) {
      const response = await SELF.fetch(`${base}${PORTAL_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: 'op_portal_host' }),
      });
      expect(response.status, base).toBe(404);
    }

    const wrongMethod = await SELF.fetch(`${TEACHER_BASE}${PORTAL_PATH}`);
    expect(wrongMethod.status).toBe(404);

    const token = await localAccessToken('billing-portal-no-session');
    const noSession = await SELF.fetch(`${TEACHER_BASE}${PORTAL_PATH}`, {
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        Origin: TEACHER_BASE,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ operationId: 'op_portal_no_session' }),
    });
    expect(noSession.status).toBe(401);
  });

  it('answers 409 without a customer and never trusts a client processorCustomerId', async () => {
    const session = await bootstrapLocalSession('billing-portal-no-customer');
    const response = await postPortal(session, {
      operationId: 'op_portal_no_customer',
      processorCustomerId: 'cus_client_supplied',
      returnUrl: 'https://attacker.example/steal',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'No subscription' });
    expect(await billingOperationRow(session.accountId, 'op_portal_no_customer')).toBeUndefined();
  });

  it('portal uses the caller entitlement customer and ignores a client returnUrl (SEC-A27)', async () => {
    const session = await bootstrapLocalSession('billing-portal-seeded-customer');
    await seedCustomer(session.accountId, 'cus_worker_seeded');

    const response = await postPortal(session, {
      operationId: 'op_portal_seeded',
      processorCustomerId: 'cus_client_supplied',
      returnUrl: 'https://attacker.example/steal',
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Stripe request failed' });
    expect(await billingOperationRow(session.accountId, 'op_portal_seeded')).toEqual({
      kind: 'portal',
      status: 'pending',
    });

    const changed = await postPortal(session, {
      operationId: 'op_portal_seeded',
      processorCustomerId: 'cus_client_supplied',
      returnUrl: 'https://attacker.example/other',
    });
    expect(changed.status).toBe(502);
  });
});
