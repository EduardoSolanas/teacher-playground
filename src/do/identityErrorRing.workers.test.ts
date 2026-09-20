import { afterEach, describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { getIdentityObject, type IdentityDO } from './IdentityDO';

/*
 * The bounded identity error ring (OPS-01): billing-path failures IdentityDO
 * logs to the console are kept in its own SQLite so /admin can surface them.
 */

function identityStub() {
  return getIdentityObject(env.IDENTITY) as DurableObjectStub<IdentityDO>;
}

const ADMIN_EMAIL = 'admin@example.test';

afterEach(async () => {
  await runInDurableObject(identityStub(), (instance) => {
    instance.db.prepare(`DELETE FROM identity_error_ring`).run();
  });
});

describe('IdentityDO /errors/ring', () => {
  it('refuses a non-admin email and an invalid body', async () => {
    const denied = await identityStub().fetch('https://identity/errors/ring', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminEmail: 'outsider@example.test' }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'Forbidden' });

    const malformed = await identityStub().fetch('https://identity/errors/ring', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminEmail: ADMIN_EMAIL, extra: true }),
    });
    expect(malformed.status).toBe(400);
  });

  it('refuses methods other than POST', async () => {
    const gotten = await identityStub().fetch('https://identity/errors/ring');
    expect(gotten.status).toBe(405);
  });

  it('answers POST with the ring newest first for an allowlisted admin', async () => {
    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(`INSERT INTO identity_error_ring (at, scope, message) VALUES (?, ?, ?)`)
        .run(1000, 'billing:apply', 'older failure');
      instance.db
        .prepare(`INSERT INTO identity_error_ring (at, scope, message) VALUES (?, ?, ?)`)
        .run(2000, 'billing:reconcile', 'newer failure');
    });

    const response = await identityStub().fetch('https://identity/errors/ring', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminEmail: ADMIN_EMAIL }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      errors: [
        { at: 2000, scope: 'billing:reconcile', message: 'newer failure' },
        { at: 1000, scope: 'billing:apply', message: 'older failure' },
      ],
    });
  });

  it('records a real billing apply failure into the ring', async () => {
    // Seed an entitlement whose subscription row will make the fetched
    // subscription status unrepresentable, so applyEvent throws and the
    // [billing:apply] console.error path runs for real.
    const resolved = await identityStub().fetch('https://identity/subjects/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issuer: 'https://access.example.com', subject: 'ring-billing' }),
    });
    expect(resolved.status).toBe(201);
    const { account } = (await resolved.json()) as { account: { accountId: string } };

    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(
          `INSERT INTO billing_subscriptions (
             processor_subscription_id, subject_kind, subject_id, updated_at
           ) VALUES (?, 'account', ?, ?)`,
        )
        .run('sub_ring_rollback', account.accountId, Date.now());
    });

    const applied = await identityStub().fetch('https://identity/billing/events/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        signatureVerified: true,
        payloadHash: '7d'.repeat(32),
        event: {
          id: 'evt_ring_rollback',
          type: 'customer.subscription.updated',
          livemode: true,
          created: 600,
        },
        objects: {
          subscription: {
            id: 'sub_ring_rollback',
            customer: 'cus_ring',
            status: 'unpaid',
            canceledAt: null,
            currentPeriodEnd: 100,
            pauseCollection: null,
            metadata: {},
            items: {
              data: [
                {
                  id: 'si_sub_ring_rollback',
                  price: { id: 'price_sub_ring_rollback' },
                  quantity: 1,
                },
              ],
            },
          },
        },
      }),
    });
    expect(applied.status).toBe(500);

    const response = await identityStub().fetch('https://identity/errors/ring', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminEmail: ADMIN_EMAIL }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      errors: { at: number; scope: string; message: string }[];
    };
    const applyError = body.errors.find((row) => row.scope === 'billing:apply');
    expect(applyError).toBeDefined();
    expect(applyError!.message.length).toBeGreaterThan(0);
    expect(typeof applyError!.at).toBe('number');
  });
});
