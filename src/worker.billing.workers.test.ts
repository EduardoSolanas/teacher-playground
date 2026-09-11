import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import { getIdentityObject, type IdentityDO } from './do/IdentityDO';

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY: DurableObjectNamespace<IdentityDO>;
      STRIPE_API_BASE: string;
      STRIPE_SECRET_KEY: string;
      STRIPE_WEBHOOK_SECRET: string;
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
