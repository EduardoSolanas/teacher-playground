# 04 — Stripe, Subscriptions & Referrals

Investigator #4 findings, 2026-09-11. Research only: no production code, tests,
or configs were modified. External claims cite URL + access date
(2026-09-11); repo claims cite `path:line`. Statements marked **Assumption**
are not yet verified against an implementation or an owner decision.

Scope: Cloudflare Workers integration, Stripe Billing (personal + corporate
per-seat), referral tracking, identity-store data model, local/ops setup, TDD
plan. The binding contract is `security.md` SEC-015 (`security.md:848-1073`).

## Recommended architecture

**Processor: Stripe, hosted surfaces only** (already proposed in
`security.md:1029-1037`). Keep card data out of the app: Checkout for personal
Tutor Pro, Customer Portal for card change/cancel, Stripe-hosted invoice page
for corporate invoice-first. This preserves SAQ-A scope.

**Recommendation: call the Stripe REST API directly with `fetch` and verify
webhooks locally with Web Crypto — do not add `stripe-node` yet.**

- The repo already has the exact crypto pattern: `crypto.subtle.importKey`
  (`HMAC`/`SHA-256`) and `sign`/`verify` in `src/lib/av/livekitToken.ts:49-62`
  and `:185-198`, plus `crypto.subtle.verify` for RS256 in
  `src/lib/access/accessVerifier.ts:295-313`. A ~50-line verifier fits the
  house style and is unit-testable with real signed payloads.
- AGENTS.md says avoid new dependencies unless needed (`AGENTS.md:11`). The
  needed surface is small: create Checkout session, create Customer Portal
  session, create/update Subscription (corporate quantity), retrieve
  Subscription, list events for reconciliation.
- Direct REST lets us pin `Stripe-Version` explicitly and never leaves the raw
  body / error shape at the mercy of SDK runtime quirks.
- If the owner prefers SDK types, `stripe-node` is viable on Workers:
  `new Stripe(key, { httpClient: Stripe.createFetchHttpClient() })` +
  `stripe.webhooks.constructEventAsync(raw, sig, secret, undefined,
  Stripe.createSubtleCryptoProvider())`. `nodejs_compat` is already enabled in
  both configs (`wrangler.toml:11`, `wrangler.local.toml:7`); since v11.10 the
  SDK no longer needs it, but the sync `constructEvent` throws on Workers and
  the default `NodeHttpClient` hangs
  ([stripe-node Workers template](https://github.com/stripe-samples/stripe-node-cloudflare-worker-template),
  [jross.me verifier](https://jross.me/verifying-stripe-webhook-signatures-cloudflare-workers/),
  [Chan Meng 2026 integration write-up](https://chanmeng.org/blog/stripe-cloudflare-workers-integration),
  accessed 2026-09-11). `stripe-node` v22.0.2 additionally added
  `parseEventNotificationAsync` for async-only runtimes
  ([stripe-node PR #2685](https://github.com/stripe/stripe-node/pull/2685),
  accessed 2026-09-11).

### Integration surface found in the repo

- Worker: `src/worker.ts`; Durable Objects `RoomDO`, `IdentityDO`
  (`wrangler.toml:61-83`). Identity is the singleton `global` object
  (`IdentityDO.ts:74`, `:695-699`), SQLite-backed via `DODatabase` with
  `storage.transactionSync` (`doDatabase.ts:21-23`).
- Secrets/vars: non-secret config in `[vars]` (`wrangler.toml:85-97`), secrets
  via `wrangler secret put` (pattern in `DEPLOY.md:113-124`), local via
  `.dev.vars` (`README.md:91-109`; ignored by `.gitignore` `.dev.vars*`).
  `Env` is declared in `src/worker.ts:53-75`.
- Signature precedents: LiveKit outbound HS256 (`livekitToken.ts:49-62`),
  Access inbound RS256 + freshness window (`accessVerifier.ts:238-257`,
  `:295-313`). There is **no existing HMAC-over-raw-body route**.
- Raw body: bodies are read once, either `request.json()` (`IdentityDO.ts:303`,
  handlers) or bounded bytes via `readBoundedJsonBody` (`requestGuard.ts:328-337`),
  and re-wrapped so they can travel again (`worker.ts:1289-1296`). For Stripe,
  read `await request.arrayBuffer()` (or `.text()`) **before** `JSON.parse`,
  verify the exact bytes, then parse.
- The webhook route must clear three existing guards, all currently fail
  closed:
  1. `isRouteAllowedOnHost` denies unknown paths (`requestGuard.ts:64-198`,
     ends `return false` at `:197`), so `/api/billing/webhook` is 404 today.
  2. `isOriginGuardedPath` treats every `/api/` non-GET as origin-guarded
     (`requestGuard.ts:212-223`); `originGuard` (`worker.ts:263-270`) requires
     an exact `Origin`, which Stripe never sends.
  3. Access verification runs for everything not public (`worker.ts:987-995`);
     `isPublicPath` is GET/HEAD-only and exact-match
     (`worker.ts:976-985`, `requestGuard.ts:360-388`). The Access application
     covers the teacher hostname, so a path-scoped **Bypass** policy (or a
     separate unproxied hostname) is required for Stripe to reach the Worker
     at all.
  A public POST must therefore be an explicit, reviewed exemption: exact path,
  POST only, signature-verified, rate-limited, body-capped, never on the
  marketing host (`requestGuard.ts:96-114`).

### Minimal raw-body + signature pattern (sketch, not implemented)

```ts
// src/lib/billing/stripeSignature.ts — exact bytes, no re-serialization.
export const STRIPE_TOLERANCE_SECONDS = 300; // Stripe's documented default

export async function verifyStripeSignature(
  bodyBytes: Uint8Array,
  header: string | null,
  secrets: readonly string[],
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header) return false;
  let timestamp = Number.NaN;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const sep = part.indexOf('=');
    if (sep < 0) continue;
    const key = part.slice(0, sep);
    const value = part.slice(sep + 1);
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1' && value) v1.push(value);
  }
  if (!Number.isFinite(timestamp) || v1.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > STRIPE_TOLERANCE_SECONDS) return false;

  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.byteLength + bodyBytes.byteLength);
  signed.set(prefix, 0);
  signed.set(bodyBytes, prefix.byteLength);

  for (const secret of secrets) {
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    for (const signature of v1) {
      if (await crypto.subtle.verify('HMAC', key, hexToBytes(signature), signed)) return true;
    }
  }
  return false; // constant-time compare is inside crypto.subtle.verify
}
```

Route order (never call `request.json()` first):

```ts
const bounded = await readBoundedJsonBody(request);           // 4 MiB cap, requestGuard.ts:238
if (!bounded.ok) return new Response(null, { status: 413 });
const raw = new Uint8Array(bounded.buffer);
if (!(await verifyStripeSignature(raw, request.headers.get('stripe-signature'), stripeSecrets(env)))) {
  return new Response(null, { status: 400 });                 // no body echoed, no detail
}
const event = JSON.parse(new TextDecoder().decode(raw)) as StripeEvent;
// hand { eventId, type, created, livemode, object } to IdentityDO; dedupe + apply there
```

## Webhook contract

Subscribe to exactly these event types; everything else returns 200 and is
recorded for audit. Every action is applied by `IdentityDO` in one
`db.transaction` (event row first), and every entitlement transition writes an
audit row in the same transaction (`security.md:883-885`).

| Stripe event | Local action | Key fields | Notes |
| --- | --- | --- | --- |
| `checkout.session.completed` | Bind `customer` + `subscription` to the account/company; fetch the live subscription and apply its state; attribute referral | `session.client_reference_id`, `session.metadata`, `session.subscription`, `session.customer`, `session.discounts[].promotion_code`, `session.customer_details.tax_ids` | Never grant from the redirect (`security.md:876-878`). With delayed payment methods the session can complete `payment_status=unpaid`; treat as a trigger to reconcile, not proof of payment ([Stripe Checkout object](https://docs.stripe.com/api/checkout/sessions/object), accessed 2026-09-11). |
| `checkout.session.async_payment_succeeded` / `...failed` | Re-run the completed-session handler / record failure | same | Add only if delayed methods are enabled. |
| `customer.subscription.created` / `updated` | Re-fetch subscription; upsert entitlement / company subscription; map status; seats = item `quantity` | `status`, `items.data[0].current_period_end`, `items.data[0].quantity`, `cancel_at_period_end`, `customer`, `metadata` | **Period fields moved to the subscription item** in the 2025-03-31 Basil API; read `items.data[].current_period_end` ([Stripe changelog](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end), accessed 2026-09-11). `cancel_at_period_end=true` must **not** revoke; only `deleted`/period lapse does. |
| `customer.subscription.deleted` | `status=canceled`; archive-over-quota (`security.md:1021-1027`); bump epoch | `id`, `customer` | Revocation bound: epoch bump removes HTTP and open-socket access (`security.md:886-889`). |
| `invoice.paid` | Extend `current_period_end`; `past_due -> active`; mark referral renewal; for `send_invoice` mark seat invoice paid | `subscription`, `customer`, `amount_paid`, `billing_reason`, `period_end` | Canonical "fully paid" signal (covers out-of-band/ wire payment). |
| `invoice.payment_failed` | `active -> past_due`; 7-day grace per SEC-015 | `subscription`, `customer`, `attempt_count` | For `send_invoice`, Stripe moves to `past_due` only after the due date ([Subscription invoices](https://docs.stripe.com/billing/invoices/subscription), accessed 2026-09-11). |
| `charge.dispute.created` | `canceled` + review flag, no grace | `payment_intent`, `charge`, `customer` | Resolve to subscription via `payment_intent`/invoice if needed. |
| `charge.refunded` | Referral clawback (reversal only); entitlement change only if fully refunded/canceled | `payment_intent`, `amount_refunded`, `refunded` | See Referral design. |

Status mapping (SEC-015 state machine `security.md:1011-1019`):
`active`/`trialing -> active`; `past_due -> past_due`; `unpaid -> past_due`
until the grace window lapses, then `canceled`; `canceled`/`incomplete_expired
-> canceled`; `incomplete`/`paused -> no entitlement` (**Assumption:** paused
treated like past_due; confirm product intent). Stripe statuses per
[Subscription object](https://docs.stripe.com/api/subscriptions/object)
(accessed 2026-09-11).

Delivery rules (all required by `security.md:879-882` and acceptance tests
`:937-944`):

1. **Dedupe first**: `INSERT OR IGNORE INTO billing_events(event_id, ...)`;
   `changes === 0` means replay -> 200, no further reads. The DB unique
   constraint is the primitive, not a check-then-insert
   ([Stripe webhooks](https://docs.stripe.com/webhooks), accessed 2026-09-11;
   [APIScout 2026](https://apiscout.dev/guides/stripe-webhooks-complete-guide-2026),
   accessed 2026-09-11).
2. **Stale-event guard**: store `last_event_created` per subscription;
   discard payload events older than stored (`event.created`), return 200
   ([Cesar Ayala 2026](https://cesarayala.dev/blog/stripe-webhooks-out-of-order-subscription-bug/),
   accessed 2026-09-11).
3. **Re-fetch, don't trust the payload** for `customer.subscription.*` and
   `invoice.*`; the event is a notification, Stripe is the truth.
4. **Mode check**: reject `event.livemode` that disagrees with the configured
   secret mode (test event must never grant production entitlement).
5. **Respond fast**: verify + dedupe + apply is fast SQL in one DO; return 200
   on duplicates, stale events, and unknown types; 400 only on bad signature;
   5xx only when the local write failed (so Stripe retries for its ~3-day
   window). Heavy work (reconciliation, notifications) goes to `waitUntil`/the
   daily sweep, never inline.
6. **Outbound idempotency**: send `Idempotency-Key` on every POST
   (`/v1/checkout/sessions`, `/v1/subscriptions/{id}`), deterministically
   derived from the operation, e.g. `checkout:<account_id>:<plan_id>` or
   `seats:<company_id>:<target_quantity>`; Stripe retains keys 24h
   ([Idempotent requests](https://docs.stripe.com/api/idempotent_requests),
   accessed 2026-09-11). Use `randomHexId`/`crypto.randomUUID`
   (`src/lib/crypto/randomId.ts:9-13`) for nonce components only.

## Data model

Extends the SEC-015 proposals (`security.md:1000-1009`). All tables live in the
IdentityDO SQLite store beside `accounts` (`identityStore.ts:40-228`). Applied
via `applyIdentitySchema` (`IdentityDO.ts:321`). Use `CREATE TABLE IF NOT
EXISTS`; SQLite cannot alter a `CHECK`, so the existing
`authorization_audit.action` constraint (`identityStore.ts:162-179`) is **not**
extended — billing gets its own audit table.

```sql
-- One row per account; absence means Free (security.md:1003).
entitlements(
  account_id TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL CHECK (plan_id IN ('free','tutor_pro','corporate_seat')),
  status TEXT NOT NULL CHECK (status IN ('free','trialing','active','past_due','canceled')),
  source TEXT NOT NULL CHECK (source IN ('personal','company')),
  company_id TEXT REFERENCES companies(company_id),
  current_period_end INTEGER,
  processor_customer_id TEXT,
  processor_subscription_id TEXT,
  last_event_created INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  CHECK (source = 'personal' OR company_id IS NOT NULL)
);

-- Stripe Customer is the company. Tax id / address stay in Stripe (SEC-015
-- "store only processor identifiers"); `name` is optional UI convenience.
companies(
  company_id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  processor_customer_id TEXT NOT NULL UNIQUE,
  name TEXT CHECK (name IS NULL OR length(name) <= 200),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- One active company per account: partial unique index below.
company_members(
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  state TEXT NOT NULL CHECK (state IN ('invited','active','revoked')),
  joined_at INTEGER, revoked_at INTEGER,
  PRIMARY KEY (company_id, account_id)
);
CREATE UNIQUE INDEX idx_company_members_one_active
  ON company_members(account_id) WHERE state = 'active';
CREATE INDEX idx_company_members_company ON company_members(company_id, state);

-- Stripe is authoritative for quantity/status/period; this is the projection.
company_subscriptions(
  company_id TEXT PRIMARY KEY REFERENCES companies(company_id) ON DELETE CASCADE,
  processor_subscription_id TEXT NOT NULL UNIQUE,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  status TEXT NOT NULL,
  collection_method TEXT NOT NULL CHECK (collection_method IN ('charge_automatically','send_invoice')),
  current_period_end INTEGER,
  last_event_created INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Dedupe key is the processor event id (security.md:1006-1009).
billing_events(
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  livemode INTEGER NOT NULL CHECK (livemode IN (0,1)),
  event_created INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,          -- SHA-256 over raw body, for audit only
  processed_at INTEGER,                -- NULL while in flight; set on success
  outcome TEXT                          -- 'applied' | 'duplicate' | 'stale' | 'ignored'
);

-- New audit table; keeps authorization_audit append-only and its CHECK intact.
entitlement_audit(
  audit_id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('account','company')),
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL,                 -- 'checkout-bind' | 'subscription-sync' | 'seat-grant' | 'seat-revoke' | 'downgrade' | 'chargeback' | ...
  actor TEXT NOT NULL, reason TEXT NOT NULL,
  previous_plan TEXT, next_plan TEXT,
  previous_status TEXT, next_status TEXT,
  previous_epoch INTEGER NOT NULL, next_epoch INTEGER NOT NULL,
  processor_event_id TEXT,
  created_at INTEGER NOT NULL
);

referral_codes(
  code TEXT PRIMARY KEY COLLATE NOCASE
    CHECK (length(code) BETWEEN 6 AND 32 AND code NOT GLOB '*[^A-Za-z0-9-]*'),
  owner_account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  promotion_code_id TEXT UNIQUE,         -- Stripe promo_..., when mirrored
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  expires_at INTEGER, max_redemptions INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_referral_codes_owner ON referral_codes(owner_account_id); -- one code per account

referral_events(
  event_id TEXT PRIMARY KEY,
  code TEXT NOT NULL REFERENCES referral_codes(code),
  referred_account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  referred_customer_id TEXT,
  stripe_object_id TEXT NOT NULL UNIQUE, -- session id or invoice id
  kind TEXT NOT NULL CHECK (kind IN ('redemption','renewal','reversal')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_referral_events_referred ON referral_events(code, referred_account_id) WHERE kind = 'redemption';
```

Idempotent write rules:

- Event handling is one transaction: insert `billing_events` -> dedupe -> stale
  check -> re-fetch/apply -> `entitlements`/`company_*` upsert -> epoch bump if
  access changed -> `entitlement_audit` row. `IdentityDO` is single-threaded
  and `DODatabase.transaction` is `storage.transactionSync`
  (`doDatabase.ts:21-23`), so no cross-request interleaving.
- Rewrite `entitlements` only when `event_created > last_event_created`;
  unknown objects are omitted rather than defaulted (same fail-closed rule as
  `readAccountAuthorizations`, `identityStore.ts:444-484`).
- Epoch bump must be the same transaction as the downgrade. Extend
  `changeAccountAuthorization` (`sessionStore.ts:653-700`) with a
  `bumpAuthorizationEpoch(db, accountId, audit)` that advances the epoch,
  revokes sessions, and writes audit — the existing body already does exactly
  that. Sessions fail closed on epoch mismatch (`isActiveAt`,
  `sessionStore.ts:166-175`), and open room sockets are closed by the room
  alarm (`RoomDO.ts:2038-2109`, test `roomDO.workers.test.ts:1471-1500`).
- Erasure: `eraseOwnAccount` pseudonymizes identifiers rather than deleting
  (`sessionStore.ts:601-636`). Billing rows must follow the same rule; pay
  invoice subtotal/ tax records conflict with erasure duties — document which
  wins (SEC-015 `:898-901`, SEC-016).
- Data export (`exportOwnAccountData`, `sessionStore.ts:487-535`) must gain
  entitlement + referral rows for subject-access requests.

## Referral design

Stripe has no native referral program; the standard pattern is a local
code -> redemption ledger plus Stripe metadata for attribution
([TrackRev attribution guide](https://www.trackrev.io/blog/stripe-checkout-attribution-tracking),
accessed 2026-09-11; [Traaaction affiliate guide](https://www.traaaction.com/blog/stripe-affiliate-tracking),
accessed 2026-09-11).

1. **Code**: generated server-side from `crypto.getRandomValues` (no
   sequential or guessable codes; extend `randomId.ts:9-13`), stored in
   `referral_codes`. One live code per account.
2. **Link**: `https://<marketing-host>/?ref=CODE`. The public page stores it in
   a first-party `SameSite=Lax` cookie (and passes it into the sign-in
   redirect); the app reads the cookie when it creates the Checkout session —
   never trust a client-sent code at webhook time.
3. **Attribution through Checkout** (all server-set; no client amounts):
   - `client_reference_id`: the local `account_id` (opaque UUID, fits the
     200-char limit).
   - `metadata.referrer_code` and `subscription_data.metadata.referrer_code`
     so renewals keep the referrer (session-only metadata does not survive
     renewals).
   - `discounts: [{ promotion_code: promo_... }]`, where the local code maps to
     a Stripe promotion code optionally mirrored on a coupon. Local ledger is
     authoritative; the Stripe code exists so Checkout applies the discount
     without custom pricing.
4. **Counting**: "how many people used my referral" =
   `COUNT(DISTINCT referred_account_id)` over `kind='redemption'` minus
   `reversal`s. Insert the redemption from `checkout.session.completed` when
   the session carries `discounts[].promotion_code` or
   `metadata.referrer_code`, keyed `UNIQUE` on the session id; renewals from
   `invoice.paid` via subscription metadata are optional and can be recorded
   as `kind='renewal'` for revenue credit, not for the count.
5. **Fraud/abuse controls**:
   - Self-referral: reject when referred account == code owner; also compare
     the Stripe `customer` id with the owner's customer id.
   - One redemption per customer: partial unique index above +
     `restrictions.first_time_transaction=true` +
     `max_redemptions`/`customer` restrictions on the promotion code
     ([Promotion code object](https://docs.stripe.com/api/promotion_codes/create),
     accessed 2026-09-11).
   - Caps + expiry: `max_redemptions`, `expires_at`; per-owner creation
     rate-limit and a cap on live codes.
   - Hold period (e.g., 14-30 days / first successful renewal) before a
     redemption counts as "successful"; only `invoice.paid` moves it out of
     pending (**Assumption**: length is a product choice).
   - Reconcile reversals: `charge.refunded`, `charge.dispute.created`, and
     referral-subscription cancellation inside the hold mark the event
     reversed; UI shows gross and net counts.
   - Code lookup is rate-limited; wrong/unknown codes fail silently (no
     existence oracle).

## Corporate seat design

- **Stripe Customer = the company; seats = the per-unit corporate price
  `quantity` on the subscription item.**
- **Invoice-first cannot go through Checkout**: Checkout subscription mode
  always creates `collection_method=charge_automatically`, and there is no way
  to create a `send_invoice` subscription directly through Checkout
  ([Stripe invoices/subscriptions](https://docs.stripe.com/billing/invoices/subscription),
  [StackOverflow answer](https://stackoverflow.com/questions/73296157/stripe-subscription-renewal-emailing-the-invoice-instead-of-automatic-charging),
  accessed 2026-09-11). Recommended flow, hosted and server-built:
  1. Teacher opens "Corporate" in profile; server creates the Customer
     (`automatic_tax[enabled]`, name/address; tax id collected via a form or
     later via the Customer Portal) and the Subscription
     (`collection_method=send_invoice`, `days_until_due=30`,
     `automatic_tax[enabled]=true`, `items=[{price: corporate_price,
     quantity: n}]`). `send_invoice` subscriptions are active immediately
     regardless of the first invoice ([Create a subscription](https://docs.stripe.com/api/subscriptions/create),
     accessed 2026-09-11) — grant seats on `status=active`, dunning handles
     non-payment.
  2. Host the `hosted_invoice_url` in the profile; Stripe emails the invoice.
     Card-first corporate is also possible: Checkout subscription mode with
     `tax_id_collection[enabled]=true`, `customer_update[name]=auto`,
     `automatic_tax[enabled]=true` ([Collect tax IDs with Checkout](https://docs.stripe.com/tax/checkout/tax-ids),
     accessed 2026-09-11), then optionally switch the subscription to
     `send_invoice` for future renewals.
- **Seats map to member accounts**: a `company_members` row per tutor account;
  active members must never exceed `company_subscriptions.quantity`. Adding a
  member updates the subscription `quantity`; `proration_behavior` defaults to
  `create_prorations` (invoice-first: proration lands on the next invoice),
  `always_invoice` for card-first ([Update a subscription](https://docs.stripe.com/api/subscriptions/update),
  accessed 2026-09-11). Stripe warns that frequent quantity updates can rate
  limit, so bound seat changes per company per hour.
- **No cross-company sharing**: `companies.processor_customer_id UNIQUE`,
  `company_subscriptions.processor_subscription_id UNIQUE`, and the partial
  unique index allowing **one active company per account**. A member's
  entitlement is always derived from `(company_id, active membership)`;
  no client or admin path can attach account B to company A's subscription
  without writing the membership row and audit entry.
- **Seat revocation**: `company_members.state='revoked'`; recompute that
  account's entitlement to Free (or their personal plan); `bumpAuthorizationEpoch`
  for **that account only** in the same transaction -> its sessions fail
  (`sessionStore.ts:166-175`) and its open rooms close on the next room alarm
  (`RoomDO.ts:2038`). Then decrement Stripe `quantity` with an idempotency key
  and let the daily reconciliation repair a failed call. Other members are
  untouched because only one `accounts` row changes.
- **Entitlement subject vs SEC-015**: SEC-015 keys entitlement by `account_id`
  (`security.md:872-875`); company membership is an additional source that
  materializes a per-account `entitlements` row with `source='company'`. This
  is a **contract amendment**: SEC-015 currently says the tutor market has "no
  seat pools ... no district billing" (`security.md:959-961`) and Phase 7 says
  the decision "removes seat counting from the data model entirely"
  (`security.md:1474-1478`). Corporate per-seat billing contradicts those
  sentences and must be recorded as an owner-approved amendment before code.

## Local/staging setup

- **Secrets**: `STRIPE_SECRET_KEY` (`sk_test_...` locally, `sk_live_...`
  prod), `STRIPE_WEBHOOK_SECRET` — different per mode and per endpoint.
  Create with `npx wrangler secret put ...` (pattern `DEPLOY.md:113-124`); put
  local values in `.dev.vars` (gitignored; `README.md:91-109`). Never in
  `[vars]`, code, logs, or the client bundle (`security.md:931-932`).
- **Price ids** are not secrets but are environment-specific: put
  `STRIPE_PRICE_TUTOR_PRO_MONTHLY`, `..._ANNUAL`, `..._CORPORATE_SEAT` in
  `[vars]` per environment and keep the plan -> price mapping in the
  server-side catalog (`security.md:992-996`). **Assumption**: owner creates
  the products/prices in the Stripe Dashboard; no price/amount ever comes from
  the client.
- **Local webhooks**: run `npx wrangler dev` (default `localhost:8787`) with
  `wrangler.local.toml` + the local Access issuer used by
  `scripts/dev-local.mjs` / `scripts/run-worker-tests.mjs`, then
  `stripe listen --forward-to http://localhost:8787/api/billing/webhook
  --events checkout.session.completed,customer.subscription.created,...`.
  The CLI prints a session `whsec_` to copy into `.dev.vars`; it stays stable
  across `listen` restarts ([Stripe CLI](https://docs.stripe.com/cli/webhooks),
  accessed 2026-09-11). `stripe trigger checkout.session.completed` creates
  real test objects; Test Clocks can fast-forward renewals.
- **Reconciliation**: daily trigger. Either a Worker `scheduled` handler with
  `[triggers] crons = [...]` (`src/worker.ts` currently exports only `fetch`,
  `worker.ts:902-1427`) or an `IdentityDO` alarm (SEC-015 says "daily alarm",
  `security.md:1033-1035`). Walk stored customer ids, `GET
  /v1/subscriptions?customer=...`, compare status/quantity/period, apply drift
  through the same audited path, and alert on any drift. Cloudflare budgets are
  ample: Workers Paid allows 10,000 subrequests (raised from 1,000 in Feb 2026)
  and 30s CPU default (5 min max); DO alarms have a 15-minute wall limit
  ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
  [subrequest changelog](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/),
  [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
  accessed 2026-09-11). **Assumption**: production is on the paid plan; the
  Free plan's 50 external subrequests and 10 ms CPU cannot run reconciliation.
- **Failure alerting**: enable Stripe's webhook failure notifications in
  Workbench (email/alerts), keep `[observability]` on
  (`wrangler.toml:45-46`), log event id + outcome (never payloads),
  alert on `outcome='failed'` and on reconciliation drift. If webhooks stop,
  the daily sweep bounds the disagreement; `GET /v1/events` is the manual
  backfill for a longer outage.

## TDD test plan

Red first, real objects only (`AGENTS.md:48-74`); one behavior per cycle.

1. **Verifier unit tests** — `src/lib/billing/stripeSignature.test.ts`
   (Node 22 has Web Crypto; precedent `livekitToken.test.ts`,
   `accessVerifier.test.ts`). Build payloads and sign them in-test with a known
   secret using `crypto.subtle` — no mocks. Cases: valid `t.v1`; tampered body;
   wrong secret; timestamp > 300s old; future timestamp; missing/empty `v1`;
   multiple `v1` where one matches; two rotated secrets where only the second
   matches; malformed header; wrong scheme (`v0` only).
2. **IdentityDO worker tests** — new `src/do/billing.workers.test.ts`
   (pattern: `identityDO.workers.test.ts` result checks, direct stub `fetch`).
   Cases: completed session binds ids and sets `active`; duplicate `event_id`
   applies once; stale `event.created` ignored; test-mode event rejected in
   live config; `customer.subscription.deleted` downgrades and the account's
   existing session fails validation; `invoice.payment_failed` sets
   `past_due`, `invoice.paid` recovers; chargeback cancels without grace;
   company member limit cannot exceed quantity; revoking one seat bumps only
   that account's epoch; referral self-redemption rejected; second redemption
   for the same referred account rejected; duplicate session id counted once.
3. **Worker-route worker tests** — new `src/worker.billing.workers.test.ts`.
   Cases: unsigned webhook → 400 and no state change; valid signed webhook
   applies; wrong method → 405; body over cap → 413; no `Origin` is accepted
   **only** on the webhook path while another `/api/` POST without `Origin` is
   still 403; checkout route requires a session and ignores a client-supplied
   price id; returns 503 when `STRIPE_*` is unset (LiveKit pattern,
   `parseLiveKitConfig`, `livekitToken.ts:175-182`); guest/student session can
   never reach a billing route.
4. **E2E** — new `tests/e2e/billing-funnel.spec.ts` through
   `npm run test:e2e` (`scripts/run-e2e.mjs`; no invented config,
   `AGENTS.md:44-46`). Drives the real browser + local Worker with real signed
   webhook payloads (no Stripe network, skipped when `STRIPE_*` is absent,
   like the LiveKit probe in `livekitConfigured`, `tests/e2e/helpers.ts:197-208`):
   pricing page shows Free + Tutor Pro + Corporate; signed-in teacher's
   checkout action hits the server route; a forged webhook changes nothing; a
   valid webhook upgrades the account and the previously 402'd second room now
   succeeds; a revocation webhook restores the Free cap; the profile shows the
   plan; guest/student never sees billing. Real Stripe test-mode checkout is a
   manual/staging checklist, not CI.
5. **Mutation step** (`AGENTS.md:101-128`): for each new guard, invert one
   check and confirm the named test fails — e.g. drop the 300s timestamp
   check (verifier test must fail), change `changes() > 0` dedupe handling
   (duplicate-event test must fail), remove the epoch bump on cancellation
   (session-invalidation test must fail). Record file/line, change, and the
   failing test; revert and re-run green.

## Risks & open questions

1. **SEC-015 conflict (owner decision)**: corporate per-seat billing
   contradicts "no seat pools ... no district billing"
   (`security.md:959-961`) and "removes seat counting from the data model"
   (`security.md:1474-1478`). Amend SEC-015 explicitly before implementation.
2. **Invoice-first vs Checkout**: Checkout cannot create `send_invoice`
   subscriptions; corporate needs API-created subscriptions + hosted invoice
   pages. Confirm the flow and who collects company name/tax id.
3. **Access bypass**: Stripe must reach the webhook path through the
   Cloudflare Access application that covers the teacher host; a path-scoped
   Bypass policy (or separate unproxied hostname) is external configuration
   and a security review item.
4. **Plan catalog mismatch**: `FREE_MAX_ROOMS = 1`, `FREE_MAX_USERS = 2`
   (`src/lib/plan/limits.ts:7-9`) vs SEC-015's proposed Free of 2 rooms /
   2 students / 3 participants (`security.md:981-984`). Prices, trial length,
   and final limits are still open (`security.md:1474-1478`).
5. **Students/company membership**: are corporate "seats" tutor-only? Students
   must remain unbillable (`security.md:895-897`, SEC-016). Define whether a
   seat can host multiple student rooms.
6. **Tax/VAT**: reverse charge, Stripe Tax registrations, and invoice
   retention are legal tasks; `security.md` requires documenting the conflict
   with erasure (`security.md:898-901`).
7. **Referral economics**: discount type/duration, cap per owner, hold period,
   and whether renewals earn anything are product decisions. Stripe only
   allows one discount per Checkout session (**Assumption**: verify before
   code; stacking is not available).
8. **Referral attribute source**: `session.discounts[].promotion_code` shape
   should be validated with `stripe listen` before the schema is fixed.
9. **Direct REST vs stripe-node**: recommendation above; if events grow,
   reconsider the SDK and pin `Stripe-Version`.
10. **API version pinning**: pin `Stripe-Version` for every call and keep
    webhook endpoint versions consistent; the Basil period-field move
    (`items.data[].current_period_end`) is the known trap.
11. **Reconciliation on Free plan** is impossible (10 ms CPU, 50 external
    subrequests); confirm the Workers plan before promising the drift alert.
12. **Erasure vs billing retention**: audit/ledger pseudonymization vs Stripe
    invoices; decide the period and document it (SEC-016).
13. **Touchpoint cost**: corporate seat changes can rate-limit if driven in
    bulk; bound changes and rely on reconciliation.

## Sources

Repo (read 2026-09-11):

- `AGENTS.md:11,44-46,48-74,101-128`; `security.md:848-1073,1474-1478`
  (SEC-015 contract, proposals, acceptance tests); `security.md:747-846`
  (SEC-016); `wrangler.toml:10-11,45-46,61-97`; `wrangler.local.toml:6-7`;
  `src/worker.ts:53-75,263-270,902-1001,1289-1296`; `requestGuard.ts:64-198,
  212-223,238,328-337,360-388`; `livekitToken.ts:49-62,175-198`;
  `accessVerifier.ts:238-257,295-313`; `IdentityDO.ts:74,315-322,324-691`;
  `identityStore.ts:40-228,444-484`; `sessionStore.ts:166-175,487-535,
  601-636,653-700`; `doDatabase.ts:21-23`; `RoomDO.ts:1844-1845,2038-2109`;
  `roomDO.workers.test.ts:1471-1500`; `plan/limits.ts:7-9`;
  `crypto/randomId.ts:9-13`; `DEPLOY.md:113-124`; `README.md:91-109`;
  `.gitignore` (`.dev.vars*`); `.github/workflows/ci.yml`.

External (all accessed 2026-09-11):

- Stripe webhooks (raw body, signatures, retries, dedupe):
  https://docs.stripe.com/webhooks and
  https://docs.stripe.com/webhooks/signatures
- Stripe webhook versioning (Basil period fields):
  https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
- Subscription object / statuses:
  https://docs.stripe.com/api/subscriptions/object
- Update a subscription (proration, quantity rate limits):
  https://docs.stripe.com/api/subscriptions/update
- Checkout Session create / object (mode, metadata, discounts, tax id):
  https://docs.stripe.com/api/checkout/sessions/create and
  https://docs.stripe.com/api/checkout/sessions/object
- Tax IDs with Checkout: https://docs.stripe.com/tax/checkout/tax-ids
- Collection method: https://docs.stripe.com/billing/collection-method and
  https://docs.stripe.com/billing/invoices/subscription
- Subscription invoices + Checkout limitation:
  https://stackoverflow.com/questions/73296157/stripe-subscription-renewal-emailing-the-invoice-instead-of-automatic-charging
- Customer Portal configuration:
  https://docs.stripe.com/customer-management/configure-portal
- Promotion codes: https://docs.stripe.com/api/promotion_codes/create and
  https://docs.stripe.com/billing/subscriptions/coupons
- Idempotent requests: https://docs.stripe.com/api/idempotent_requests
- Stripe CLI webhooks: https://docs.stripe.com/cli/webhooks
- Stripe node on Workers:
  https://github.com/stripe-samples/stripe-node-cloudflare-worker-template,
  https://github.com/stripe/stripe-node/pull/2685,
  https://jross.me/verifying-stripe-webhook-signatures-cloudflare-workers/,
  https://bree-sharp.com/articles/stripe-webhook-cloudflare-worker-no-sdk/,
  https://chanmeng.org/blog/stripe-cloudflare-workers-integration
- Cloudflare limits: https://developers.cloudflare.com/workers/platform/limits/,
  https://developers.cloudflare.com/durable-objects/platform/limits/,
  https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/,
  https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- Webhook reliability practice:
  https://apiscout.dev/guides/stripe-webhooks-complete-guide-2026,
  https://cesarayala.dev/blog/stripe-webhooks-out-of-order-subscription-bug/,
  https://www.snowinch.com/en/blog/stripe-webhook-idempotency-duplicates
- Attribution/referral patterns:
  https://www.trackrev.io/blog/stripe-checkout-attribution-tracking,
  https://www.traaaction.com/blog/stripe-affiliate-tracking,
  https://refgrow.com/docs/stripe
