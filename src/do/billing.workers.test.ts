import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { getIdentityObject, type IdentityDO } from './IdentityDO';
import { writeEntitlement } from '../lib/identity/entitlementWriter';
import { ensureReferralCode } from '../lib/referrals/codes';
import {
  confirmReferralRedemption,
  recordReferralRedemption,
} from '../lib/referrals/ledger';
import { PAST_DUE_GRACE_MS } from '../lib/plan/catalog';
import type { PlanId } from '../lib/plan/catalog';

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY: DurableObjectNamespace<IdentityDO>;
      TUTOR_ACCOUNT_CAP: string;
    }
  }
}

const ACCESS_ISSUER = 'https://access.example.com';

function identityStub() {
  return getIdentityObject(env.IDENTITY);
}

async function newAccount(label: string): Promise<string> {
  const response = await identityStub().fetch('https://identity/subjects/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ issuer: ACCESS_ISSUER, subject: label }),
  });
  expect(response.status).toBe(201);
  const { account } = (await response.json()) as { account: { accountId: string } };
  return account.accountId;
}

function seedEntitlement(
  instance: IdentityDO,
  accountId: string,
  state: {
    planId: PlanId;
    status: 'free' | 'trialing' | 'active' | 'past_due' | 'canceled';
    graceUntil?: number | null;
    collectionPaused?: boolean;
    currentPeriodEnd?: number | null;
    processorCustomerId?: string | null;
    processorSubscriptionId?: string | null;
  },
  causeId = 'seed-operator',
): void {
  writeEntitlement(
    instance.db,
    {
      accountId,
      source: 'personal',
      state: {
        planId: state.planId,
        status: state.status,
        graceUntil: state.graceUntil ?? null,
        collectionPaused: state.collectionPaused ?? false,
        companyId: null,
        currentPeriodEnd: state.currentPeriodEnd ?? null,
        processorCustomerId: state.processorCustomerId ?? null,
        processorSubscriptionId: state.processorSubscriptionId ?? null,
      },
      now: Date.now(),
    },
    { kind: 'operator', id: causeId, actor: 'test-operator', reason: 'seed paid state' },
  );
}

interface EntitlementDbRow {
  status: string;
  grace_until: number | null;
  collection_paused: number;
  current_period_end: number | null;
  processor_customer_id: string | null;
  processor_subscription_id: string | null;
}

function readEntitlement(
  instance: IdentityDO,
  accountId: string,
): EntitlementDbRow | undefined {
  return instance.db
    .prepare(
      `SELECT status, grace_until, collection_paused, current_period_end,
              processor_customer_id, processor_subscription_id
       FROM entitlements WHERE account_id = ? AND source = 'personal'`,
    )
    .get(accountId) as EntitlementDbRow | undefined;
}

interface SubOrderingRow {
  last_state_event_created: number;
  processor_canceled_at: number | null;
  desired_collection: string;
  desired_version: number;
  applied_version: number;
  in_flight_version: number | null;
  in_flight_state: string | null;
  in_flight_since: number | null;
  subject_kind: string;
  subject_id: string;
}

function readSubOrdering(instance: IdentityDO, subId: string): SubOrderingRow | undefined {
  return instance.db
    .prepare(
      `SELECT last_state_event_created, processor_canceled_at, desired_collection,
              desired_version, applied_version, in_flight_version, in_flight_state,
              in_flight_since, subject_kind, subject_id
       FROM billing_subscriptions WHERE processor_subscription_id = ?`,
    )
    .get(subId) as SubOrderingRow | undefined;
}

interface EventRow {
  outcome: string;
  outcome_detail: string | null;
  event_created: number;
}

function readEvent(instance: IdentityDO, eventId: string): EventRow | undefined {
  return instance.db
    .prepare(
      `SELECT outcome, outcome_detail, event_created FROM billing_events WHERE event_id = ?`,
    )
    .get(eventId) as EventRow | undefined;
}

function readPayloadHash(instance: IdentityDO, eventId: string): string | undefined {
  const row = instance.db
    .prepare('SELECT payload_hash FROM billing_events WHERE event_id = ?')
    .get(eventId) as { payload_hash: string } | undefined;
  return row?.payload_hash;
}

const FORWARDED_PAYLOAD_HASH = '7d'.repeat(32);

function postApply(raw: string): Promise<Response> {
  return identityStub().fetch('https://identity/billing/events/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
}

function statusQuery(eventId: string): Promise<Response> {
  return identityStub().fetch(
    `https://identity/billing/events/status?id=${encodeURIComponent(eventId)}`,
  );
}

function postOperations(raw: string): Promise<Response> {
  return identityStub().fetch('https://identity/billing/operations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
}

function postSettle(raw: string): Promise<Response> {
  return identityStub().fetch('https://identity/billing/operations/settle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
}

/** Builds a `/billing/events/apply` body with fixed serialization order. */
function applyBody(
  event: { id: string; type: string; livemode?: boolean; created: number },
  objects: Record<string, unknown>,
  payloadHash = FORWARDED_PAYLOAD_HASH,
): string {
  return JSON.stringify({
    signatureVerified: true,
    payloadHash,
    event: {
      id: event.id,
      type: event.type,
      livemode: event.livemode ?? true,
      created: event.created,
    },
    objects,
  });
}

function subscriptionBody(
  id: string,
  status: string,
  opts: Partial<{
    customer: string | null;
    canceledAt: number | null;
    currentPeriodEnd: number | null;
    pauseCollection: { behavior: string } | null;
  }> = {},
): Record<string, unknown> {
  return {
    id,
    customer: opts.customer ?? null,
    status,
    canceledAt: opts.canceledAt ?? null,
    currentPeriodEnd: opts.currentPeriodEnd ?? null,
    pauseCollection: opts.pauseCollection ?? null,
    metadata: {},
    items: { data: [{ id: `si_${id}`, price: { id: `price_${id}` }, quantity: 1 }] },
  };
}

function invoiceBody(
  id: string,
  opts: Partial<{
    customer: string | null;
    status: string;
    amountPaid: number;
    currency: string;
    paymentIntent: string | null;
    subscription: string | null;
    payments: Array<{ id: string; amount: number }>;
  }> = {},
): Record<string, unknown> {
  return {
    id,
    customer: opts.customer ?? null,
    status: opts.status ?? 'paid',
    amountPaid: opts.amountPaid ?? 0,
    currency: opts.currency ?? 'gbp',
    paymentIntent: opts.paymentIntent ?? null,
    subscription: opts.subscription ?? null,
    payments: opts.payments ?? [],
  };
}

describe('identity /billing/events/apply: verified-caller attestation', () => {
  it('rejects an apply without signatureVerified: true and writes nothing', async () => {
    const missingMarker = JSON.stringify({
      event: { id: 'evt_missing_marker', type: 'customer.subscription.updated', livemode: true, created: 100 },
      objects: { subscription: subscriptionBody('sub_missing_marker', 'active') },
    });
    const missing = await postApply(missingMarker);
    expect(missing.status).toBe(400);

    const falseMarker = JSON.stringify({
      signatureVerified: false,
      payloadHash: FORWARDED_PAYLOAD_HASH,
      event: { id: 'evt_false_marker', type: 'customer.subscription.updated', livemode: true, created: 100 },
      objects: { subscription: subscriptionBody('sub_false_marker', 'active') },
    });
    const forged = await postApply(falseMarker);
    expect(forged.status).toBe(400);

    await runInDurableObject(identityStub(), (instance) => {
      expect(readEvent(instance, 'evt_missing_marker')).toBeUndefined();
      expect(readEvent(instance, 'evt_false_marker')).toBeUndefined();
    });
  });

  it('rejects an apply with a missing or malformed payloadHash and writes nothing', async () => {
    const missingHash = JSON.stringify({
      signatureVerified: true,
      event: { id: 'evt_missing_hash', type: 'customer.subscription.updated', livemode: true, created: 100 },
      objects: { subscription: subscriptionBody('sub_missing_hash', 'active') },
    });
    const missing = await postApply(missingHash);
    expect(missing.status).toBe(400);

    const malformed = await postApply(
      applyBody(
        { id: 'evt_malformed_hash', type: 'customer.subscription.updated', created: 100 },
        { subscription: subscriptionBody('sub_malformed_hash', 'active') },
        'not-a-sha256',
      ),
    );
    expect(malformed.status).toBe(400);

    await runInDurableObject(identityStub(), (instance) => {
      expect(readEvent(instance, 'evt_missing_hash')).toBeUndefined();
      expect(readEvent(instance, 'evt_malformed_hash')).toBeUndefined();
    });
  });

  it('stores the forwarded payload hash verbatim (known SHA-256 vector)', async () => {
    const vector = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const response = await postApply(
      applyBody(
        { id: 'evt_hash_vector', type: 'customer.subscription.updated', created: 100 },
        { subscription: subscriptionBody('sub_hash_vector', 'active') },
        vector,
      ),
    );
    expect(response.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      expect(readPayloadHash(instance, 'evt_hash_vector')).toBe(vector);
    });
  });
});

describe('identity /billing/events/apply: event idempotency', () => {
  it('dedupes a repeated event id: one billing_events row, one effect, one payment', async () => {
    const accountId = await newAccount('billing-dedupe');
    const sub1 = 'sub_dedupe';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        currentPeriodEnd: 1000,
        processorCustomerId: 'cus_dedupe',
        processorSubscriptionId: sub1,
      });
    });

    const raw = applyBody(
      { id: 'evt_dedupe_1', type: 'invoice.paid', created: 1750000000000 },
      {
        subscription: subscriptionBody(sub1, 'active', { customer: 'cus_dedupe', currentPeriodEnd: 2000 }),
        invoice: invoiceBody('in_dedupe', {
          customer: 'cus_dedupe',
          amountPaid: 1500,
          paymentIntent: 'pi_dedupe',
          subscription: sub1,
          payments: [{ id: 'ch_dedupe', amount: 1500 }],
        }),
      },
    );

    const first = await postApply(raw);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ outcome: 'applied' });

    const replay = await postApply(raw);
    expect(replay.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      expect(readEvent(instance, 'evt_dedupe_1')?.outcome).toBe('applied');
      const eventCount = (
        instance.db
          .prepare('SELECT COUNT(*) AS n FROM billing_events WHERE event_id = ?')
          .get('evt_dedupe_1') as { n: number }
      ).n;
      expect(eventCount).toBe(1);
      const effectCount = (
        instance.db
          .prepare(
            `SELECT COUNT(*) AS n FROM billing_effects
             WHERE effect_kind = 'invoice_paid' AND object_id = ?`,
          )
          .get('in_dedupe') as { n: number }
      ).n;
      expect(effectCount).toBe(1);
      const paymentCount = (
        instance.db
          .prepare('SELECT COUNT(*) AS n FROM billing_payments WHERE payment_intent_id = ?')
          .get('pi_dedupe') as { n: number }
      ).n;
      expect(paymentCount).toBe(1);
    });
  });

  it('applies an in-scope invoice effect once across two different event ids', async () => {
    const accountId = await newAccount('billing-dedupe-effect');
    const sub2 = 'sub_dedupe_effect';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        processorCustomerId: 'cus_dedupe_effect',
        processorSubscriptionId: sub2,
      });
    });

    await postApply(
      applyBody(
        { id: 'evt_dedupe_a', type: 'invoice.paid', created: 100 },
        {
          subscription: subscriptionBody(sub2, 'active', { customer: 'cus_dedupe_effect', currentPeriodEnd: 200 }),
          invoice: invoiceBody('in_dedupe_effect', {
            customer: 'cus_dedupe_effect',
            amountPaid: 999,
            paymentIntent: 'pi_dedupe_effect',
            subscription: sub2,
          }),
        },
      ),
    );
    const second = await postApply(
      applyBody(
        { id: 'evt_dedupe_b', type: 'invoice.paid', created: 200 },
        {
          subscription: subscriptionBody(sub2, 'active', { customer: 'cus_dedupe_effect', currentPeriodEnd: 300 }),
          invoice: invoiceBody('in_dedupe_effect', {
            customer: 'cus_dedupe_effect',
            amountPaid: 999,
            paymentIntent: 'pi_dedupe_effect',
            subscription: sub2,
          }),
        },
      ),
    );
    expect(second.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      const effectCount = (
        instance.db
          .prepare(
            `SELECT COUNT(*) AS n FROM billing_effects
             WHERE effect_kind = 'invoice_paid' AND object_id = ?`,
          )
          .get('in_dedupe_effect') as { n: number }
      ).n;
      expect(effectCount).toBe(1);
      const paymentCount = (
        instance.db
          .prepare('SELECT COUNT(*) AS n FROM billing_payments WHERE payment_intent_id = ?')
          .get('pi_dedupe_effect') as { n: number }
      ).n;
      expect(paymentCount).toBe(1);
    });
  });

  it('records livemode mismatch as ignored and stays a dedupe key', async () => {
    const raw = applyBody(
      { id: 'evt_livenode_1', type: 'customer.subscription.updated', livemode: false, created: 100 },
      { subscription: subscriptionBody('sub_live', 'active') },
    );
    const response = await postApply(raw);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'ignored', outcomeDetail: 'livemode_mismatch' });
    await postApply(raw);
    await runInDurableObject(identityStub(), (instance) => {
      const n = (
        instance.db
          .prepare('SELECT COUNT(*) AS n FROM billing_events WHERE event_id = ?')
          .get('evt_livenode_1') as { n: number }
      ).n;
      expect(n).toBe(1);
    });
  });

  it('answers the status route for processed events', async () => {
    const raw = applyBody(
      { id: 'evt_status_1', type: 'customer.subscription.updated', created: 100 },
      { subscription: subscriptionBody('sub_status', 'active') },
    );
    await postApply(raw);
    const status = await statusQuery('evt_status_1');
    expect(status.status).toBe(200);
    const body = (await status.json()) as { outcome: string };
    expect(body.outcome).toBe('applied');
  });
});

describe('identity /billing/events/apply: class-1 subscription state', () => {
  it('keeps state from the newer event when an older event arrives after it', async () => {
    const accountId = await newAccount('billing-class1-skip');
    const sub3 = 'sub_class1_skip';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        currentPeriodEnd: 100,
        processorCustomerId: 'cus_class1_skip',
        processorSubscriptionId: sub3,
      });
    });

    await postApply(
      applyBody(
        { id: 'evt_skip_1', type: 'customer.subscription.updated', created: 200 },
        { subscription: subscriptionBody(sub3, 'active', { customer: 'cus_class1_skip', currentPeriodEnd: 400 }) },
      ),
    );
    await postApply(
      applyBody(
        { id: 'evt_skip_2', type: 'customer.subscription.updated', created: 90 },
        { subscription: subscriptionBody(sub3, 'active', { customer: 'cus_class1_skip', currentPeriodEnd: 200 }) },
      ),
    );

    await runInDurableObject(identityStub(), (instance) => {
      const ent = readEntitlement(instance, accountId);
      expect(ent?.current_period_end).toBe(400);
      const ordering = readSubOrdering(instance, sub3);
      expect(ordering?.last_state_event_created).toBe(200);
    });
  });

  it('applies both equal-timestamp events; the last arrival wins', async () => {
    const accountId = await newAccount('billing-class1-tie');
    const sub4 = 'sub_class1_tie';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        currentPeriodEnd: 10,
        processorCustomerId: 'cus_class1_tie',
        processorSubscriptionId: sub4,
      });
    });

    await postApply(
      applyBody(
        { id: 'evt_tie_1', type: 'customer.subscription.updated', created: 100 },
        { subscription: subscriptionBody(sub4, 'active', { customer: 'cus_class1_tie', currentPeriodEnd: 200 }) },
      ),
    );
    await postApply(
      applyBody(
        { id: 'evt_tie_2', type: 'customer.subscription.updated', created: 100 },
        { subscription: subscriptionBody(sub4, 'active', { customer: 'cus_class1_tie', currentPeriodEnd: 300 }) },
      ),
    );

    await runInDurableObject(identityStub(), (instance) => {
      expect(readEntitlement(instance, accountId)?.current_period_end).toBe(300);
      expect(readSubOrdering(instance, sub4)?.last_state_event_created).toBe(100);
    });
  });

  it('absorbing dashboard cancel: a later older active event does not resurrect the row', async () => {
    const accountId = await newAccount('billing-cancel-absorbing');
    const sub5 = 'sub_cancel_absorb';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        currentPeriodEnd: 100,
        processorCustomerId: 'cus_cancel_absorb',
        processorSubscriptionId: sub5,
      });
    });

    await postApply(
      applyBody(
        { id: 'evt_cancel_1', type: 'customer.subscription.deleted', created: 150 },
        { subscription: subscriptionBody(sub5, 'canceled', { customer: 'cus_cancel_absorb', canceledAt: 150, currentPeriodEnd: 150 }) },
      ),
    );
    await postApply(
      applyBody(
        { id: 'evt_cancel_2', type: 'customer.subscription.updated', created: 100 },
        { subscription: subscriptionBody(sub5, 'active', { customer: 'cus_cancel_absorb', currentPeriodEnd: 999 }) },
      ),
    );

    await runInDurableObject(identityStub(), (instance) => {
      const ent = readEntitlement(instance, accountId);
      expect(ent?.status).toBe('canceled');
      expect(ent?.current_period_end).toBe(150);
      const ordering = readSubOrdering(instance, sub5);
      expect(ordering?.processor_canceled_at).toBe(150);
      expect(ordering?.last_state_event_created).toBe(150);
    });
  });

  it('opens the 7-day grace window on the first past_due observation', async () => {
    const accountId = await newAccount('billing-grace-open');
    const sub6 = 'sub_grace_open';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        currentPeriodEnd: 100,
        processorCustomerId: 'cus_grace_open',
        processorSubscriptionId: sub6,
      });
    });

    await postApply(
      applyBody(
        { id: 'evt_grace_open', type: 'customer.subscription.updated', created: 500 },
        { subscription: subscriptionBody(sub6, 'past_due', { customer: 'cus_grace_open', currentPeriodEnd: 100 }) },
      ),
    );

    await runInDurableObject(identityStub(), (instance) => {
      const ent = readEntitlement(instance, accountId);
      expect(ent?.status).toBe('past_due');
      expect(ent?.grace_until).toBe(500 + PAST_DUE_GRACE_MS);
    });
  });

  it('keeps one grace window across repeated past_due observations', async () => {
    const accountId = await newAccount('billing-grace-repeat');
    const sub7 = 'sub_grace_repeat';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'past_due',
        graceUntil: 500 + PAST_DUE_GRACE_MS,
        currentPeriodEnd: 200,
        processorCustomerId: 'cus_grace_repeat',
        processorSubscriptionId: sub7,
      });
    });

    await postApply(
      applyBody(
        { id: 'evt_grace_repeat', type: 'customer.subscription.updated', created: 700 },
        { subscription: subscriptionBody(sub7, 'past_due', { customer: 'cus_grace_repeat', currentPeriodEnd: 200 }) },
      ),
    );

    await runInDurableObject(identityStub(), (instance) => {
      expect(readEvent(instance, 'evt_grace_repeat')?.outcome).toBe('applied');
      const ent = readEntitlement(instance, accountId);
      expect(ent?.status).toBe('past_due');
      expect(ent?.grace_until).toBe(500 + PAST_DUE_GRACE_MS);
    });
  });

  it('clears grace when recovery arrives, then opens a fresh window on a new failure', async () => {
    const accountId = await newAccount('billing-grace-recover');
    const sub8 = 'sub_grace_recover';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'past_due',
        graceUntil: 500 + PAST_DUE_GRACE_MS,
        currentPeriodEnd: 100,
        processorCustomerId: 'cus_grace_recover',
        processorSubscriptionId: sub8,
      });
    });

    await postApply(
      applyBody(
        { id: 'evt_recover_1', type: 'customer.subscription.updated', created: 800 },
        { subscription: subscriptionBody(sub8, 'active', { customer: 'cus_grace_recover', currentPeriodEnd: 900 }) },
      ),
    );
    await postApply(
      applyBody(
        { id: 'evt_recover_2', type: 'customer.subscription.updated', created: 1000 },
        { subscription: subscriptionBody(sub8, 'past_due', { customer: 'cus_grace_recover', currentPeriodEnd: 900 }) },
      ),
    );

    await runInDurableObject(identityStub(), (instance) => {
      const ent = readEntitlement(instance, accountId);
      expect(ent?.status).toBe('past_due');
      expect(ent?.grace_until).toBe(1000 + PAST_DUE_GRACE_MS);
    });
  });

  it('rolls the whole apply back when the fetched status is unrepresentable', async () => {
    const accountId = await newAccount('billing-rollback');
    const sub9 = 'sub_rollback';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        currentPeriodEnd: 100,
        processorCustomerId: 'cus_rollback',
        processorSubscriptionId: sub9,
      });
      instance.db
        .prepare(
          `INSERT INTO billing_subscriptions (
             processor_subscription_id, subject_kind, subject_id, updated_at
           ) VALUES (?, 'account', ?, ?)`,
        )
        .run(sub9, accountId, Date.now());
    });

    const response = await postApply(
      applyBody(
        { id: 'evt_rollback_1', type: 'customer.subscription.updated', created: 600 },
        { subscription: subscriptionBody(sub9, 'unpaid', { customer: 'cus_rollback', currentPeriodEnd: 100 }) },
      ),
    );
    expect(response.status).toBe(500);

    await runInDurableObject(identityStub(), (instance) => {
      expect(readEvent(instance, 'evt_rollback_1')).toBeUndefined();
      const effects = (
        instance.db
          .prepare('SELECT COUNT(*) AS n FROM billing_effects WHERE object_id = ?')
          .get(sub9) as { n: number }
      ).n;
      expect(effects).toBe(0);
      const ent = readEntitlement(instance, accountId);
      expect(ent?.status).toBe('active');
      expect(ent?.current_period_end).toBe(100);
      expect(readSubOrdering(instance, sub9)?.last_state_event_created).toBe(0);
    });
  });
});

describe('identity /billing/events/apply: reversed delivery and class-2 effects', () => {
  it('because watermark gates class-1 only, an older invoice.paid still records its effect', async () => {
    const accountId = await newAccount('billing-reversed');
    const sub10 = 'sub_reversed';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        currentPeriodEnd: 100,
        processorCustomerId: 'cus_reversed',
        processorSubscriptionId: sub10,
      });
    });

    await postApply(
      applyBody(
        { id: 'evt_rev_1', type: 'customer.subscription.updated', created: 200 },
        { subscription: subscriptionBody(sub10, 'active', { customer: 'cus_reversed', currentPeriodEnd: 700 }) },
      ),
    );
    const older = await postApply(
      applyBody(
        { id: 'evt_rev_2', type: 'invoice.paid', created: 100 },
        {
          subscription: subscriptionBody(sub10, 'active', { customer: 'cus_reversed', currentPeriodEnd: 300 }),
          invoice: invoiceBody('in_reversed', {
            customer: 'cus_reversed',
            amountPaid: 1999,
            paymentIntent: 'pi_reversed',
            subscription: sub10,
          }),
        },
      ),
    );
    expect(older.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      const ent = readEntitlement(instance, accountId);
      expect(ent?.current_period_end).toBe(700);
      const payment = (
        instance.db
          .prepare(
            `SELECT amount_cents, subject_kind, subject_id FROM billing_payments WHERE payment_intent_id = ?`,
          )
          .get('pi_reversed') as { amount_cents: number; subject_kind: string; subject_id: string } | undefined
      );
      expect(payment?.amount_cents).toBe(1999);
    });
  });

  it('confirms a pending referral redemption when the invoice is paid with money', async () => {
    const accountId = await newAccount('billing-referral');
    const sub11 = 'sub_referral';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        processorCustomerId: 'cus_referral',
        processorSubscriptionId: sub11,
      });
      instance.db
        .prepare(`INSERT INTO referral_codes (code, owner_account_id, created_at) VALUES (?, ?, ?)`)
        .run('REFERME', accountId, 1);
      instance.db
        .prepare(
          `INSERT INTO referral_events (
             record_id, code, kind, referred_account_id, referred_customer_id,
             object_id, reward_status, occurred_at, recorded_at
           ) VALUES (?, 'REFERME', 'redemption', ?, 'cus_referral', 'in_referral', 'pending', ?, ?)`,
        )
        .run('ref_redemption_pending', accountId, 100, 100);
    });

    await postApply(
      applyBody(
        { id: 'evt_referral_1', type: 'invoice.paid', created: 300 },
        {
          subscription: subscriptionBody(sub11, 'active', { customer: 'cus_referral', currentPeriodEnd: 400 }),
          invoice: invoiceBody('in_referral', {
            customer: 'cus_referral',
            amountPaid: 200,
            paymentIntent: 'pi_referral',
            subscription: sub11,
          }),
        },
      ),
    );

    await runInDurableObject(identityStub(), (instance) => {
      const redemption = instance.db
        .prepare(`SELECT confirmed_at FROM referral_events WHERE record_id = ?`)
        .get('ref_redemption_pending') as { confirmed_at: number | null };
      expect(redemption.confirmed_at).toBe(300);
    });
  });

  it('marks a referral earned only when the paid invoice actually collected money', async () => {
    const zeroAccount = await newAccount('billing-referral-zero');
    const paidAccount = await newAccount('billing-referral-earned-paid');
    const ownerId = await newAccount('billing-referral-earned-owner');
    await runInDurableObject(identityStub(), (instance) => {
      const code = ensureReferralCode(instance.db, { accountId: ownerId, now: 1 }).code;
      recordReferralRedemption(instance.db, {
        code,
        referredAccountId: zeroAccount,
        referredCustomerId: 'cus_referral_zero',
        objectId: 'cs_referral_zero',
        occurredAt: 100,
        recordedAt: 100,
      });
      recordReferralRedemption(instance.db, {
        code,
        referredAccountId: paidAccount,
        referredCustomerId: 'cus_referral_really_paid',
        objectId: 'cs_referral_really_paid',
        occurredAt: 100,
        recordedAt: 100,
      });
    });

    const zero = await postApply(
      applyBody(
        { id: 'evt_referral_zero', type: 'invoice.paid', created: 300 },
        {
          invoice: invoiceBody('in_referral_zero', {
            customer: 'cus_referral_zero',
            amountPaid: 0,
          }),
        },
      ),
    );
    expect(zero.status).toBe(200);

    const paid = await postApply(
      applyBody(
        { id: 'evt_referral_really_paid', type: 'invoice.paid', created: 400 },
        {
          invoice: invoiceBody('in_referral_really_paid', {
            customer: 'cus_referral_really_paid',
            amountPaid: 500,
          }),
        },
      ),
    );
    expect(paid.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      const rows = instance.db
        .prepare(
          `SELECT object_id, reward_status, confirmed_at FROM referral_events
           WHERE kind = 'redemption'
             AND object_id IN ('cs_referral_really_paid', 'cs_referral_zero')
           ORDER BY object_id`,
        )
        .all();
      expect(rows).toEqual([
        { object_id: 'cs_referral_really_paid', reward_status: 'earned', confirmed_at: 400 },
        { object_id: 'cs_referral_zero', reward_status: 'pending', confirmed_at: null },
      ]);
    });
  });

  it('reverses a confirmed referral on refund without changing entitlement', async () => {
    const accountId = await newAccount('billing-refund-referral');
    const ownerId = await newAccount('billing-refund-referral-owner');
    const sub = 'sub_refund_referral';
    const code = await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        currentPeriodEnd: 900,
        processorCustomerId: 'cus_refund_referral',
        processorSubscriptionId: sub,
      });
      const minted = ensureReferralCode(instance.db, { accountId: ownerId, now: 1 }).code;
      recordReferralRedemption(instance.db, {
        code: minted,
        referredAccountId: accountId,
        referredCustomerId: 'cus_refund_referral',
        objectId: 'cs_refund_referral',
        occurredAt: 100,
        recordedAt: 100,
      });
      confirmReferralRedemption(instance.db, {
        referredCustomerId: 'cus_refund_referral',
        amountPaidCents: 1_999,
        occurredAt: 200,
      });
      return minted;
    });

    const response = await postApply(
      applyBody(
        { id: 'evt_refund_referral', type: 'charge.refunded', created: 300 },
        { charge: { id: 'ch_refund_referral', customer: 'cus_refund_referral' } },
      ),
    );
    expect(response.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      const reversal = instance.db
        .prepare(
          `SELECT kind, code, referred_account_id, referred_customer_id, reward_status
           FROM referral_events
           WHERE kind = 'reversal' AND object_id = 'ch_refund_referral'`,
        )
        .get() as Record<string, unknown> | undefined;
      expect(reversal).toMatchObject({
        kind: 'reversal',
        code,
        referred_account_id: accountId,
        referred_customer_id: 'cus_refund_referral',
        reward_status: 'none',
      });

      const redemption = instance.db
        .prepare(
          `SELECT reward_status, confirmed_at FROM referral_events
           WHERE object_id = 'cs_refund_referral'`,
        )
        .get();
      expect(redemption).toEqual({ reward_status: 'voided', confirmed_at: 200 });

      const entitlement = readEntitlement(instance, accountId);
      expect(entitlement?.status).toBe('active');
      expect(entitlement?.current_period_end).toBe(900);
    });
  });

  it('reverses a referral once per refund object across event ids', async () => {
    const accountId = await newAccount('billing-refund-dedupe');
    const ownerId = await newAccount('billing-refund-dedupe-owner');
    const sub = 'sub_refund_dedupe';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        processorCustomerId: 'cus_refund_dedupe',
        processorSubscriptionId: sub,
      });
      const code = ensureReferralCode(instance.db, { accountId: ownerId, now: 1 }).code;
      recordReferralRedemption(instance.db, {
        code,
        referredAccountId: accountId,
        referredCustomerId: 'cus_refund_dedupe',
        objectId: 'cs_refund_dedupe',
        occurredAt: 100,
        recordedAt: 100,
      });
      confirmReferralRedemption(instance.db, {
        referredCustomerId: 'cus_refund_dedupe',
        amountPaidCents: 1_999,
        occurredAt: 200,
      });
    });

    for (const [eventId, created] of [
      ['evt_refund_dedupe_a', 300],
      ['evt_refund_dedupe_b', 301],
    ] as const) {
      const response = await postApply(
        applyBody(
          { id: eventId, type: 'charge.refunded', created },
          { charge: { id: 'ch_refund_dedupe', customer: 'cus_refund_dedupe' } },
        ),
      );
      expect(response.status, eventId).toBe(200);
    }

    await runInDurableObject(identityStub(), (instance) => {
      expect(
        instance.db
          .prepare(
            `SELECT COUNT(*) AS count FROM referral_events
             WHERE kind = 'reversal' AND object_id = 'ch_refund_dedupe'`,
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        instance.db
          .prepare(
            `SELECT COUNT(*) AS count FROM billing_effects
             WHERE effect_kind = 'refund' AND object_id = 'ch_refund_dedupe'`,
          )
          .get(),
      ).toEqual({ count: 1 });
    });
  });

  it('does not re-open grace when payment_failed arrives after the recovering invoice.paid', async () => {
    const accountId = await newAccount('billing-payment-failed-reversed');
    const sub21 = 'sub_payment_failed_reversed';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        currentPeriodEnd: 300,
        processorCustomerId: 'cus_payment_failed_reversed',
        processorSubscriptionId: sub21,
      });
    });

    const paid = await postApply(
      applyBody(
        { id: 'evt_payment_failed_paid', type: 'invoice.paid', created: 400 },
        {
          subscription: subscriptionBody(sub21, 'active', {
            customer: 'cus_payment_failed_reversed',
            currentPeriodEnd: 700,
          }),
          invoice: invoiceBody('in_payment_failed_paid', {
            customer: 'cus_payment_failed_reversed',
            amountPaid: 1500,
            paymentIntent: 'pi_payment_failed_paid',
            subscription: sub21,
          }),
        },
      ),
    );
    expect(paid.status).toBe(200);

    const failed = await postApply(
      applyBody(
        { id: 'evt_payment_failed_failed', type: 'invoice.payment_failed', created: 500 },
        {
          subscription: subscriptionBody(sub21, 'active', {
            customer: 'cus_payment_failed_reversed',
            currentPeriodEnd: 700,
          }),
          invoice: invoiceBody('in_payment_failed_failed', {
            customer: 'cus_payment_failed_reversed',
            status: 'open',
            subscription: sub21,
          }),
        },
      ),
    );
    expect(failed.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      const ent = readEntitlement(instance, accountId);
      expect(ent?.status).toBe('active');
      expect(ent?.grace_until).toBeNull();
      const effectCount = (
        instance.db
          .prepare(
            `SELECT COUNT(*) AS n FROM billing_effects
             WHERE effect_kind = 'invoice_payment_failed' AND object_id = ?`,
          )
          .get('in_payment_failed_failed') as { n: number }
      ).n;
      expect(effectCount).toBe(1);
    });
  });
});

describe('identity /billing/events/apply: dispute holds and desired collection', () => {
  function disputeBody(id: string, status: string, customer: string): Record<string, unknown> {
    return {
      id,
      status,
      created: 100,
      charge: { id: `ch_${id}`, customer },
    };
  }

  it('never regresses a closed dispute to open (forward-only holds)', async () => {
    const accountId = await newAccount('billing-dispute-forward');
    const sub12 = 'sub_dispute_forward';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        processorCustomerId: 'cus_dispute_forward',
        processorSubscriptionId: sub12,
      });
    });

    await postApply(
      applyBody(
        { id: 'evt_disp_1', type: 'charge.dispute.closed', created: 100 },
        { dispute: disputeBody('dp_forward', 'won', 'cus_dispute_forward') },
      ),
    );
    await postApply(
      applyBody(
        { id: 'evt_disp_2', type: 'charge.dispute.created', created: 200 },
        { dispute: disputeBody('dp_forward', 'needs_response', 'cus_dispute_forward') },
      ),
    );

    await runInDurableObject(identityStub(), (instance) => {
      const hold = instance.db
        .prepare(`SELECT state FROM billing_dispute_holds WHERE dispute_id = ?`)
        .get('dp_forward') as { state: string };
      expect(hold.state).toBe('won');
      const ordering = readSubOrdering(instance, sub12);
      expect(ordering?.desired_collection).toBe('active');
      expect(readEntitlement(instance, accountId)?.collection_paused).toBe(0);
    });
  });

  it('maps a first-delivered lost dispute to a canceled desired collection', async () => {
    const accountId = await newAccount('billing-dispute-lost');
    const sub13 = 'sub_dispute_lost';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'trialing',
        processorCustomerId: 'cus_dispute_lost',
        processorSubscriptionId: sub13,
      });
    });

    await postApply(
      applyBody(
        { id: 'evt_disp_lost', type: 'charge.dispute.funds_withdrawn', created: 100 },
        { dispute: disputeBody('dp_lost', 'lost', 'cus_dispute_lost') },
      ),
    );

    await runInDurableObject(identityStub(), (instance) => {
      expect(readSubOrdering(instance, sub13)?.desired_collection).toBe('canceled');
      const ent = readEntitlement(instance, accountId);
      expect(ent?.collection_paused).toBe(1);
      expect(ent?.status).toBe('trialing');
    });
  });

  it('stays paused while any dispute is open and reactivates once every one closes', async () => {
    const accountId = await newAccount('billing-dispute-multi');
    const sub14 = 'sub_dispute_multi';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        processorCustomerId: 'cus_dispute_multi',
        processorSubscriptionId: sub14,
      });
    });

    await postApply(
      applyBody(
        { id: 'evt_disp_a1', type: 'charge.dispute.created', created: 100 },
        { dispute: disputeBody('dp_a', 'needs_response', 'cus_dispute_multi') },
      ),
    );
    await postApply(
      applyBody(
        { id: 'evt_disp_b1', type: 'charge.dispute.created', created: 200 },
        { dispute: disputeBody('dp_b', 'warning_needs_response', 'cus_dispute_multi') },
      ),
    );
    await postApply(
      applyBody(
        { id: 'evt_disp_a2', type: 'charge.dispute.closed', created: 300 },
        { dispute: disputeBody('dp_a', 'won', 'cus_dispute_multi') },
      ),
    );

    await runInDurableObject(identityStub(), (instance) => {
      const paused = readSubOrdering(instance, sub14);
      expect(paused?.desired_collection).toBe('paused');
      expect(readEntitlement(instance, accountId)?.collection_paused).toBe(1);
    });

    await postApply(
      applyBody(
        { id: 'evt_disp_b2', type: 'charge.dispute.closed', created: 400 },
        { dispute: disputeBody('dp_b', 'won', 'cus_dispute_multi') },
      ),
    );

    await runInDurableObject(identityStub(), (instance) => {
      const active = readSubOrdering(instance, sub14);
      expect(active?.desired_collection).toBe('active');
      expect(active?.desired_version).toBe(2);
      expect(readEntitlement(instance, accountId)?.collection_paused).toBe(0);
      const bHold = instance.db
        .prepare(`SELECT state FROM billing_dispute_holds WHERE dispute_id = ?`)
        .get('dp_b') as { state: string };
      expect(bHold.state).toBe('won');
    });
  });

  it('ignores a dispute that cannot be mapped to a subject and takes no hold', async () => {
    const raw = applyBody(
      { id: 'evt_disp_ghost', type: 'charge.dispute.created', created: 100 },
      { dispute: disputeBody('dp_ghost', 'needs_response', 'cus_ghost_unknown') },
    );
    const response = await postApply(raw);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'ignored', outcomeDetail: 'unmapped_dispute' });

    await runInDurableObject(identityStub(), (instance) => {
      const holds = (
        instance.db
          .prepare('SELECT COUNT(*) AS n FROM billing_dispute_holds WHERE dispute_id = ?')
          .get('dp_ghost') as { n: number }
      ).n;
      expect(holds).toBe(0);
      expect(readEvent(instance, 'evt_disp_ghost')?.outcome_detail).toBe('unmapped_dispute');
    });
  });

  it('sets company first_paid_at once when a company seat invoice is paid', async () => {
    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(`INSERT INTO companies (company_id, name, created_at, updated_at) VALUES (?, ?, 1, 1)`)
        .run('co_first_paid', 'First Paid Co');
      instance.db
        .prepare(
          `INSERT INTO company_subscriptions (
             company_id, processor_subscription_id, quantity, status, collection_method, updated_at
           ) VALUES (?, ?, 1, 'active', 'charge_automatically', 1)`,
        )
        .run('co_first_paid', 'sub_company_paid');
    });

    const raw = applyBody(
      { id: 'evt_company_paid_1', type: 'invoice.paid', created: 500 },
      {
        invoice: invoiceBody('in_company_paid', {
          customer: 'cus_company_paid',
          amountPaid: 5000,
          paymentIntent: 'pi_company_paid',
          subscription: 'sub_company_paid',
        }),
      },
    );
    await postApply(raw);
    await postApply(raw);

    await runInDurableObject(identityStub(), (instance) => {
      const row = instance.db
        .prepare(`SELECT first_paid_at FROM company_subscriptions WHERE processor_subscription_id = ?`)
        .get('sub_company_paid') as { first_paid_at: number | null };
      expect(row.first_paid_at).toBe(500);
      const payments = (
        instance.db
          .prepare(
            `SELECT COUNT(*) AS n FROM billing_payments
             WHERE subject_kind = 'company' AND subject_id = ?`,
          )
          .get('co_first_paid') as { n: number }
      ).n;
      expect(payments).toBe(1);
    });
  });
});

describe('identity /billing/operations: order idempotency', () => {
  it('replays the same operation id + payload and conflicts on a changed payload', async () => {
    const accountId = await newAccount('billing-op-idempotent');

    const rawOp = JSON.stringify({
      subjectKind: 'account',
      subjectId: accountId,
      operationId: 'op_portal_1',
      kind: 'portal',
      payload: { href: '/billing/portal' },
    });
    const first = await postOperations(rawOp);
    expect(first.status).toBe(201);
    const replay = await postOperations(rawOp);
    expect(replay.status).toBe(200);

    const changed = await postOperations(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_portal_1',
        kind: 'portal',
        payload: { href: '/billing/portal/changed' },
      }),
    );
    expect(changed.status).toBe(409);
  });
});

describe('identity /billing/operations: subscription-collection executor', () => {
  async function seedPausedDesire(accountId: string, subId: string): Promise<void> {
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        processorCustomerId: `cus_${subId}`,
        processorSubscriptionId: subId,
      });
    });
    await postApply(
      applyBody(
        { id: `evt_claim_${subId}`, type: 'charge.dispute.created', created: 100 },
        { dispute: { id: `dp_claim_${subId}`, status: 'needs_response', created: 100, charge: { id: `ch_dp_${subId}`, customer: `cus_${subId}` } } },
      ),
    );
    await runInDurableObject(identityStub(), (instance) => {
      expect(readSubOrdering(instance, subId)?.desired_collection).toBe('paused');
    });
  }

  it('returns the subscription id with the claim so the executor can call Stripe', async () => {
    const accountId = await newAccount('billing-coll-claim-payload');
    const subPayload = 'sub_coll_claim_payload';
    await seedPausedDesire(accountId, subPayload);

    const claim = await postOperations(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_claim_payload',
        kind: 'subscription-collection',
      }),
    );
    expect(claim.status).toBe(201);
    expect(await claim.json()).toEqual({
      status: 'pending',
      claim: {
        claimed: true,
        inFlightVersion: 1,
        inFlightState: 'paused',
        processorSubscriptionId: subPayload,
      },
    });
  });

  it('claims collection through the operation and settles it as success (H4)', async () => {
    const accountId = await newAccount('billing-coll-claim');
    const sub15 = 'sub_coll_claim';
    await seedPausedDesire(accountId, sub15);

    const claim = await postOperations(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_1',
        kind: 'subscription-collection',
      }),
    );
    expect(claim.status).toBe(201);
    const claimBody = (await claim.json()) as { claim: { inFlightVersion: number } };
    expect(claimBody.claim.inFlightVersion).toBe(1);

    const settle = await postSettle(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_1',
        success: true,
        expectedVersion: claimBody.claim.inFlightVersion,
      }),
    );
    expect(settle.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      const row = readSubOrdering(instance, sub15);
      expect(row?.applied_version).toBe(1);
      expect(row?.in_flight_version).toBeNull();
      const opRow = instance.db
        .prepare(
          `SELECT status FROM billing_operations
           WHERE subject_kind = 'account' AND subject_id = ? AND operation_id = ?`,
        )
        .get(accountId, 'op_coll_1') as { status: string };
      expect(opRow.status).toBe('succeeded');
    });
  });

  it('reacts to a stale settle without changing applied state (version check)', async () => {
    const accountId = await newAccount('billing-coll-stale');
    const sub16 = 'sub_coll_stale';
    await seedPausedDesire(accountId, sub16);

    const claim = await postOperations(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_stale',
        kind: 'subscription-collection',
      }),
    );
    const claimBody = (await claim.json()) as { claim: { inFlightVersion: number } };
    await postSettle(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_stale',
        success: true,
        expectedVersion: claimBody.claim.inFlightVersion,
      }),
    );
    const late = await postSettle(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_stale',
        success: true,
        expectedVersion: claimBody.claim.inFlightVersion,
      }),
    );
    expect(late.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      const row = readSubOrdering(instance, sub16);
      expect(row?.applied_version).toBe(1);
      expect(row?.in_flight_version).toBeNull();
    });
  });

  it('confirms collection via the actual Stripe state (H2) and rejects a mismatch', async () => {
    const accountId = await newAccount('billing-coll-confirm');
    const sub17 = 'sub_coll_confirm';
    await seedPausedDesire(accountId, sub17);

    const claim = await postOperations(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_confirm',
        kind: 'subscription-collection',
      }),
    );
    const claimBody = (await claim.json()) as { claim: { inFlightVersion: number } };

    const wrong = await postSettle(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_confirm',
        actualCollectionState: 'active',
      }),
    );
    expect(wrong.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      const stale = readSubOrdering(instance, sub17);
      expect(stale?.applied_version).toBe(0);
      const opRow = instance.db
        .prepare(
          `SELECT status FROM billing_operations
           WHERE subject_kind = 'account' AND subject_id = ? AND operation_id = ?`,
        )
        .get(accountId, 'op_coll_confirm') as { status: string };
      expect(opRow.status).toBe('failed');
    });

    const claimAgain = await postOperations(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_confirm2',
        kind: 'subscription-collection',
      }),
    );
    const claimBody2 = (await claimAgain.json()) as { claim: { inFlightVersion: number } };
    const good = await postSettle(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_confirm2',
        actualCollectionState: 'paused',
        expectedVersion: claimBody2.claim.inFlightVersion,
      }),
    );
    expect(good.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      const row = readSubOrdering(instance, sub17);
      expect(row?.applied_version).toBe(1);
      expect(row?.in_flight_version).toBeNull();
    });
  });

  it('records a definitive failure and clears the in-flight marker (version checked)', async () => {
    const accountId = await newAccount('billing-coll-failure');
    const sub18 = 'sub_coll_failure';
    await seedPausedDesire(accountId, sub18);

    const claim = await postOperations(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_fail',
        kind: 'subscription-collection',
      }),
    );
    const claimBody = (await claim.json()) as { claim: { inFlightVersion: number } };
    const failed = await postSettle(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_fail',
        success: false,
        expectedVersion: claimBody.claim.inFlightVersion,
      }),
    );
    expect(failed.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      const row = readSubOrdering(instance, sub18);
      expect(row?.in_flight_version).toBeNull();
      const opRow = instance.db
        .prepare(
          `SELECT status FROM billing_operations
           WHERE subject_kind = 'account' AND subject_id = ? AND operation_id = ?`,
        )
        .get(accountId, 'op_coll_fail') as { status: string };
      expect(opRow.status).toBe('failed');
    });
  });

  it('repairs a stale applied_version by bumping desired_version (H1)', async () => {
    const accountId = await newAccount('billing-coll-repair');
    const sub19 = 'sub_coll_repair';
    await seedPausedDesire(accountId, sub19);

    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(
          `UPDATE billing_subscriptions SET applied_version = 0, desired_version = 1
           WHERE processor_subscription_id = ?`,
        )
        .run(sub19);
    });

    const settle = await postSettle(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_repair',
        success: true,
      }),
    );
    expect(settle.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      const row = readSubOrdering(instance, sub19);
      expect(row?.desired_version).toBe(2);
      expect(row?.in_flight_version).toBe(2);
    });
  });

  it('cancel (P-9) clears any in-flight claim and is never repaired after', async () => {
    const accountId = await newAccount('billing-coll-no-repair-cancel');
    const sub20 = 'sub_coll_cancel';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        processorCustomerId: 'cus_coll_cancel',
        processorSubscriptionId: sub20,
      });
    });

    await postApply(
      applyBody(
        { id: 'evt_coll_cancel_c1', type: 'charge.dispute.created', created: 100 },
        { dispute: { id: 'dp_coll_cancel', status: 'needs_response', created: 100, charge: { id: 'ch_coll_cancel', customer: 'cus_coll_cancel' } } },
      ),
    );
    const claim = await postOperations(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_cancel',
        kind: 'subscription-collection',
      }),
    );
    expect((await claim.json()) as { claim: { inFlightVersion: number } }).toMatchObject({
      claim: { inFlightVersion: 1 },
    });

    await postApply(
      applyBody(
        { id: 'evt_coll_cancel_1', type: 'customer.subscription.deleted', created: 200 },
        { subscription: subscriptionBody(sub20, 'canceled', { customer: 'cus_coll_cancel', canceledAt: 200 }) },
      ),
    );

    await runInDurableObject(identityStub(), (instance) => {
      const row = readSubOrdering(instance, sub20);
      expect(row?.desired_collection).toBe('canceled');
      expect(row?.desired_version).toBe(2);
      expect(row?.applied_version).toBe(2);
      expect(row?.in_flight_version).toBeNull();
    });

    const settle = await postSettle(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_cancel',
        success: true,
      }),
    );
    expect(settle.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      const row = readSubOrdering(instance, sub20);
      expect(row?.desired_collection).toBe('canceled');
      expect(row?.desired_version).toBe(2);
      expect(row?.applied_version).toBe(2);
      expect(row?.in_flight_version).toBeNull();
    });
  });

  it('settles a pause retry after a newer resume wins: the retry is never sent', async () => {
    const accountId = await newAccount('billing-coll-resume-race');
    const sub21 = 'sub_coll_resume_race';
    await seedPausedDesire(accountId, sub21);

    const claim = await postOperations(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_pause_retry',
        kind: 'subscription-collection',
      }),
    );
    expect(claim.status).toBe(201);
    const claimBody = (await claim.json()) as { claim: { inFlightVersion: number } };
    expect(claimBody.claim.inFlightVersion).toBe(1);

    await postApply(
      applyBody(
        { id: 'evt_coll_resume_race', type: 'charge.dispute.closed', created: 200 },
        {
          dispute: {
            id: `dp_claim_${sub21}`,
            status: 'won',
            created: 200,
            charge: { id: `ch_dp_${sub21}`, customer: `cus_${sub21}` },
          },
        },
      ),
    );

    await runInDurableObject(identityStub(), (instance) => {
      const resumed = readSubOrdering(instance, sub21);
      expect(resumed?.desired_collection).toBe('active');
      expect(resumed?.desired_version).toBe(2);
    });

    const settle = await postSettle(
      JSON.stringify({
        subjectKind: 'account',
        subjectId: accountId,
        operationId: 'op_coll_pause_retry',
        success: true,
        expectedVersion: claimBody.claim.inFlightVersion,
      }),
    );
    expect(settle.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      const row = readSubOrdering(instance, sub21);
      expect(row?.desired_collection).toBe('active');
      expect(row?.applied_version).toBe(1);
      expect(row?.in_flight_version).toBe(2);
      expect(row?.in_flight_state).toBe('active');
    });
  });
});

describe('identity /billing/events/apply: collection handoff (D-6)', () => {
  it('names the account whose pending collection the executor must run', async () => {
    const accountId = await newAccount('billing-apply-handoff');
    const subHandoff = 'sub_apply_handoff';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        processorCustomerId: `cus_${subHandoff}`,
        processorSubscriptionId: subHandoff,
      });
    });

    const response = await postApply(
      applyBody(
        { id: `evt_apply_handoff_${subHandoff}`, type: 'charge.dispute.created', created: 100 },
        {
          dispute: {
            id: `dp_apply_handoff_${subHandoff}`,
            status: 'needs_response',
            created: 100,
            charge: { id: `ch_apply_handoff_${subHandoff}`, customer: `cus_${subHandoff}` },
          },
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: 'applied',
      collection: { subjectKind: 'account', subjectId: accountId },
    });
  });

  it('omits the handoff when nothing is pending after the apply', async () => {
    const accountId = await newAccount('billing-apply-no-handoff');
    const subSettled = 'sub_apply_no_handoff';
    await runInDurableObject(identityStub(), (instance) => {
      seedEntitlement(instance, accountId, {
        planId: 'tutor_pro_monthly',
        status: 'active',
        processorCustomerId: `cus_${subSettled}`,
        processorSubscriptionId: subSettled,
      });
    });

    const response = await postApply(
      applyBody(
        { id: `evt_apply_no_handoff_${subSettled}`, type: 'customer.subscription.updated', created: 100 },
        {
          subscription: subscriptionBody(subSettled, 'active', {
            customer: `cus_${subSettled}`,
          }),
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'applied' });
  });
});

describe('identity /billing/events/apply: checkout referral effect (P-3)', () => {
  function checkoutBody(
    id: string,
    opts: Partial<{
      clientReferenceId: string | null;
      customer: string | null;
      referrerCode: string | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      id,
      clientReferenceId: opts.clientReferenceId ?? null,
      customer: opts.customer ?? null,
      referrerCode: opts.referrerCode ?? null,
    };
  }

  it('records one pending redemption per checkout session and dedupes across event ids', async () => {
    const ownerId = await newAccount('billing-checkout-referral-owner');
    const buyerId = await newAccount('billing-checkout-referral-buyer');
    const code = await runInDurableObject(identityStub(), (instance) =>
      ensureReferralCode(instance.db, { accountId: ownerId, now: 1 }).code,
    );
    const session = checkoutBody('cs_checkout_referral', {
      clientReferenceId: buyerId,
      customer: 'cus_checkout_referral',
      referrerCode: code,
    });

    const first = await postApply(
      applyBody(
        { id: 'evt_checkout_referral_a', type: 'checkout.session.completed', created: 300 },
        { checkout: session },
      ),
    );
    expect(first.status).toBe(200);

    const replay = await postApply(
      applyBody(
        { id: 'evt_checkout_referral_b', type: 'checkout.session.completed', created: 301 },
        { checkout: session },
      ),
    );
    expect(replay.status).toBe(200);

    const zero = await postApply(
      applyBody(
        { id: 'evt_checkout_referral_zero', type: 'invoice.paid', created: 400 },
        {
          invoice: invoiceBody('in_checkout_referral_zero', {
            customer: 'cus_checkout_referral',
            amountPaid: 0,
          }),
        },
      ),
    );
    expect(zero.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      const rows = instance.db
        .prepare(
          `SELECT code, kind, referred_account_id, referred_customer_id, object_id,
                  reward_status, confirmed_at, processor_event_id
           FROM referral_events
           WHERE kind = 'redemption' AND object_id = 'cs_checkout_referral'`,
        )
        .all();
      expect(rows).toEqual([
        {
          code,
          kind: 'redemption',
          referred_account_id: buyerId,
          referred_customer_id: 'cus_checkout_referral',
          object_id: 'cs_checkout_referral',
          reward_status: 'pending',
          confirmed_at: null,
          processor_event_id: 'evt_checkout_referral_a',
        },
      ]);
      expect(
        instance.db
          .prepare(
            `SELECT COUNT(*) AS count FROM billing_effects
             WHERE effect_kind = 'checkout_completed' AND object_id = 'cs_checkout_referral'`,
          )
          .get(),
      ).toEqual({ count: 1 });
    });
  });

  it('records no redemption when the session carries no validated code', async () => {
    const buyerId = await newAccount('billing-checkout-no-code-buyer');
    const response = await postApply(
      applyBody(
        { id: 'evt_checkout_no_code', type: 'checkout.session.completed', created: 300 },
        {
          checkout: checkoutBody('cs_checkout_no_code', {
            clientReferenceId: buyerId,
            customer: 'cus_checkout_no_code',
          }),
        },
      ),
    );
    expect(response.status).toBe(200);

    await runInDurableObject(identityStub(), (instance) => {
      expect(
        instance.db
          .prepare(
            `SELECT COUNT(*) AS count FROM referral_events
             WHERE kind = 'redemption' AND object_id = 'cs_checkout_no_code'`,
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        instance.db
          .prepare(
            `SELECT COUNT(*) AS count FROM billing_effects
             WHERE effect_kind = 'checkout_completed' AND object_id = 'cs_checkout_no_code'`,
          )
          .get(),
      ).toEqual({ count: 1 });
    });
  });
});