import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import { getIdentityObject, REFERRALS_ME_RATE_MAX, type IdentityDO } from './do/IdentityDO';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  localAccessToken,
} from './test/workerAuth';
import { ensureReferralCode } from './lib/referrals/codes';
import {
  confirmReferralRedemption,
  recordReferralRedemption,
} from './lib/referrals/ledger';

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
const REFERRALS_ME_PATH = '/api/referrals/me';
const CHECKOUT_PATH = '/api/billing/checkout';

function identityStub() {
  return getIdentityObject(env.IDENTITY);
}

function referralsMeFromDo(cookie: string, baseUrl = TEACHER_BASE): Promise<Response> {
  return identityStub().fetch(
    `https://identity/referrals/me?baseUrl=${encodeURIComponent(baseUrl)}`,
    { headers: { cookie } },
  );
}

function validateReferralFromDo(cookie: string, referralCode: string): Promise<Response> {
  return identityStub().fetch('https://identity/referrals/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ referralCode }),
  });
}

describe('IdentityDO GET /referrals/me (spec §6.2)', () => {
  it('requires a local session and a base URL', async () => {
    const noSession = await identityStub().fetch(
      `https://identity/referrals/me?baseUrl=${encodeURIComponent(TEACHER_BASE)}`,
    );
    expect(noSession.status).toBe(401);

    const session = await bootstrapLocalSession('referrals-me-base-url');
    const noBase = await identityStub().fetch('https://identity/referrals/me', {
      headers: { cookie: session.cookie },
    });
    expect(noBase.status).toBe(400);
  });

  it("returns the caller's code, link and split tallies", async () => {
    const owner = await bootstrapLocalSession('referrals-me-owner');
    const pending = await bootstrapLocalSession('referrals-me-pending');
    const confirmed = await bootstrapLocalSession('referrals-me-confirmed');
    const code = await runInDurableObject(identityStub(), (instance) => {
      const minted = ensureReferralCode(instance.db, { accountId: owner.accountId, now: 500 });
      recordReferralRedemption(instance.db, {
        code: minted.code,
        referredAccountId: pending.accountId,
        referredCustomerId: 'cus_referrals_me_pending',
        objectId: 'cs_referrals_me_pending',
        occurredAt: 1_000,
        recordedAt: 1_000,
      });
      recordReferralRedemption(instance.db, {
        code: minted.code,
        referredAccountId: confirmed.accountId,
        referredCustomerId: 'cus_referrals_me_confirmed',
        objectId: 'cs_referrals_me_confirmed',
        occurredAt: 1_000,
        recordedAt: 1_000,
      });
      confirmReferralRedemption(instance.db, {
        referredCustomerId: 'cus_referrals_me_confirmed',
        amountPaidCents: 1_999,
        occurredAt: 2_000,
      });
      return minted.code;
    });

    const response = await referralsMeFromDo(owner.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      code,
      link: `${TEACHER_BASE}/whiteboard?ref=${code}`,
      pendingCount: 1,
      confirmedCount: 1,
      redemptionCount: 2,
    });
  });

  it('returns the honest empty state for an account without a code', async () => {
    const stranger = await bootstrapLocalSession('referrals-me-stranger');
    const response = await referralsMeFromDo(stranger.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      code: null,
      link: null,
      pendingCount: 0,
      confirmedCount: 0,
      redemptionCount: 0,
    });
  });

  it('never returns another account rows', async () => {
    const first = await bootstrapLocalSession('referrals-me-first');
    const second = await bootstrapLocalSession('referrals-me-second');
    const firstReferred = await bootstrapLocalSession('referrals-me-first-referred');
    const secondReferred = await bootstrapLocalSession('referrals-me-second-referred');
    const codes = await runInDurableObject(identityStub(), (instance) => {
      const firstCode = ensureReferralCode(instance.db, {
        accountId: first.accountId,
        now: 500,
      }).code;
      const secondCode = ensureReferralCode(instance.db, {
        accountId: second.accountId,
        now: 500,
      }).code;
      recordReferralRedemption(instance.db, {
        code: firstCode,
        referredAccountId: firstReferred.accountId,
        objectId: 'cs_referrals_me_first',
        occurredAt: 1_000,
        recordedAt: 1_000,
      });
      recordReferralRedemption(instance.db, {
        code: secondCode,
        referredAccountId: secondReferred.accountId,
        referredCustomerId: 'cus_referrals_me_second',
        objectId: 'cs_referrals_me_second',
        occurredAt: 1_000,
        recordedAt: 1_000,
      });
      confirmReferralRedemption(instance.db, {
        referredCustomerId: 'cus_referrals_me_second',
        amountPaidCents: 1_999,
        occurredAt: 2_000,
      });
      return { firstCode, secondCode };
    });

    const firstResponse = await referralsMeFromDo(first.cookie, 'https://one.example');
    expect(await firstResponse.json()).toEqual({
      code: codes.firstCode,
      link: `https://one.example/whiteboard?ref=${codes.firstCode}`,
      pendingCount: 1,
      confirmedCount: 0,
      redemptionCount: 1,
    });

    const secondResponse = await referralsMeFromDo(second.cookie, 'https://two.example');
    expect(await secondResponse.json()).toEqual({
      code: codes.secondCode,
      link: `https://two.example/whiteboard?ref=${codes.secondCode}`,
      pendingCount: 0,
      confirmedCount: 1,
      redemptionCount: 1,
    });
  });

  it('counts 60 reads per account in the DO and refuses the 61st', async () => {
    const session = await bootstrapLocalSession('referrals-me-rate-limit');
    for (let index = 0; index < REFERRALS_ME_RATE_MAX; index += 1) {
      const response = await referralsMeFromDo(session.cookie);
      expect(response.status, `read ${index}`).toBe(200);
    }

    const limited = await referralsMeFromDo(session.cookie);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    const body = (await limited.json()) as { error: string; retryAfterMs: number };
    expect(body.error).toBe('Too many requests');
    expect(body.retryAfterMs).toBeGreaterThan(0);

    const row = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare(
          'SELECT subject_id, count FROM billing_rate_counters WHERE subject_id = ?',
        )
        .get(`referrals:me:${session.accountId}`),
    );
    expect(row).toEqual({
      subject_id: `referrals:me:${session.accountId}`,
      count: REFERRALS_ME_RATE_MAX,
    });
  });
});

describe('IdentityDO POST /referrals/validate (spec §9.1)', () => {
  it('requires a local session', async () => {
    const response = await identityStub().fetch('https://identity/referrals/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ referralCode: 'ABCDEFGH' }),
    });
    expect(response.status).toBe(401);
  });

  it('answers the canonical live code for another account', async () => {
    const owner = await bootstrapLocalSession('referral-validate-live-owner');
    const buyer = await bootstrapLocalSession('referral-validate-live-buyer');
    const code = await runInDurableObject(identityStub(), (instance) =>
      ensureReferralCode(instance.db, { accountId: owner.accountId, now: 500 }).code,
    );

    const response = await validateReferralFromDo(buyer.cookie, code.toLowerCase());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ referralCode: code });
  });

  it('answers null for unknown, inactive, expired and own codes', async () => {
    const liveOwner = await bootstrapLocalSession('referral-validate-owner-live');
    const inactiveOwner = await bootstrapLocalSession('referral-validate-owner-inactive');
    const expiredOwner = await bootstrapLocalSession('referral-validate-owner-expired');
    const buyer = await bootstrapLocalSession('referral-validate-dead-buyer');
    const codes = await runInDurableObject(identityStub(), (instance) => {
      const live = ensureReferralCode(instance.db, {
        accountId: liveOwner.accountId,
        now: 500,
      }).code;
      const inactive = ensureReferralCode(instance.db, {
        accountId: inactiveOwner.accountId,
        now: 500,
      }).code;
      instance.db
        .prepare('UPDATE referral_codes SET active = 0 WHERE code = ?')
        .run(inactive);
      const expired = ensureReferralCode(instance.db, {
        accountId: expiredOwner.accountId,
        now: 500,
      }).code;
      instance.db
        .prepare('UPDATE referral_codes SET expires_at = 1000 WHERE code = ?')
        .run(expired);
      return { live, inactive, expired };
    });

    for (const code of ['ZZZZZZZZ', codes.inactive, codes.expired]) {
      const response = await validateReferralFromDo(buyer.cookie, code);
      expect(response.status, code).toBe(200);
      expect(await response.json(), code).toEqual({ referralCode: null });
    }

    const own = await validateReferralFromDo(liveOwner.cookie, codes.live);
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ referralCode: null });
  });
});

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

describe('Worker POST /api/billing/checkout referral attribution (spec §9.1)', () => {
  it('ignores unknown, inactive and expired codes before recording the operation', async () => {
    const inactiveOwner = await bootstrapLocalSession('referral-checkout-inactive-owner');
    const expiredOwner = await bootstrapLocalSession('referral-checkout-expired-owner');
    const codes = await runInDurableObject(identityStub(), (instance) => {
      const inactive = ensureReferralCode(instance.db, {
        accountId: inactiveOwner.accountId,
        now: 500,
      }).code;
      instance.db
        .prepare('UPDATE referral_codes SET active = 0 WHERE code = ?')
        .run(inactive);
      const expired = ensureReferralCode(instance.db, {
        accountId: expiredOwner.accountId,
        now: 500,
      }).code;
      instance.db
        .prepare('UPDATE referral_codes SET expires_at = 1000 WHERE code = ?')
        .run(expired);
      return { inactive, expired };
    });

    const buyer = await bootstrapLocalSession('referral-checkout-ignored-buyer');
    const suspicious = ['ZZZZZZZZ', codes.inactive, codes.expired];
    for (const [index, referralCode] of suspicious.entries()) {
      const operationId = `op_ignored_${index}`;
      const attributed = await postCheckout(buyer, {
        planId: 'tutor_pro_monthly',
        operationId,
        referralCode,
      });
      expect(attributed.status, referralCode).toBe(502);

      const absent = await postCheckout(buyer, {
        planId: 'tutor_pro_monthly',
        operationId,
      });
      expect(absent.status, referralCode).toBe(502);
    }
  });

  it('keeps a live code in the operation request', async () => {
    const owner = await bootstrapLocalSession('referral-checkout-live-owner');
    const liveCode = await runInDurableObject(identityStub(), (instance) =>
      ensureReferralCode(instance.db, { accountId: owner.accountId, now: 500 }).code,
    );
    const buyer = await bootstrapLocalSession('referral-checkout-live-buyer');

    const attributed = await postCheckout(buyer, {
      planId: 'tutor_pro_monthly',
      operationId: 'op_live_code',
      referralCode: liveCode,
    });
    expect(attributed.status).toBe(502);

    const absent = await postCheckout(buyer, {
      planId: 'tutor_pro_monthly',
      operationId: 'op_live_code',
    });
    expect(absent.status).toBe(409);
  });
});

describe('Worker GET /api/referrals/me', () => {
  it('routes the referral read only on the teacher host at the exact path', async () => {
    for (const base of [GUEST_BASE, MARKETING_BASE]) {
      const response = await SELF.fetch(`${base}${REFERRALS_ME_PATH}`);
      expect(response.status, base).toBe(404);
    }

    const suffix = await SELF.fetch(`${TEACHER_BASE}${REFERRALS_ME_PATH}/extra`);
    expect(suffix.status).toBe(404);

    const prefix = await SELF.fetch(`${TEACHER_BASE}/api/referrals/mine`);
    expect(prefix.status).toBe(404);
  });

  it('answers 405 for a non-GET and 401 without a local session', async () => {
    const post = await SELF.fetch(`${TEACHER_BASE}${REFERRALS_ME_PATH}`, {
      method: 'POST',
      headers: {
        Origin: TEACHER_BASE,
        'Cf-Access-Jwt-Assertion': await localAccessToken('referrals-me-worker-post'),
      },
    });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');

    const token = await localAccessToken('referrals-me-worker-no-session');
    const noSession = await SELF.fetch(`${TEACHER_BASE}${REFERRALS_ME_PATH}`, {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    expect(noSession.status).toBe(401);
  });

  it("returns the caller's summary and no other account's", async () => {
    const first = await bootstrapLocalSession('referrals-worker-first');
    const second = await bootstrapLocalSession('referrals-worker-second');
    const firstReferred = await bootstrapLocalSession('referrals-worker-first-referred');
    const secondReferred = await bootstrapLocalSession('referrals-worker-second-referred');
    const codes = await runInDurableObject(identityStub(), (instance) => {
      const firstCode = ensureReferralCode(instance.db, {
        accountId: first.accountId,
        now: 500,
      }).code;
      const secondCode = ensureReferralCode(instance.db, {
        accountId: second.accountId,
        now: 500,
      }).code;
      recordReferralRedemption(instance.db, {
        code: firstCode,
        referredAccountId: firstReferred.accountId,
        objectId: 'cs_referrals_worker_first',
        occurredAt: 1_000,
        recordedAt: 1_000,
      });
      recordReferralRedemption(instance.db, {
        code: secondCode,
        referredAccountId: secondReferred.accountId,
        referredCustomerId: 'cus_referrals_worker_second',
        objectId: 'cs_referrals_worker_second',
        occurredAt: 1_000,
        recordedAt: 1_000,
      });
      confirmReferralRedemption(instance.db, {
        referredCustomerId: 'cus_referrals_worker_second',
        amountPaidCents: 1_999,
        occurredAt: 2_000,
      });
      return { firstCode, secondCode };
    });

    const firstResponse = await authenticatedFetch(REFERRALS_ME_PATH, first);
    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual({
      code: codes.firstCode,
      link: `${TEACHER_BASE}/whiteboard?ref=${codes.firstCode}`,
      pendingCount: 1,
      confirmedCount: 0,
      redemptionCount: 1,
    });

    const secondResponse = await authenticatedFetch(REFERRALS_ME_PATH, second);
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toEqual({
      code: codes.secondCode,
      link: `${TEACHER_BASE}/whiteboard?ref=${codes.secondCode}`,
      pendingCount: 0,
      confirmedCount: 1,
      redemptionCount: 1,
    });
  });

  it('rate-limits the route through the IdentityDO counter with 429 and Retry-After', async () => {
    const session = await bootstrapLocalSession('referrals-worker-rate-limit');
    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(
          `INSERT INTO billing_rate_counters (subject_id, window_start, count)
           VALUES (?, ?, ?)
           ON CONFLICT(subject_id) DO UPDATE SET
             window_start = excluded.window_start,
             count = excluded.count`,
        )
        .run(`referrals:me:${session.accountId}`, Date.now(), REFERRALS_ME_RATE_MAX);
    });

    const limited = await authenticatedFetch(REFERRALS_ME_PATH, session);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect(await limited.json()).toEqual({ error: 'Too many requests' });
  });
});
