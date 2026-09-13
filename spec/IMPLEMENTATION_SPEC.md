# Implementation Spec — Personal & Corporate Accounts, Pricing, Referrals & Stripe Billing

Status: **DRAFT v5.3 — owner decisions D1–D12 answered 2026-09-11 (§2.1).
Phases 0–3 complete and Phases 4–6 implemented on the local evidence layers
2026-09-12, with the Phase 7 R-1 core done (§12). Key commits: `75dd59e`
(docs), `15fe06e` (plan), `1bc6006`/`64fd1b8` (billing pipeline),
`546dcdc`/`e0a379f`, `76376af`, `b54440e`, `e378414`/`7efeb05`/`cd67bac`
(Phase 3, verified), `4e885cc`/`7105284` (routes, executor, hardening),
`8ed04bd`/`ce680b1` (company, referrals, pricing; verified), `7a2651a`
(reconcile; verified). Every §14 staging clause stays blocked until staging
exists and a staging-backed verifier APPROVEs.**
Date: 2026-09-11. v1 merged five investigator reports in `spec/findings/`;
v2–v4 and the v4 addendum folded three independent reviews and the dispute
follow-up into the body; v5 resolves the fourth review (F1–F7, §17.2) and
consolidates every billing/membership transition into one authoritative table
(§3.7); v5.1 closes the fifth review's dispute, collection-ordering, and
local-evidence gaps (G1–G4, §17.3); v5.2 records the owner's answers (§2.1)
and adds the tutor account cap chosen for D10 (§3.9); v5.3 closes four
collection-recovery gaps (H1–H4, §17.4). Where any other section disagrees with §3.7, §3.7 wins and the other
section is a defect.

Evidence convention: repo claims cite `path:line`; market claims cite the URL
lists in `spec/findings/03-market-corporate-pricing.md` and
`spec/findings/04-stripe-subscriptions-referrals.md` (accessed 2026-09-11).
Statements marked **[assumption]** are proposals. This document changes no
runtime behavior. Implementation is governed by `AGENTS.md`: strict TDD
(red → green → refactor), real objects only, targeted mutation tests for every
new guard, e2e for browser/HTTP/session work.

Tooling note: `git` is installed at `C:\Program Files\Git\cmd\git.exe`; it may
not be on a shell's `PATH`. This repo is on `main`; `spec/` is untracked.

---

## 1. Goals, scope, non-goals

### 1.1 Goals

1. **Personal accounts (exists) and corporate accounts (new).** Every tutor
   account works standalone; a tutor may additionally belong to one company
   (agency/firm/co-op). A company buys **tutor seats** at volume pricing and
   manages who holds them.
2. **Corporate pricing.** Publish a personal price and per-seat corporate bands
   on a rebuilt `/pricing` page, with server-enforced limits from a code-owned
   plan catalog.
3. **Referrals.** Any paid tutor can share a referral link; the server counts
   distinct accounts that redeemed it, from processor events, and shows the
   count in the profile.
4. **Stripe integration.** Hosted Checkout + Customer Portal for personal;
   self-serve card Checkout for small corporate; approval-gated invoice-first
   subscription for larger corporate. No card data in the app (SAQ-A).
5. **Subscription management in the profile.** A plan section in the existing
   `UserProfileMenu` shows the effective plan/company and links out to
   server-issued Checkout/Portal/invoice URLs.

### 1.2 Non-goals

- **Not a school product.** No student seats, rosters, LMS/SSO, district
  billing, or admin control over rooms/content. Corporate manages only company
  profile, seats, and billing.
- Students and guests are never billable, never see billing, company, or
  referral UI, and never have billing identity stored.
- No dynamic price/amount in any URL or client input; no price fetching on
  marketing pages; no card fields anywhere in the app.
- The SEC-015 distinct-student meter and other roadmap items are separate
  workstreams; room admission reads the owner's effective plan (§4.3).

### 1.3 Current state (verified recon)

- Identity: one global `IdentityDO` with SQLite tables `accounts`,
  `access_subjects`, `sessions`, `authorization_audit`, `account_rooms`,
  `pending_erasures` (`src/lib/identity/identityStore.ts:40-228`). Account ids
  are opaque UUIDs; no emails are stored (`identityStore.ts:343-397`).
- DO transactions are synchronous (`src/lib/whiteboard/doDatabase.ts:21-23`,
  `storage.transactionSync`): no network call can run inside one.
- Erasure disables the account row rather than deleting it
  (`src/lib/identity/sessionStore.ts:601-636`), so `ON DELETE` clauses never
  fire for accounts; erasure code must clean up explicitly.
- Plans: every account is Free — 1 owned room, host + 1 student
  (`src/lib/plan/limits.ts:7-23`); paid tiers in `security.md` SEC-015 are
  designed but unbuilt (`security.md:848-1073`).
- No Stripe code and no referral code exists (grep over the tree), so there is
  no pre-existing billing data to migrate.
- Pricing page: static `public/pricing.html`; marketing routes are exactly
  `['/', '/pricing', '/terms', '/privacy']` (`requestGuard.ts:352`).
- Students have a non-Access join path today: the guest hostname has **no**
  Access application (`DEPLOY.md:33-45`, `wrangler.toml:21-25`). See D10.
- Revocation: `sessionAuthorized` calls `/sessions/authorize` on **every**
  authenticated API request (`src/worker.ts:379-402`); the RoomDO alarm calls
  `POST /accounts/authorizations` every 30 s and closes sockets on epoch/state
  mismatch (`RoomDO.ts:2126-2194`). The alarm's session check reads
  `idle_expires_at` (`sessionStore.ts:340-347`); only HTTP `validateSession`
  refreshes it (`sessionStore.ts:375-386`).
- Test harness facts: worker tests seed real Durable Object state with
  `runInDurableObject` (used throughout `src/do/*.workers.test.ts`); local e2e
  runs a real `wrangler dev` behind a local Access issuer/proxy with no
  state-seeding route (`scripts/run-e2e.mjs:231-252`). A staging environment is
  specified (`CLOUDFLARE_ACCESS_STAGING.md`) but not yet provisioned
  (`CLOUDFLARE_ACCESS_STAGING.md:114-126`).
- Identity migrations are append-only: `CREATE TABLE IF NOT EXISTS` + triggers;
  `authorization_audit.action` is a closed CHECK (`identityStore.ts:166-167`)
  and must not be rebuilt.

---

## 2. Owner decisions required (implementation gate)

The rows below are the options as they were put to the owner. §2.1 records the
answers; where the two differ, §2.1 is authoritative.

| # | Decision | Recommendation |
| --- | --- | --- |
| **D1** | **Amend SEC-015.** Target-market lines (`security.md:953-961,988-990`), seat counting (`:1474-1483`), entitlement model (`:1000-1009`), downgrade propagation (`:886-889`), Free-tier residuals (`:923`), billing acceptance text (`:937-944`), audit table (`:1072-1073`). | Amend in full, as drafted in §5.2. Still no school/student seats, rosters, LMS/SSO, district billing, or control over rooms/content; corporate is a tutor seat/billing group. |
| **D2** | **Entitlement keying.** SEC-015 says PK `account_id`, one row, every write bumps the epoch, audit in `authorization_audit`. | Amend SEC-015: `entitlements` PK `(account_id, source)`; entitlement writes do not bump epochs (live-lesson rule, `security.md:919-921`); every entitlement write goes through one writer (§3.3) and is audited in `entitlement_audit` exactly once per cause. Account-level revocation still bumps the epoch. |
| **D3** | **Free tier truth.** Code + live page: 1 room, host + 1 student, 90-day retention (`limits.ts:7-9`, `roomSchema.ts:4`). SEC-015 says 2 students / 2 rooms / 3 participants / 7 days (`security.md:979-986`, `:923`). | Free = code truth; amend `:979-986` and `:923`. Distinct-student metering stays a separate workstream. |
| **D4** | **Prices, currency, tax display.** | GBP: Tutor Pro £9.99/mo or £95/yr; corporate per seat 3–9 £7.50, 10–24 £6.50, 25–99 £5.50, 100+ quote; annual, min 3 seats. Stripe prices `tax_behavior=exclusive`; page says "ex VAT"; Stripe Tax computes VAT. |
| **D5** | **Corporate billing motion.** | Billing/seat group only. 3–9 seats self-serve card via Checkout; 10+ invoice-first only after operator approval (D11). Seat changes follow §3.2. Company entitlement never materializes before first payment. |
| **D6** | **Companies per account.** | One active company per account in v1 (partial unique index). |
| **D7** | **Revoke blast radius.** | Entitlement changes never bump the epoch and never close an in-progress lesson. Access revocation (account disable, revoke-all, operator fraud action) keeps the existing epoch mechanism. |
| **D8** | **Company disable and erasure.** | Disable revokes all seats and stops billing; never cascades into rooms/boards. Owner erasure transfers ownership or disables. Referral rows of the erased account are deleted and the referrer's count drops. |
| **D9** | **Referral rewards.** | v1: code + link + server redemption count. v1.1: invitee first month free (annual only); referrer one month credit on the first invoice with `amount_paid > 0`, 30-day clawback, max 6/12 months; one referrer per account, ever. |
| **D10** | **Access economics.** The 50-user free limit is per Cloudflare Zero Trust organization (the account), shared by every tutor in every company. | Verify which path students actually use, then cost Access account-wide before each corporate scale-up. |
| **D11** | **Operator mechanism.** | Env-allowlisted operator route or script, audited in `entitlement_audit`, never reachable from self-serve. Used for invoice approval and dispute review (§3.7 O-1, O-2). |
| **D12** | **Dispute billing policy.** On `charge.dispute.created` Stripe keeps billing unless we act. Options: (a) suspend — pause collection and entitlement while any dispute on the subscription is open or under review, resume only when none remains, cancel on any `lost`; (b) cancel the subscription immediately; (c) suspend entitlement and queue an operator decision with no automatic Stripe action. | (a). Verify before code (Phase 0) that `pause_collection` exists on the pinned `Stripe-Version` and that the Customer Portal cannot un-pause a disputed subscription; if either fails, fall back to (c). §3.7 rows D-1…D-6 are written for (a) and name what changes under (b)/(c). |

### 2.1 Owner answers (2026-09-11)

| # | Answer | Consequence for this spec |
| --- | --- | --- |
| D1 | Amend SEC-015 as drafted. | Apply §5.2 items 1–7 to `security.md` in Phase 0. |
| D2 | Per-source entitlements, no epoch bump, `entitlement_audit`. | As written (§3.3, §3.5). |
| D3 | Free = 1 owned room, host + 1 student, 90-day retention. | As written; SEC-015's table is amended by §5.2 item 5. |
| D4 | Proposed GBP ex-VAT prices. | §4.2 is final copy for Phase 6. |
| D5 | Card via Checkout for 3–9 seats; Stripe invoice for 10+ after operator approval; members entitled only once the first invoice is paid. | As written (§3.7 C-3, C-4). The owner confirmed after clarification that Stripe issues and collects the invoice. |
| D6 | One active company per account. | As written. |
| D7 | Lesson continues; downgrade applies at the next boundary. | As written (§3.1, §5.2 item 7). |
| D8 | Transfer ownership, or disable when the owner is the sole member. | As written (§3.7 E-1, E-2, C-13). |
| D9 | Referral count in v1; two-sided rewards in v1.1. | As written (§9). |
| D10 | **Cap tutors at 50 for now** — differs from the recommendation. | New §3.9: an enforced tutor account cap; lifting it requires re-costing Access. |
| D11 | Env-allowlisted operator route or script, audited. | As written (§3.7 O-1, O-2). |
| D12 | Suspend: pause collection, resume when no dispute holds, cancel on `lost`. | As written (§3.7 D-1…D-6), still subject to the Phase 0 Stripe check with fallback to option (c). |

---

## 3. Domain model

### 3.1 Effective plan (resolver)

- No tutor/student kind exists in `accounts` (`identityStore.ts:43-57`).
  Company membership requires `provenance='access'` (trigger). Student
  exclusion is route + membership gating.
- `src/lib/plan/effectivePlan.ts` (pure) takes the account's `entitlements`
  rows and the boundary's `now`. A row is **entitling** iff
  `collection_paused = 0` and either
  - `status IN ('trialing','active')`, or
  - `status = 'past_due' AND now < grace_until`.

  `canceled`, `free`, a paused row (dispute hold or Stripe `pause_collection`),
  and `past_due` at or after `grace_until` never entitle. An entitling
  `company` row wins over an entitling `personal` row; with none, the plan is
  Free.
- **Boundary-time enforcement (F3).** The resolver runs with the request's
  `now` at every boundary: `/auth/session/current`, `GET /accounts/plan`, room
  create/settings, owned-room reservation, waiting-queue cap, RoomDO admission,
  and billing routes. Grace expiry therefore takes effect at the first boundary
  after `grace_until` with no background job; the daily sweep (§7.5) only
  records the audit row.
- Entitlement changes never bump the authorization epoch (D7). An
  already-open lesson keeps its admitted participants until its session ends
  (§5.2 item 7).

### 3.2 Company, ownership, and seats

**Bootstrap (F7).** `POST /api/company` runs one IdentityDO transaction:
validate the session; the caller must be an Access account (trigger) with no
active membership (the one-active index fails → 409); insert `companies`;
insert the caller's `company_members` row as `owner`/`active`; write audit;
run the owner assertion. No `company_subscriptions` row exists yet. The Stripe
Customer is created **after** that transaction as outbound operation
`company-create` (§7.2) and written back in a second transaction; if Stripe
fails, the company exists without a customer and the owner retries with the
same `operationId`.

**Exactly one owner (F7).** The partial unique index
`company_members_one_owner` guarantees *at most* one active owner. *At least*
one is guaranteed by `assertOneActiveOwner(db, companyId)`, the last statement
of every transaction that writes `company_members` or `companies.state`: an
`active` company with ≠ 1 active owner throws, and the transaction rolls back.
A disabled company has no active members. The owner cannot be revoked (409);
ownership moves only by transfer (demote the old owner, then promote the new
one, in one transaction), by company disable, or by owner erasure. A trigger
cannot express this rule: SQLite checks constraints row by row, so a
"never zero owners" trigger would reject the demote step of a legal transfer.

**Capacity.** `seatCapacity(company)`:

- no `company_subscriptions` row → **1** (the owner's own seat; no invite can
  be redeemed yet);
- otherwise `MIN(quantity, COALESCE(pending_quantity, quantity))`.

The owner occupies a seat. Every membership activation (invite redemption)
checks `active_members + 1 <= seatCapacity` **in the same transaction** as the
insert; otherwise 402. IdentityDO is single-threaded and its transactions are
synchronous, so check and insert cannot interleave with another write.

**Seat changes are two-phase reservations (F4).** Only the owner may change
seats; at most one change is pending per company.

1. **Reserve** (transaction). Refuse 409 if a change is already pending. For
   a decrease, refuse 409 if the target is below the active member count.
   Record `pending_quantity`, `pending_operation_id`, and a `pending`
   `billing_operations` row. From this commit on, capacity is
   `MIN(quantity, pending_quantity)`: a pending decrease blocks redemptions
   above the target immediately; a pending increase grants nothing until it
   commits.
2. **Call Stripe** (outside any transaction): subscription item quantity
   update with idempotency key `op:company:<company_id>:<operation_id>`.
   Increases use `create_prorations`; decreases use `proration_behavior=none`.
3. **Settle** (transaction):
   - success → `quantity = pending_quantity`, clear pending, operation
     `succeeded`, audit;
   - definitive failure (Stripe 4xx) → clear pending, operation `failed`,
     audit; capacity returns to `quantity`;
   - unknown outcome (timeout, 5xx, network) → keep pending; the route returns
     202 `{status:'pending'}`.
4. **Recover** a pending change: a `customer.subscription.updated` whose
   fetched quantity equals `pending_quantity` settles it as success. The daily
   reconcile retries the same Stripe call with the same idempotency key while
   inside Stripe's 24 h idempotency window; after that it fetches the
   subscription and settles: fetched = `pending_quantity` → success; fetched =
   `quantity` → failed; anything else → apply the fetched quantity as drift,
   clear pending, alert.

Nobody is ever evicted. If Stripe reports a quantity below the active member
count (dashboard edit, drift), it is applied, redemptions are refused until
members fit, and an alert fires. The Customer Portal configuration used for
company customers disables quantity changes.

**Invites.** Owner/admin mints a single-use token (72 h TTL; only the SHA-256
hash is stored; shown once). The token travels in a URL fragment
(`/account/company#invite=<token>`), is read client-side, and is POSTed.
Owner/admin can revoke an unredeemed invite. A redeemed or revoked invite can
never be redeemed again, including after the redeemer's erasure (§3.8).

### 3.3 The entitlement writer (F2)

`src/lib/identity/entitlementWriter.ts` (new) is the **only** code that writes
`entitlements`, `billing_subscriptions`, `billing_dispute_holds`, and the
billing-state columns of
`company_subscriptions` (`status`, `grace_until`, `first_paid_at`,
`current_period_end`, `collection_paused`). It never opens its own transaction
and never calls the network: every caller invokes it inside the caller's
IdentityDO transaction, so the entitlement change commits or rolls back
together with the change that caused it (membership row, event row, seat
settlement, reconcile marker, operator action, erasure).

Each call names a **cause**:

| `cause_kind` | `cause_id` | Actor |
| --- | --- | --- |
| `processor_event` | Stripe event id | `stripe` |
| `membership` | invite hash (redeem) or server-generated change id (revoke, transfer, disable) | acting owner/admin account id |
| `seat_operation` | `billing_operations.operation_id` | owner account id |
| `reconcile` | reconcile run id | `system:reconcile` |
| `grace_expiry` | `<processor_subscription_id>:<grace_until>` | `system:grace` |
| `operator` | operator action id | operator name (D11) |
| `erasure` | server-generated erasure id | erasure pseudonym |

**Audit semantics.** Each call writes one `entitlement_audit` row per affected
`(subject_kind, subject_id)` whose state actually changed, with before/after
plan and status. `UNIQUE(subject_kind, subject_id, cause_kind, cause_id)`
makes the row exactly-once per cause, whether or not a processor event id
exists; `processor_event_id` is filled only for `processor_event` causes. A
call that changes nothing writes nothing.

A static unit test reads every file under `src/` (the `readFileSync` pattern of
`src/deployment/brandCss.test.ts:10-12`) and fails if any file other than
`entitlementWriter.ts` contains an `INSERT`, `UPDATE`, or `DELETE` against the
writer-owned tables.

### 3.4 Referral ledger

- One live code per account; random, case-insensitive.
- Redemption uniqueness is per referred account, ever:
  `UNIQUE(referred_account_id) WHERE kind='redemption'`.
- Confirmation requires the first invoice with `amount_paid > 0`; a £0
  promotional first invoice cannot confirm a referral.
- Referral writes are **effects** (§7.1 class 2): deduplicated by object and
  never discarded by subscription-state ordering.
- Count shown = distinct referred accounts with a redemption and no later
  reversal; pending and confirmed shown separately; server tally only.

### 3.5 Identity-store schema (proposed)

Appended to `applyIdentitySchema` (`identityStore.ts:40-228`) with its
conventions (append-only, CHECK, partial indexes, triggers). Table order is
dependency-safe.

```sql
CREATE TABLE IF NOT EXISTS companies (
  company_id TEXT PRIMARY KEY CHECK (length(company_id) BETWEEN 1 AND 128),
  processor_customer_id TEXT UNIQUE,        -- null until company-create op succeeds
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','disabled')),
  invoice_approved INTEGER NOT NULL DEFAULT 0 CHECK (invoice_approved IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

-- Written only by entitlementWriter (§3.3). A company row exists only while
-- the member is active and the company has paid (first_paid_at).
CREATE TABLE IF NOT EXISTS entitlements (
  account_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('personal','company')),
  plan_id TEXT NOT NULL CHECK (plan_id IN ('free','tutor_pro_monthly','tutor_pro_annual','corporate_seat')),
  status TEXT NOT NULL CHECK (status IN ('free','trialing','active','past_due','canceled')),
  grace_until INTEGER,
  collection_paused INTEGER NOT NULL DEFAULT 0 CHECK (collection_paused IN (0,1)),
  company_id TEXT,
  current_period_end INTEGER,
  processor_customer_id TEXT,
  processor_subscription_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, source),
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE RESTRICT,
  CHECK (source = 'personal' OR company_id IS NOT NULL),
  CHECK ((status = 'past_due') = (grace_until IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS company_members (
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  PRIMARY KEY (company_id, account_id)
);
-- One active company per account (D6). At most one active owner; "at least
-- one" is assertOneActiveOwner (§3.2), not an index.
CREATE UNIQUE INDEX IF NOT EXISTS company_members_one_active
  ON company_members(account_id) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS company_members_one_owner
  ON company_members(company_id) WHERE role = 'owner' AND state = 'active';

-- Consumption is redeemed_at (or revoked_at). redeemed_by may be cleared by
-- erasure without reopening the token (F6).
CREATE TABLE IF NOT EXISTS company_invites (
  invite_hash TEXT PRIMARY KEY
    CHECK (length(invite_hash) = 64 AND invite_hash NOT GLOB '*[^0-9a-f]*'),
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  created_by TEXT NOT NULL REFERENCES accounts(account_id),
  expires_at INTEGER NOT NULL,
  redeemed_by TEXT REFERENCES accounts(account_id),
  redeemed_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (redeemed_by IS NULL OR redeemed_at IS NOT NULL),
  CHECK (redeemed_at IS NULL OR revoked_at IS NULL)
);

-- Stripe projection for capacity, invoice links, and company billing state.
CREATE TABLE IF NOT EXISTS company_subscriptions (
  company_id TEXT PRIMARY KEY REFERENCES companies(company_id) ON DELETE CASCADE,
  processor_subscription_id TEXT NOT NULL UNIQUE,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  pending_quantity INTEGER CHECK (pending_quantity IS NULL OR pending_quantity >= 1),
  pending_operation_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','canceled','unpaid','paused','incomplete','incomplete_expired')),
  grace_until INTEGER,
  collection_paused INTEGER NOT NULL DEFAULT 0 CHECK (collection_paused IN (0,1)),
  collection_method TEXT NOT NULL
    CHECK (collection_method IN ('charge_automatically','send_invoice')),
  current_period_end INTEGER,
  first_paid_at INTEGER,                    -- null = members get no entitlement
  hosted_invoice_url TEXT,
  updated_at INTEGER NOT NULL,
  CHECK ((pending_quantity IS NULL) = (pending_operation_id IS NULL)),
  CHECK ((status = 'past_due') = (grace_until IS NOT NULL))
);

-- Event dedupe. The row and its effects commit together; a failed
-- transaction rolls both back, so a Stripe retry is never seen as a duplicate.
CREATE TABLE IF NOT EXISTS billing_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  livemode INTEGER NOT NULL CHECK (livemode IN (0,1)),
  event_created INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,               -- SHA-256 of raw body, audit only
  outcome TEXT NOT NULL CHECK (outcome IN ('applied','ignored')),
  outcome_detail TEXT,                      -- e.g. 'livemode_mismatch', 'unmapped_dispute'
  applied_at INTEGER NOT NULL
);

-- Class 1 ordering and desired collection state (F1, G3): keyed per
-- subscription, never per subject, so one subscription's cancel or dispute
-- never affects another subscription of the same account (e.g. a company seat).
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  processor_subscription_id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('account','company')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 128),
  last_state_event_created INTEGER NOT NULL DEFAULT 0,
  processor_canceled_at INTEGER,            -- absorbing: Stripe canceled is final
  desired_collection TEXT NOT NULL DEFAULT 'active'
    CHECK (desired_collection IN ('active','paused','canceled')),
  desired_version INTEGER NOT NULL DEFAULT 0 CHECK (desired_version >= 0),
  applied_version INTEGER NOT NULL DEFAULT 0
    CHECK (applied_version BETWEEN 0 AND desired_version),
  in_flight_version INTEGER
    CHECK (in_flight_version IS NULL OR in_flight_version BETWEEN 1 AND desired_version),
  in_flight_state TEXT
    CHECK (in_flight_state IS NULL OR in_flight_state IN ('active','paused','canceled')),
  in_flight_since INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK ((in_flight_version IS NULL) = (in_flight_since IS NULL)),
  CHECK ((in_flight_version IS NULL) = (in_flight_state IS NULL))
);

-- One row per dispute (G1, G2). State comes from the fetched dispute and only
-- moves forward; the first observation may already be terminal.
CREATE TABLE IF NOT EXISTS billing_dispute_holds (
  dispute_id TEXT PRIMARY KEY,
  processor_subscription_id TEXT NOT NULL
    REFERENCES billing_subscriptions(processor_subscription_id),
  state TEXT NOT NULL CHECK (state IN ('open','review','won','lost')),
  first_seen_at INTEGER NOT NULL,
  closed_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK ((state = 'open') = (closed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_dispute_holds_subscription
  ON billing_dispute_holds(processor_subscription_id, state);

-- Class 2 effects (F1): applied exactly once per object, in any order.
-- Disputes are not listed: their per-dispute forward-only upsert is
-- idempotent by itself.
CREATE TABLE IF NOT EXISTS billing_effects (
  effect_kind TEXT NOT NULL CHECK (effect_kind IN (
    'checkout_completed','invoice_paid','invoice_payment_failed','refund')),
  object_id TEXT NOT NULL,                  -- checkout session / invoice / dispute / refund id
  processor_event_id TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (effect_kind, object_id)
);

-- Watermark for windowed reconcile sweeps (disputes).
CREATE TABLE IF NOT EXISTS billing_sweeps (
  kind TEXT PRIMARY KEY CHECK (kind IN ('disputes')),
  last_swept_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Outbound idempotency, scoped to the subject: a stored result (e.g. a Portal
-- URL) is never replayed to another account/company.
CREATE TABLE IF NOT EXISTS billing_operations (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('account','company')),
  subject_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (kind IN (
    'checkout','portal','company-create','seat-change','invoice-approve',
    'referral-credit','subscription-collection')),
  request_hash TEXT NOT NULL,               -- SHA-256 of canonical parameters
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  stripe_object_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subject_kind, subject_id, operation_id)
);

-- Secondary charge -> subject map (primary is charge.customer, §7.1).
CREATE TABLE IF NOT EXISTS billing_payments (
  payment_intent_id TEXT PRIMARY KEY,
  charge_id TEXT,
  invoice_id TEXT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('account','company')),
  subject_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_payments_charge ON billing_payments(charge_id);

-- Append-only; separate from authorization_audit, whose action CHECK is closed
-- (identityStore.ts:166-167).
CREATE TABLE IF NOT EXISTS entitlement_audit (
  audit_id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('account','company')),
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL,
  cause_kind TEXT NOT NULL CHECK (cause_kind IN (
    'processor_event','membership','seat_operation','reconcile',
    'grace_expiry','operator','erasure')),
  cause_id TEXT NOT NULL CHECK (length(cause_id) BETWEEN 1 AND 256),
  actor TEXT NOT NULL CHECK (length(trim(actor)) > 0 AND length(actor) <= 256),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 1024),
  previous_plan TEXT, next_plan TEXT,
  previous_status TEXT, next_status TEXT,
  processor_event_id TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((cause_kind = 'processor_event') = (processor_event_id IS NOT NULL)),
  CHECK (processor_event_id IS NULL OR processor_event_id = cause_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS entitlement_audit_once_per_cause
  ON entitlement_audit(subject_kind, subject_id, cause_kind, cause_id);
CREATE INDEX IF NOT EXISTS idx_entitlement_audit_subject
  ON entitlement_audit(subject_kind, subject_id, created_at);

CREATE TABLE IF NOT EXISTS referral_codes (
  code TEXT PRIMARY KEY COLLATE NOCASE
    CHECK (length(code) BETWEEN 6 AND 32 AND code NOT GLOB '*[^A-Za-z0-9-]*'),
  owner_account_id TEXT NOT NULL UNIQUE
    REFERENCES accounts(account_id) ON DELETE CASCADE,
  promotion_code_id TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  expires_at INTEGER,
  max_redemptions INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_events (
  record_id TEXT PRIMARY KEY,
  processor_event_id TEXT UNIQUE,
  code TEXT NOT NULL REFERENCES referral_codes(code) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('redemption','renewal','reversal')),
  referred_account_id TEXT NOT NULL
    REFERENCES accounts(account_id) ON DELETE CASCADE,
  referred_customer_id TEXT,
  object_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  reward_status TEXT NOT NULL DEFAULT 'none'
    CHECK (reward_status IN ('none','pending','earned','voided')),
  confirmed_at INTEGER,
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS referral_events_one_referrer_per_account
  ON referral_events(referred_account_id) WHERE kind = 'redemption';
```

Triggers (cross-table invariants; pattern `identityStore.ts:75-99`):

- `company_members` insert/update: target account must have
  `provenance='access'`.
- `company_invites` insert: `expires_at > created_at`.

The owner rule and the capacity rule are transactional code guards (§3.2),
not triggers.

### 3.6 Invariants

1. **Capacity:** every membership activation satisfies
   `active_members <= seatCapacity(company)` in its own transaction. The only
   way active members can exceed `quantity` is Stripe-observed drift, which
   blocks further activations and alerts (§3.2).
2. **Ownership:** every `active` company has exactly one active owner at every
   commit (index for ≤ 1, `assertOneActiveOwner` for ≥ 1).
3. **One writer:** only `entitlementWriter.ts` writes the writer-owned tables,
   always inside the caller's transaction (§3.3).
4. **Audit:** exactly one `entitlement_audit` row per changed subject per
   cause.
5. **No client input** (plan, price, amount, currency, coupon, seat count,
   trial state) is an entitlement input (`security.md:872-875`).
6. **Processor truth:** processor-driven changes come only from a
   signature-verified event followed by an authoritative re-fetch, or from
   reconcile's authoritative read. A Checkout/Portal redirect grants nothing.
7. **Grace:** `past_due` entitles only before `grace_until`; repeat failures
   never move `grace_until` (§3.7 P-5).
8. **Ordering:** subscription state is ordered per subscription; effects are
   deduplicated per object and never ordered against state (§7.1).
9. **Holds are per dispute, collection is per subscription:** a subscription
   is held while any of its disputes is `open`, `review`, or `lost`; resolving
   one dispute never releases another. Holds and cancels never affect another
   subscription id; only `canceled` is absorbing.
10. **Epoch:** entitlement changes never bump the authorization epoch; only
    account revocation does (§3.7 A-1).
11. **Consumed tokens stay consumed:** an invite with `redeemed_at` or
    `revoked_at` set is never redeemable, whatever `redeemed_by` holds.
12. **Company entitlement requires `first_paid_at`.**
13. **Operation results are subject-scoped:** a stored Checkout/Portal result
    is returned only to the subject that created it.
14. **No stale collection writes:** every Stripe pause/resume/cancel call
    sends the subscription's current `desired_collection` at its current
    `desired_version`, with at most one call in flight per subscription
    (§7.2).
15. **Tutor cap:** no new Access account is created while active Access
    accounts number at least `TUTOR_ACCOUNT_CAP`; existing accounts are never
    refused (§3.9).

### 3.7 Lifecycle and state transitions (authoritative)

Every row runs in **one IdentityDO transaction** unless it says otherwise,
writes entitlement state only through the writer (§3.3), and has **no session
or socket effect** except row A-1. "Next boundary" means the resolver's next
evaluation (§3.1). Acceptance tests name `file › case`; the files are in §13.
The rows are grouped: P personal, D disputes, C company, O operator,
R reconcile, E erasure, A account revocation.

#### Personal subscription

| Row | Trigger | Guard | State change | Cause | Acceptance test |
| --- | --- | --- | --- | --- | --- |
| P-1 | `POST /api/billing/checkout` | session, rate limit, catalog price | `billing_operations(checkout)`; no entitlement change | — | `stripeRequest.test.ts › checkout builder ignores client priceId and amount` |
| P-2 | Any event carrying a subscription (`checkout.session.completed`, `customer.subscription.*`, `invoice.*` via expanded subscription), after re-fetch | class 1: skip if `event.created < last_state_event_created` or `processor_canceled_at` set; equal timestamps apply | personal row from the **fetched** subscription: `trialing`/`active`; `cancel_at_period_end` does not downgrade; `past_due` handled by P-4/P-5; Stripe `pause_collection` set → `collection_paused=1` | `processor_event` | `billing.workers.test.ts › state: older subscription event is skipped, equal timestamp applies` |
| P-3 | `checkout.session.completed` effect | class 2, once per session id | bind customer/subscription ids; pending referral redemption | `processor_event` | `billing.workers.test.ts › checkout effect applies once across two event ids` |
| P-4 | First failure: fetched subscription `past_due` and row not `past_due` (normally with an `invoice.payment_failed` effect, once per invoice id) | — | `status=past_due`, `grace_until = failure event.created + 7 d` | `processor_event` | `billing.workers.test.ts › grace: first failure sets grace_until from event.created` |
| P-5 | Repeat failure while `past_due` (any invoice) | — | `grace_until` **unchanged** | `processor_event` (no audit: nothing changed) | `billing.workers.test.ts › grace: repeat failure does not extend grace_until` |
| P-6 | Grace deadline passes | none needed | enforcement: resolver treats the row as non-entitling at the next boundary. Daily sweep writes the audit row only (status stays `past_due` until Stripe changes it) | `grace_expiry` | `effectivePlan.test.ts › past_due entitles before grace_until and not at it`; `billing.workers.test.ts › grace sweep audits once per deadline` |
| P-7 | `invoice.paid` effect (once per invoice id) | class 2, never skipped by class 1 | capture `billing_payments`; confirm referral iff `amount_paid > 0`; if the fetched subscription is `active` and passes class 1: `status=active`, `grace_until=NULL` | `processor_event` | `billing.workers.test.ts › reversed: older invoice.paid after newer subscription.updated still records payment and confirms referral` |
| P-8 | Failure after recovery | — | P-4 again with a new `grace_until` from the new failure | `processor_event` | `billing.workers.test.ts › grace: failure after recovery starts a new window` |
| P-9 | Fetched subscription `canceled` (`customer.subscription.deleted`, or any later fetch) | — | `processor_canceled_at` set (absorbing for this subscription id); `status=canceled`; on `billing_subscriptions`, if `desired_collection` is not already `canceled`, set it and increment `desired_version`; in every case set `applied_version = desired_version` and clear any in-flight marker — Stripe is already terminal, so the executor has nothing to send, and a late response for the cleared marker is ignored (§7.2) | `processor_event` | `billing.workers.test.ts › reversed: deleted then older updated(active) stays canceled`; `› Stripe cancel sets desired canceled, clears the in-flight marker, and is never repaired` |
| P-10 | New personal checkout after P-9 | new subscription id | P-2 on the new id; the old id stays canceled | `processor_event` | `billing.workers.test.ts › a canceled subscription does not block a new subscription id` |
| P-11 | `charge.refunded` effect (once per refund id) | class 2 | referral reversal; entitlement unchanged unless the fetched subscription is canceled (P-9) | `processor_event` | `billing.workers.test.ts › refund reverses referral without changing entitlement` |

#### Disputes (policy D12; rows written for option (a))

Mapping: primary `dispute.charge → charge.customer` matched against the stored
`processor_customer_id` on `companies` or `entitlements`; `billing_payments` is
the secondary map.

Every dispute gets its own `billing_dispute_holds` row keyed by dispute id
(G2). Its state comes from the **fetched dispute**, never from the event type,
and only moves forward: `open` → `review` → `won`/`lost`, or straight to
`won`/`lost`. The first observation may already be terminal, so no row
requires an earlier delivery or an existing hold (G1). A subscription is
**held** while any of its disputes is `open`, `review`, or `lost`; resolving
one dispute never releases another. After every hold change the writer
recomputes, in the same transaction, `collection_paused` on the affected
personal row or company member rows (held, or Stripe `pause_collection`
observed) and the subscription's `desired_collection` (§7.2).

| Row | Trigger | Guard | State change | Cause | Acceptance test |
| --- | --- | --- | --- | --- | --- |
| D-1 | Dispute observed with an open status (first time or again) | mapped | upsert the hold as `open` (no-op if already further); subscription held → `collection_paused=1` (not entitling at the next boundary; no lesson break); desired collection `paused`. (b): `canceled`. (c): unchanged; operator queue | `processor_event` | `billing.workers.test.ts › open dispute pauses entitlement and sets desired collection to paused` |
| D-2 | Dispute observed `won` | mapped | upsert the hold as `won`, whether or not `open` was ever seen; only if no other hold on the subscription is `open`/`review`/`lost`: desired collection `active`, and `collection_paused=0` once Stripe no longer reports `pause_collection` | `processor_event` | `billing.workers.test.ts › reversed: closed(won) before created never places a hold`; `› two disputes: winning one keeps the subscription paused until the other closes` |
| D-3 | Dispute observed `lost` | mapped | upsert the hold as `lost`, whether or not `open` was ever seen; desired collection `canceled` (absorbing); rows stay paused; P-9 follows when Stripe reports canceled | `processor_event` | `billing.workers.test.ts › reversed: lost observed first still cancels`; `› lost dispute cancels and entitlement stays paused` |
| D-4 | Dispute closed in any other status | mapped | upsert the hold as `review` (still holding); operator review (O-2) | `processor_event` | `billing.workers.test.ts › dispute closed in another status keeps the hold and queues review` |
| D-5 | Dispute that cannot be mapped | — | event recorded `ignored` / `unmapped_dispute`; operator alert; the R-1 dispute sweep retries the mapping | — | `billing.workers.test.ts › unmapped dispute records ignored and raises the operator alert` |
| D-6 | Collection executor (§7.2): after any `desired_version` change, on every authoritative subscription read, and from R-1 | at most one call in flight per subscription | claim the current version, set that state in Stripe, settle; confirm an unknown outcome from Stripe's actual state; open a repair generation when Stripe drifts after a success; a superseded version is never sent | — (bookkeeping only: no entitlement change, no audit row) | `billing.workers.test.ts › a pause retried after a newer resume is never sent`; `› R-1 repairs drift after a successful operation by opening a new generation`; `› a timed-out call Stripe applied is confirmed: applied_version advances and the marker clears`; `› a late response for version 1, after a webhook confirmed it and version 2 was claimed, changes nothing` |

#### Company

| Row | Trigger | Guard | State change | Cause | Acceptance test |
| --- | --- | --- | --- | --- | --- |
| C-1 | `POST /api/company` | Access account, no active membership (409), rate limit | `companies` + owner membership; owner assertion; capacity 1 | `membership` | `company.workers.test.ts › create inserts company and owner atomically; founder already in a company gets 409` |
| C-2 | Stripe Customer created (outbound `company-create`) | after C-1 commits | `processor_customer_id` written back; failure leaves the company without a customer, retry by `operationId` | — | `company.workers.test.ts › customer creation failure keeps the company and replays by operationId` |
| C-3 | Subscription established: card Checkout (3–9) or `send_invoice` created after O-1 (10+) | P-2 ordering | `company_subscriptions` row; capacity = `quantity`; `first_paid_at` NULL, so no member entitlement | `processor_event` | `company.workers.test.ts › unpaid send_invoice company grants members nothing` |
| C-4 | First paid invoice (`invoice.paid` effect) | `first_paid_at IS NULL` | `first_paid_at` set; `INSERT … SELECT` a company row for every active member (copying company status, period, grace, pause); one audit row per member | `processor_event` | `company.workers.test.ts › first invoice.paid materializes every active member with one audit row each` |
| C-5 | Company subscription state change (P-2, P-4…P-9, D-1…D-4 at company level) | `first_paid_at` set | `UPDATE` member company rows to the company's state; one audit row per changed member | `processor_event` | `company.workers.test.ts › company past_due fans out grace_until to every member row` |
| C-6 | Invite minted / revoked | owner/admin; revoke only unredeemed | invite row / `revoked_at` | — | `company.workers.test.ts › revoked invite cannot be redeemed` |
| C-7 | Invite redeemed | token unredeemed, unrevoked, unexpired (else 404, no oracle); Access account with no active membership; `active_members + 1 <= seatCapacity` (else 402) | membership row; `redeemed_at`, `redeemed_by`; if `first_paid_at` set, company row for the redeemer | `membership` | `company.workers.test.ts › replayed token returns 404`; `› redemption over capacity returns 402` |
| C-8 | Seat increase | owner; nothing pending (409) | reserve → Stripe → settle (§3.2); capacity rises only at settle | `seat_operation` | `company.workers.test.ts › pending increase grants no capacity until settled` |
| C-9 | Seat decrease | owner; nothing pending (409); target ≥ active members (409) | reserve (capacity drops to target at once) → Stripe → settle | `seat_operation` | `company.workers.test.ts › redemption during a pending decrease is refused above the target` |
| C-10 | Seat change, Stripe failure or unknown outcome | pending row | 4xx: release; unknown: stay pending, route 202, R-1 recovers | `seat_operation` | `company.workers.test.ts › Stripe failure releases the reservation; unknown outcome stays pending until reconcile settles it` |
| C-11 | Member revoked | owner/admin; target is not the owner (409) | membership `revoked`; delete the member's company row; owner assertion | `membership` | `company.workers.test.ts › revoking the owner returns 409 and leaves one owner` |
| C-12 | Ownership transfer | owner; target is an active member | demote, then promote; owner assertion | `membership` | `company.workers.test.ts › a transaction that would leave the company ownerless rolls back` |
| C-13 | Company disabled | owner | all memberships `revoked` (owner included); company rows deleted; `state=disabled`; desired collection `canceled` (§7.2) | `membership` | `company.workers.test.ts › disable revokes every seat and sets desired collection to canceled; rooms untouched` |

#### Operator, reconcile, erasure, account revocation

| Row | Trigger | Guard | State change | Cause | Acceptance test |
| --- | --- | --- | --- | --- | --- |
| O-1 | Invoice approval (D11) | operator allowlist | `invoice_approved=1`; server creates the `send_invoice` subscription (C-3) | `operator` | `company.workers.test.ts › self-serve caller cannot approve invoicing` |
| O-2 | Operator dispute review (a `review` hold, option (c), or a stuck hold) | operator allowlist | move the hold to `won` or `lost` per the operator's recorded decision, with D-2/D-3 semantics; this grants nothing by itself — entitlement follows the recomputed hold set and the next authoritative read | `operator` | `billing.workers.test.ts › operator dispute action is audited, allowlisted, and grants nothing by itself` |
| R-1 | Daily reconcile (Cron → IdentityDO) | — | per stored subscription: fetch and apply P-2/C-5 (a subscription with an open dispute hold is not reported as drift; Stripe `pause_collection` sets `collection_paused` without an alert); grace sweep (P-6); settle pending seat changes (§3.2 step 4); retry pending outbound operations; collection check (D-6, §7.2 steps 4–5: confirm or fail stale in-flight markers, then open a repair generation wherever Stripe disagrees with `desired_collection`); dispute sweep (`GET /v1/disputes` created after the `billing_sweeps` watermark, applied as D-1…D-5); corporate price-tier check against `CORPORATE_SEAT_BANDS` | `reconcile` | `billing.workers.test.ts › reconcile drift is applied once per run id` |
| E-1 | Owner erasure | other active members exist | transfer to the earliest active admin, else earliest active member (C-12); then E-2 | `erasure` | `sessionStore.test.ts › owner erasure transfers ownership in the same transaction` |
| E-2 | Any member's erasure | — | membership `revoked`, company row deleted; sole member → C-13; `company_invites.redeemed_by = NULL` with `redeemed_at` kept; unredeemed invites the account created are revoked; referral rows where the account is referred deleted; `entitlement_audit` subject ids pseudonymized | `erasure` | `sessionStore.test.ts › erasure keeps a redeemed invite consumed and its token still returns 404` |
| A-1 | Account disable / revoke-all / operator fraud action | existing guards | existing epoch bump (`sessionStore.ts:653-700`); sessions fail and sockets close within 30 s (`SECURITY_REVOCATION_BOUND.md:119`) | existing `authorization_audit` | existing suites (unchanged) |

### 3.8 Erasure and export

- `eraseOwnAccount` (`sessionStore.ts:601-636`) performs rows E-1 and E-2 in
  its existing transaction.
- **Consumed-token preservation (F6).** Erasure clears
  `company_invites.redeemed_by` and keeps `redeemed_at`. The CHECK
  `redeemed_by IS NULL OR redeemed_at IS NOT NULL` permits this and still
  forbids a redeemer without a redemption time. Redemption tests consumption
  with `redeemed_at IS NULL AND revoked_at IS NULL`, never with `redeemed_by`,
  so erasure cannot reopen a token. `created_by` keeps the account id, whose
  row persists disabled and identity-free.
- Accounts are never hard-deleted, so the schema's `ON DELETE` clauses are
  documentation only; the erasure code does the cleanup.
- `exportOwnAccountData` (`sessionStore.ts:487-535`) gains entitlements,
  memberships (company name, role, and the display names of other active
  members as the caller sees them), and referral rows.
- Billing retention vs erasure: Stripe-held invoices and tax records are
  retained per legal duty; local rows keep processor ids only. Record the
  winner in SEC-016 (D8).

### 3.9 Tutor account cap (D10)

The owner capped tutors at 50 while the Cloudflare Access free plan (50 users
per Zero Trust organization) is the authentication budget.

- `resolveAccountForSubject` (`identityStore.ts:347-397`) is the only code that
  creates a new Access account, inside its existing transaction
  (`identityStore.ts:357-389`). The cap check goes in that transaction,
  immediately before the `INSERT INTO accounts`: count `accounts` with
  `provenance='access' AND state='active'`; if the count is at least
  `TUTOR_ACCOUNT_CAP` (a Worker `[vars]` integer, default 50), insert nothing
  and return a distinct `tutor_cap_reached` outcome. That outcome is a new
  variant of the return type (today `ResolvedAccount` is `{account, created}`,
  `identityStore.ts:27-30`), never a thrown error: the function's `catch`
  (`identityStore.ts:390-396`) treats any error as a lost insert race.
- An existing account is found before the transaction and again inside it
  (`identityStore.ts:353-354`, `:358-361`), so the cap never refuses a current
  tutor. Guest accounts are not counted; students keep joining through the
  guest host.
- The Worker answers `tutor_cap_reached` with 403 and a static "tutor sign-ups
  are paused" page, and issues no session.
- A disabled or erased account frees a slot in the app's count. Cloudflare
  frees its own seat only when the user is also removed in Zero Trust, so that
  removal is an operator runbook step; Access's seat limit stays the backstop.
- Raising `TUTOR_ACCOUNT_CAP` is a configuration change allowed only after
  re-costing Access (D10).
- Acceptance tests: `identityStore.test.ts › the 51st new Access subject is
  refused and creates no account`; `› an existing account still resolves at
  the cap`; `› guest accounts do not count toward the cap`;
  `worker.access.workers.test.ts › a new tutor at the cap gets 403 and no
  session`.

---

## 4. Plan catalog and pricing

### 4.1 Catalog lives in code (SEC-015 `security.md:992-996`)

`src/lib/plan/catalog.ts` (new, pure). Free numbers are imported from
`limits.ts`, never retyped:

```ts
import { FREE_MAX_ROOMS, FREE_MAX_USERS } from './limits';

export type PlanId = 'free' | 'tutor_pro_monthly' | 'tutor_pro_annual' | 'corporate_seat';
export interface PlanDefinition {
  limits: { maxOwnedRooms: number; maxUsersPerRoom: number; retentionDays: number };
  interval: 'month' | 'year' | null;
  priceEnv: string | null;            // env var holding the Stripe price id
  minSeats?: number;                  // corporate: 3
}
export const PLAN_CATALOG: Record<PlanId, PlanDefinition> = {
  free:               { limits: { maxOwnedRooms: FREE_MAX_ROOMS, maxUsersPerRoom: FREE_MAX_USERS, retentionDays: 90 }, interval: null, priceEnv: null },
  tutor_pro_monthly:  { limits: { maxOwnedRooms: 20, maxUsersPerRoom: 10, retentionDays: 90 }, interval: 'month', priceEnv: 'STRIPE_PRICE_TUTOR_PRO_MONTHLY' },
  tutor_pro_annual:   { limits: { maxOwnedRooms: 20, maxUsersPerRoom: 10, retentionDays: 90 }, interval: 'year',  priceEnv: 'STRIPE_PRICE_TUTOR_PRO_ANNUAL' },
  corporate_seat:     { limits: { maxOwnedRooms: 20, maxUsersPerRoom: 10, retentionDays: 90 }, interval: 'year',  priceEnv: 'STRIPE_PRICE_CORPORATE_SEAT', minSeats: 3 },
};

// Copy/validation only; amounts live in Stripe as a graduated tiered price.
export const CORPORATE_SEAT_BANDS = [
  { min: 3,  max: 9,   gbpPerSeatMonth: 7.5 },
  { min: 10, max: 24,  gbpPerSeatMonth: 6.5 },
  { min: 25, max: 99,  gbpPerSeatMonth: 5.5 },
] as const;

export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;  // SEC-015 7-day grace
```

- Enforcement sites switch to the effective plan in Phase 3: room
  create/settings `maxUsers` (`handlers/room.ts:247,340`), owned-room
  reservation (`IdentityDO.ts:550-560`), waiting-queue cap
  (`membership.ts:30-52`), and RoomDO admission (new; §6.4).
- Stripe prices are `tax_behavior=exclusive`; the page states "ex VAT"; Stripe
  Tax computes VAT at checkout and `tax_id_collection` is enabled for B2B.
- Stripe's own dunning settings should cancel or mark `unpaid` after its final
  retry. That setting is not a correctness dependency: access ends at
  `grace_until` regardless (§3.1).

### 4.2 Public prices (D4; static copy only)

| Plan | Price | Effective | Notes |
| --- | --- | --- | --- |
| Free | £0 | — | 1 room, host + 1 student, 90-day retention, A/V |
| Tutor Pro monthly | £9.99/mo | £9.99 | ex VAT |
| Tutor Pro annual | £95/yr | £7.92/mo | 20% annual discount |
| Corporate 3–9 seats | £7.50/seat/mo | £90/seat/yr | Annual, min 3, self-serve card |
| Corporate 10–24 seats | £6.50/seat/mo | £78/seat/yr | Invoice-first after approval |
| Corporate 25–99 seats | £5.50/seat/mo | £66/seat/yr | Invoice-first after approval |
| Corporate 100+ | Quote | — | Sales-assisted; floor ≈£45/seat/yr |

Anchors: `spec/findings/03-market-corporate-pricing.md` §Comparables and
§Volume-discount norms.

### 4.3 Limit enforcement

- The Worker stamps verified `accountId`/`accountEpoch`/`sessionId` and strips
  forged headers (`worker.ts:777-814`, `requestGuard.ts:288-310`); plan input
  is never trusted from the client.
- RoomDO resolves the owner from `room_members` (`RoomDO.ts:1544-1547`) and
  reads the owner's effective plan through `GET /accounts/plan` (§6.4).
- RoomDO currently never reads `max_users`; admission capping is new behavior
  with its own red worker tests (Phase 3).
- Over-quota rooms after a downgrade are archived (readable, not writable, not
  joinable), never deleted, and restored on re-upgrade (SEC-015
  `security.md:1021-1027`; Phase 3).

---

## 5. Security contract

### 5.1 SEC-015 mapping

This spec extends SEC-015: no card data in app; server-owned catalog and price
selection; entitlement only from verified events plus authoritative reads;
dedupe; idempotent audited transitions; server-side limits; account scoping;
students never billable; processor ids only; secrets in Worker secrets;
reconciliation and drift alerts. The amendments below cover where the design
differs.

### 5.2 Required SEC-015 amendments (D1, D2, D3) — drafts, not applied

1. **Target market (`security.md:959-961`).** Replace
   "no seat pools, no rosters, no district billing, no admin consoles" with:

   > no student seats, no rosters, no LMS/SSO, no district billing, and no
   > administrative control over other tutors' rooms or content. A *corporate
   > account* is permitted only as a billing group of tutor accounts: a company
   > may hold tutor seats, assign/revoke them, and see its own consolidated
   > invoice, but it never sees or controls a member's boards and students are
   > never billable.

2. **Entitlement data model (`security.md:1000-1009`).** PK
   `(account_id, source)`; company rows materialized by the entitlement writer;
   plan status writes do not bump the epoch; audit moves to
   `entitlement_audit`, exactly once per cause (§3.3).
3. **Downgrade propagation (`security.md:886-889`).** For entitlement changes,
   replace "bump the account authorization epoch" with boundary-time
   re-evaluation (§3.1); keep epoch semantics for authorization revocation.
4. **Seat counting (`security.md:1474-1483`).** "Student metering stays
   distinct-student-based; tutor seats exist only in the corporate billing
   tables"; "seat allocation" in the Phase 7 task becomes "corporate seats and
   company membership".
5. **Free residuals (`security.md:923`).** The "3-participants-per-room cap"
   becomes the catalog Free cap (`FREE_MAX_USERS = 2`).
6. **Audit acceptance (`security.md:1072-1073`).** "exactly once in
   `authorization_audit`" becomes "exactly once in `authorization_audit` for
   authorization changes and exactly once per cause in `entitlement_audit` for
   entitlement transitions".
7. **Billing acceptance text (`security.md:937-944`).** "Cancel, refund,
   chargeback, and failed renewal past grace remove entitlement from HTTP and
   from **new** room activity at the next boundary, and from already-open
   lessons at the session's next validity check; account-level revocation
   still closes sockets within the 30 s alarm bound. A chargeback suspends
   billing per D12." **Tested bound:** an open socket with no further HTTP
   activity is closed by the RoomDO alarm at the session's idle expiry,
   because the alarm checks `idle_expires_at` (`sessionStore.ts:340-347`) and
   never refreshes it; only HTTP `validateSession` does
   (`sessionStore.ts:375-386`). The 12 h absolute expiry is the ceiling only
   while HTTP activity keeps refreshing idle. **Accepted residual:** a lapsed
   or disputed account keeps its already-admitted participants in an open
   lesson until that check.

### 5.3 Route boundary

Every new path is registered in `requestGuard.ts` (fail-closed
`return false` at `:196-197`):

1. **Teacher-only entries** for `/api/billing/checkout`, `/api/billing/portal`,
   `/api/company` and `/api/company/*`, `/api/referrals/me`, and
   `/account/company`. Match exact paths or the `'/api/company/'` prefix —
   never bare `startsWith('/api/company')`, which admits `/api/companyX`.
2. **Webhook entry**: exact path `/api/billing/webhook`, `POST` only, teacher
   host. Its worker branch sits between the route check (`worker.ts:966`) and
   the Access/principal gate (`:987`).
3. **Origin guard**: exact-path exemption for the webhook in
   `isOriginGuardedPath` (`requestGuard.ts:212-223`); every other new `/api/`
   route stays origin-guarded.
4. **Marketing allowlist** (`:98-113`, `MARKETING_PAGES` `:352`) includes no
   billing, company, or referral path.
5. **Invite tokens use a URL fragment**, never a query string.
6. **Route collision.** `/whiteboard/<segment>` is a room whenever the segment
   matches `ROOM_ID_RE` (`requestGuard.ts:150-157`) on both hosts; the company
   page is `/account/company`, never `/whiteboard/company`. Tests pin guest
   denial for `/account/company`.
7. **Webhook reachability.** **Phase 0 record (2026-09-11): Option A chosen —
   a Cloudflare Access Bypass scoped to the exact path
   `POST /api/billing/webhook` on the teacher hostname, never a wildcard or
   prefix.** Option B (a fourth hostname with no Access application,
   `DEPLOY.md:33-45` pattern) is the required fallback if provisioning cannot
   scope the bypass to that exact path. Capture the application/policy as
   review evidence at provisioning and record which option landed in the
   Phase 2 evidence.

### 5.4 Revocation vs downgrade

Rows P-*, D-*, C-*, O-*, R-*, and E-* in §3.7 never touch sessions or sockets;
row A-1 is the only transition with a session effect.

### 5.5 Secrets, PII, tax, disclosure

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` in Worker secrets only; price
  ids per environment in `[vars]`; pattern `DEPLOY.md:113-124`. Never in code,
  logs, or client bundles. Document rotation.
- Processor ids only; no PAN; no billing address unless tax rules demand it.
- UK VAT 20%; `tax_behavior=exclusive`; HMRC-compliant invoices via Stripe for
  corporate; `send_invoice` with `days_until_due=30` after approval (D11).
- **Seat list identifier:** company admins see each member's
  `preferred_display_name`, role, and join date — a modest new cross-account
  disclosure requiring terms/privacy text, SEC-016 review, and export
  coverage.
- Invite links are bearer tokens: short TTL, single-use, revocable,
  rate-limited; a leaked link can consume a billed seat, and the audit trail
  records `created_by` and the redemption.
- Operator actions (O-1, O-2) are env-allowlisted, audited, and unreachable
  from self-serve.

---

## 6. Server surface

### 6.1 Public Worker routes

| Route | Method | Purpose | Guards |
| --- | --- | --- | --- |
| `/auth/session/current` | GET | existing; gains `plan` + `company` | session; the only public route carrying plan/company |
| `/api/billing/checkout` | POST | body `{planId, referralCode?, operationId}`; returns `{url}` (P-1) | teacher-only, origin guard, session, rate limit |
| `/api/billing/portal` | POST | caller's Portal `{url}` | same |
| `/api/billing/webhook` | POST | Stripe events (§7.1) | exact-path exemption: POST only, signature, 1 MiB cap |
| `/api/company` | GET/POST/PATCH/DELETE | summary / create (C-1) / rename / disable (C-13) | teacher-only, origin guard, session, role |
| `/api/company/invites` | POST/DELETE | mint / revoke (C-6) | owner/admin |
| `/api/company/invites/redeem` | POST | redeem fragment token (C-7) | Access account, session |
| `/api/company/members/revoke` | POST | revoke a seat (C-11) | owner/admin; never the owner |
| `/api/company/owner` | POST | transfer ownership (C-12) | owner |
| `/api/company/seats` | POST | seat change (C-8…C-10); 200 settled, 202 pending | owner |
| `/api/referrals/me` | GET | code, link, pending/confirmed counts | caller-only |

Handlers model `accountProfile` (`worker.ts:515-538`) and dispatch in the
`!isGuestHost && principal` block (`worker.ts:1007-1032`).

### 6.2 IdentityDO internal routes

| Route | Purpose |
| --- | --- |
| `POST /billing/events/apply` | apply one verified, already-fetched event in one transaction (§7.1); no network |
| `GET /billing/events/status?id=...` | read-only "already recorded?" lookup before any Stripe fetch |
| `POST /billing/operations` | claim/replay an outbound operation by subject + `operationId` + request hash |
| `POST /billing/operations/settle` | settle an outbound operation (seat change, pause/resume/cancel, company-create) |
| `GET /billing/reconcile` | R-1 |
| `GET /accounts/plan` | effective plan for one account (session badge, RoomDO admission) |
| `GET|POST|PATCH|DELETE /companies...` | C-1…C-13 |
| `GET /referrals/me` | caller-scoped code + counts |

Body guards follow `isProfileBody`/`isAccountBody` (`IdentityDO.ts:132-198`);
mutations validate the session in the DO (model `/accounts/profile`,
`IdentityDO.ts:441-461`); unknown paths 404 (`IdentityDO.ts:690`).
`POST /sessions/authorize` must not carry plan/company: it runs on every
authenticated API request.

### 6.3 Rate limits (ship with each route)

| Route | Limit |
| --- | --- |
| `/api/billing/checkout`, `/api/billing/portal` | 10/hour/account |
| `/api/company` (POST) | 5/hour/account (creates a Stripe Customer) |
| `/api/company/seats` | 5/hour/company |
| `/api/company/invites` | 20/hour/company |
| `/api/company/invites/redeem` | 10/hour/account |
| `/api/company/members/revoke`, `/api/company/owner` | 20/hour/company |
| `/api/referrals/me` | 60/hour/account |

Limits are IdentityDO counters keyed by subject (shared across isolates); the
Workers Rate Limiting binding may add a coarse edge gate, and the zone's
single free WAF rule is earmarked for `POST /auth/guest` (`DEPLOY.md:41-43`).
The webhook has **no** rate limit — after verification it could only slow
Stripe's own retries — and a dedicated 1 MiB body cap
(`BILLING_WEBHOOK_MAX_BODY_BYTES`), not the 4 MiB whiteboard
`MAX_BODY_BYTES` (`requestGuard.ts:229-238`). Each limit ships with its route
and a negative test.

### 6.4 RoomDO plan reads

Do not join plan/company onto `/accounts/authorizations` (`RoomDO.ts:2153`,
the revocation alarm path) or `/sessions/authorize` (`worker.ts:387`, every
request). RoomDO admission calls `GET /accounts/plan` for the resolved owner
and caches the answer per admission decision only; cross-DO reads fail closed
on IdentityDO errors. Over-plan status is the existing 402
(`limits.ts:13-14`).

---

## 7. Stripe integration

### 7.1 Webhook pipeline and ordering (F1)

**Handler order (production; no test mode changes it):** read raw bytes under
the 1 MiB cap → verify signature (300 s tolerance, multiple `v1`, rotated
secrets, `crypto.subtle.verify`) → `JSON.parse` → read-only
`GET /billing/events/status`; if already recorded, 200 with no Stripe call →
livemode check (mismatch: record `ignored`/`livemode_mismatch`, 200) →
**authoritative re-fetch** of the objects in the fetch map (failure → 500,
nothing written) → `POST /billing/events/apply` → 200. Bad signature → 400
with nothing written; unknown type → recorded `ignored`, 200.

**Apply transaction.** Insert-or-ignore `billing_events`; then apply the
event's parts by class; then set the outcome. Any failure rolls back
everything, including the event row, and returns 500 so Stripe retries.

**Ordering classes.** One event can carry both classes (an `invoice.paid`
yields a payment effect and, through its expanded subscription, a state
update).

1. **Subscription state** (§3.7 P-2, P-9, C-5). Ordered per
   `processor_subscription_id` in `billing_subscriptions`: skip the state part
   when `event.created < last_state_event_created`; equal timestamps apply
   (no event-id tiebreak); `processor_canceled_at` is absorbing because Stripe
   cannot reactivate a canceled subscription. The state written is always the
   **fetched** object, so the watermark only stops a slow delivery from
   overwriting a newer one.
2. **Effects** (P-3, P-4, P-7, P-11, C-4, D-1…D-4). Checkout, invoice, and
   refund effects are keyed by `(effect_kind, object_id)` in `billing_effects`
   and applied exactly once; dispute effects are the forward-only per-dispute
   upsert in `billing_dispute_holds` (§3.7). Both apply in whatever order they
   arrive. Effects are **never** compared with the
   subscription watermark, so an older invoice or dispute delivered after a
   newer subscription update still records its payment, referral confirmation,
   `first_paid_at`, or dispute hold. Effects read fetched object state (dispute
   status, `amount_paid`), not the event type.
3. **Bookkeeping.** `billing_events` dedupes by event id.

**Residual (accepted).** Two concurrent deliveries for one subscription can
fetch in one order and commit in the other, briefly leaving an older fetched
state. This cannot resurrect a canceled subscription (absorbing) and converges
at the next event, the targeted reconcile queued with `waitUntil`, or R-1.

**Fetch map (outside the transaction):**

| Event family | Authoritative read |
| --- | --- |
| `checkout.session.*` | `GET /v1/checkout/sessions/{id}` |
| `customer.subscription.*` | `GET /v1/subscriptions/{id}` |
| `invoice.*` | `GET /v1/invoices/{id}?expand[]=parent.subscription_details.subscription` |
| `charge.refunded` | `GET /v1/charges/{id}` |
| `charge.dispute.*` | `GET /v1/disputes/{id}` and its charge (`charge.customer`) |

Basil removed `invoice.subscription`, `invoice.payment_intent`, and
`charge.invoice`; invoice mapping reads `invoice.parent.subscription_details`
and `invoice.payments` (stored in `billing_payments`); dispute mapping is
§3.7 "Disputes".

**Subscribed events:** `checkout.session.completed`,
`checkout.session.async_payment_succeeded` and
`checkout.session.async_payment_failed` (only if delayed methods are enabled),
`customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`,
`charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`.

**Reversed-delivery tests** (`src/do/billing.workers.test.ts`, applying
fetched synthetic objects through `/billing/events/apply` in the stated order):

- newer `customer.subscription.updated`, then older `invoice.paid`: payment
  recorded, referral confirmed, `first_paid_at` set, state from the newer
  event kept;
- `customer.subscription.deleted`, then older `updated(active)`: stays
  canceled;
- `charge.dispute.closed(won)`, then `charge.dispute.created`: no hold placed;
- `charge.dispute.closed(lost)` as the first delivery for that dispute, then
  `charge.dispute.created`: desired collection `canceled`, entitlement paused;
- two disputes on one subscription, the first closed `won` while the second is
  still open: the subscription stays paused until the second closes;
- a pause call retried after a newer resume was applied: the retry is never
  sent, and Stripe ends in the resumed state;
- `invoice.payment_failed` delivered after the recovering `invoice.paid`:
  grace is not re-opened for a subscription the fetch reports `active`;
- two events with equal `created`: both applied;
- the same invoice's effect under two different event ids: applied once.

### 7.2 Outbound operations and idempotency

- Every user-initiated billing action carries a client-generated
  `operationId`; `billing_operations` is keyed by
  `(subject_kind, subject_id, operation_id)`. Same key and hash → replay the
  stored result to that subject only; same key, different hash → 409. Stripe
  idempotency keys are `op:<subject_kind>:<subject_id>:<operation_id>`.
- System-initiated referral credits use deterministic ids
  (`credit:<code>:<referred_account_id>`) and are retried by R-1; one that
  cannot be applied alerts the operator queue.
- **Collection state (G3).** Pause, resume, and cancel are never queued as
  separate actions. In the same transaction as every dispute-hold change,
  company-disable change, or observed Stripe cancel (P-9), the writer
  recomputes `billing_subscriptions.desired_collection`: a subscription Stripe
  reports `canceled`, any `lost` hold, a disabled company, or an open hold
  under D12 option (b) → `canceled` (absorbing); else
  any `open`/`review` hold under option (a) → `paused`; else `active`. Under
  option (c) holds pause entitlement only, never collection. Any change
  increments `desired_version`. One executor per subscription (row D-6):
  1. **Claim** (transaction): only when `in_flight_version IS NULL` and
     `applied_version < desired_version`; record
     `in_flight_version = desired_version`,
     `in_flight_state = desired_collection`, and `in_flight_since`.
  2. **Call Stripe** outside the transaction to *set* `in_flight_state`
     (`pause_collection` set, `pause_collection` cleared, or cancel), recorded
     as a `subscription-collection` operation with idempotency key
     `collection:<subscription_id>:<version>`.
  3. **Settle** (transaction, H4): the completed request carries the version
     it was claimed with (step 1). Settlement first checks, inside the
     transaction, that `in_flight_version` still equals that version. If it
     does not — the marker was already confirmed (step 4), failed, cleared by
     P-9, or replaced by a newer claim — the response only updates its own
     `subscription-collection` operation row and changes nothing on
     `billing_subscriptions`. When the versions match: on success
     `applied_version = in_flight_version` and clear the in-flight marker; on
     a definitive failure clear it and alert; if
     `applied_version < desired_version` afterwards, claim again. An unknown
     outcome keeps the marker.
  4. **Confirm (H2).** Every authoritative read of the subscription — a
     webhook's re-fetch (P-2) or R-1 — maps Stripe's actual collection state
     (status `canceled` → `canceled`; `pause_collection` set → `paused`;
     otherwise `active`) and compares it with `in_flight_state`. A match
     settles the in-flight version as a success exactly as in step 3:
     `applied_version` advances, the marker clears, and any newer desired
     version is claimed. If R-1 finds a marker older than 15 minutes whose
     state Stripe does not show, it settles it as failed and step 5 applies,
     rather than re-sending the same idempotency key, whose first response
     Stripe may replay for 24 h.
  5. **Repair generation (H1).** With no marker in flight, if Stripe's actual
     state differs from `desired_collection` — a dashboard or Portal edit
     after a successful call, or a marker failed by step 4 — R-1 increments
     `desired_version` without changing `desired_collection`. That re-opens
     step 1 with a fresh idempotency key. A subscription Stripe reports
     `canceled` is never repaired: P-9 has already set
     `desired_collection = 'canceled'`, made `applied_version` equal to
     `desired_version`, and cleared any marker, so actual and desired agree.

  A retry never re-sends an older decision: each call carries the state
  recorded at claim time, and once `desired_version` advances an older
  version is never claimed again. No in-flight marker survives the first
  authoritative read that confirms it, or R-1's 15-minute timeout.
- Pure request builders in `src/lib/billing/stripeRequest.ts` return real
  `Request` objects; `stripeClient.ts` executes them with a bounded timeout and
  a pinned `Stripe-Version`.

### 7.3 Personal and corporate billing requests

- **Personal (P-1):** the server maps `tutor_pro_monthly|tutor_pro_annual` to
  its price; sets `client_reference_id=<account_id>`, validated referral
  metadata, optional promotion code; returns the Checkout URL.
  `POST /api/billing/portal` creates a Portal session. Redirects grant
  nothing.
- **Corporate 3–9 (C-3):** Checkout in subscription mode with the company's
  `customer`, per-seat line item `quantity`, `tax_id_collection`. Later
  quantity changes use `POST /api/company/seats` (§3.2), never Checkout or the
  Portal.
- **Corporate 10+ (O-1, C-3):** after operator approval the server creates the
  `send_invoice` subscription (`days_until_due=30`, `automatic_tax` per
  config). Members get nothing until the first paid invoice (C-4); the company
  page shows `hosted_invoice_url` and an "awaiting payment" state.

### 7.4 Webhook event contract

There is no separate per-event action table: each subscribed event (§7.1) is
applied by class (§7.1) into the rows of §3.7.

### 7.5 Reconciliation and ops

- Daily Cron Trigger → IdentityDO `/billing/reconcile` performs row R-1.
  Workers Paid is assumed (10k subrequests).
- A targeted reconcile for the affected subscription is queued with
  `waitUntil` after each applied event. It is a convergence aid; no
  correctness property depends on it.
- Alerts (drift, unmapped dispute, failed outbound operation, price-tier
  mismatch, capacity drift) page the operator; logs carry event id, type, and
  outcome only. Manual backfill uses `GET /v1/events`.
- Local development: `wrangler dev` + `stripe listen`; Test Clocks for
  renewal and grace scenarios in staging.

### 7.6 Evidence layers (F5)

The production path always re-fetches from Stripe after verification; no
flag, env var, or test route bypasses that, and no test uses a Stripe double
(no stripe-mock, stub server, or `fetchMock`). Consequently **no local test
can observe a successful webhook end to end**, and none may claim to.

| Layer | Runs | Proves | Does not prove |
| --- | --- | --- | --- |
| Unit (`npm test`) | always | signature verifier (real Web Crypto); pure request builders (server-selected price, client values ignored); resolver incl. grace and pause; capacity function; static writer guard | any network or DO behavior |
| DO apply (`npm run test:workers`) | always | every §3.7 row's state logic, ordering classes, reversed delivery, audit exactly-once, capacity/owner guards, seat reservation settle paths — by calling `/billing/events/apply` and company routes with synthetic fetched objects | that Stripe returns those objects |
| Worker route (`npm run test:workers`) | always | webhook boundary up to the fetch: bad signature 400 with no row, body cap 413, duplicate short-circuit, livemode recorded, fetch failure 500 with no row (`STRIPE_API_BASE` pointed at an unroutable address — a real failure, not a double), guard exemptions | a successful fetch-then-apply |
| Paid-state HTTP (`npm run test:workers`) | always | entitlement and `company_subscriptions` state seeded through the writer inside the real IdentityDO (`runInDurableObject`), then real Worker requests via `SELF`: room create/settings limits, owned-room cap, RoomDO admission, session payload, grace expiry at a boundary; company flows that need a second seat — invite redemption, member revoke, ownership transfer, seat-change reservation — against the seeded subscription row | how that state got there; the browser UI of those flows |
| Local e2e (`npm run test:e2e`) | always | browser path for everything reachable with Stripe unset and nothing seeded: Free behavior, route guards, guest denial, checkout/portal unavailable state; company creation (C-1 succeeds, C-2 fails, the page shows billing not set up); invite mint and revoke; a second local Access identity (the issuer mints a token per `sub`, `scripts/local-access-issuer.mjs:45`; existing helper `newAuthenticatedContext`, `tests/e2e/helpers.ts:88-94`) redeeming the fragment token is refused with the "no free seats" 402, because capacity is 1 without a subscription (§3.2); seat list showing only the owner | any paid state; any webhook; any flow that needs a second seat |
| Staging (`npm run test:billing:staging`) | named manual run | real Checkout → webhook → fetch → apply → paid badge; Portal cancel → downgrade; `send_invoice` paid → members entitled; company browser flow on a real subscription (redeem, member revoke, ownership transfer); disputes via Stripe test cards (won and lost); grace expiry via Test Clocks | — |

Rules:

- Local e2e never seeds paid state and never adds a test-only route to do so:
  such a route would be a production backdoor. The same holds for company
  capacity: a company has one seat until a real subscription exists, so
  multi-member browser flows are staging evidence, and locally they are proven
  at the HTTP layer against a writer-seeded `company_subscriptions` row (G4).
- Staging is **required** evidence for the §14 clauses marked "staging". Until
  a staging environment exists (`CLOUDFLARE_ACCESS_STAGING.md:114-126`) and the
  run is recorded, those clauses are reported `APPROVE-AS-BLOCKED`, never
  `APPROVE`.

---

## 8. Corporate accounts

All company flows are rows C-1…C-13, O-1, and E-1/E-2 of §3.7. There is no
other normative description.

---

## 9. Referrals

### 9.1 Flow

1. Paid tutor opens the Referrals panel → `GET /api/referrals/me`.
2. Link: `https://<teacher-host>/whiteboard?ref=<CODE>` — teacher host
   directly. The marketing-host `/whiteboard*` redirect rebuilds from
   `url.pathname` only and drops the query (`worker.ts:934-937`); preserving
   `url.search` is a separate reviewed change. **[assumption]** the query
   survives the Access round-trip; verify in the Phase 5 e2e. Invitees are
   tutors who sign in through Access anyway; a marketing-page entry is a
   follow-up, not a defect.
3. Client stores the code in `localStorage.tp_ref`, never a third-party
   cookie.
4. At checkout the client sends `referralCode`; the server validates (exists,
   active, not expired, not self, caller not already redeemed — bad codes are
   silently ignored) and sets `client_reference_id`,
   `metadata.referrer_code`, `subscription_data.metadata.referrer_code`, and an
   optional promotion code.
5. Pending redemption: P-3. Confirmation: P-7 (`amount_paid > 0`). Reversal:
   P-11 and D-3.
6. Count = distinct referred accounts with a live redemption; pending and
   confirmed shown separately.

### 9.2 Abuse controls

Self-referral rejected (account and customer id); one referrer per account,
ever; code lookup rate-limited; reward cap 6/12 months; 30-day clawback;
`max_redemptions`/`expires_at`; confirmation requires a real payment. Optional
Stripe mirror: coupon + promotion code with
`restrictions.first_time_transaction=true`.

### 9.3 Rewards (D9, v1.1)

Invitee first month free via promotion code (annual only). Referrer one month
customer credit via `POST /v1/customers/{id}/balance_transactions` (negative
amount), through a `referral-credit` operation retried by R-1. No cash
payouts.

---

## 10. Pricing page rebuild

Single static `/pricing`; no client price fetch (`requestGuard.ts:360-388`,
`connect-src 'self'`, SEC-015).

1. `.price-head` + `<h1>`; "Students always join free".
2. Free + Tutor Pro (monthly/annual, GBP from §4.2, "ex VAT").
3. Corporate tier: per-seat bands, min 3, annual, "card for 3–9, invoice for
   10+ (subject to approval)".
4. Comparison table (`<caption>`, scoped `<th>`) with new `.compare*` styles
   in `public/brand.css` (pattern `brand.css:176-196`).
5. FAQ `<details>`: billing (hosted Checkout/Portal), cancel (boundary
   downgrade, no lesson disruption), downgrade (archive, never delete), VAT,
   referral (publish only after Phase 5).
6. New marketing paths cost four registrations; v1 avoids them.

**Copy-lock test:** reads `public/pricing.html` and asserts every advertised
number equals `PLAN_CATALOG`/`CORPORATE_SEAT_BANDS`, and that no link contains
`price=`, `amount=`, or `checkout` (`UX_IMPROVEMENTS.md:84`).

---

## 11. Profile and company UI

### 11.1 Data flow

- `/auth/session/current` gains `plan` and `company` (`sessionCurrent`
  `worker.ts:445-470`, DO `IdentityDO.ts:388-394`). `page.tsx:15-21` and
  `RoomClient.tsx:564-600` already parse this payload.
- The UI renders server answers; it never derives a plan or submits a price.

### 11.2 Entry points

| Entry | Where | Notes |
| --- | --- | --- |
| Plan + Subscription | `UserProfileMenu` "Plan" section | read-only summary; Upgrade/Manage navigate to server-issued URLs; shows "payment overdue until <date>" during grace and "billing on hold" during a dispute hold |
| Company name + role | Same menu | only when the session carries `company` |
| Company admin | `/account/company` for owner/admin | seats (display name, role, joined), capacity and any pending seat change, invite link (`#` fragment), invoice link, transfer, rename, disable |
| Referral invite + counter | `ReferralPanel` in the profile menu | lazy fetch; `CopyButton`; counter chip + `role="status"` |
| Corporate seat invites | `/account/company`, not room share surfaces | distinct from student join link/PIN |

### 11.3 Student-safety boundary

- `RoomTopNav` returns `null` on the guest host (`RoomTopNav.tsx:31-37`);
  guest pages skip session reads (`RoomClient.tsx:564-567`,
  `AccessSessionBootstrap.tsx:15-18`).
- New menu props default absent and render nothing (SupportButton idiom,
  `SupportButton.tsx:17-18`).
- Every new route is teacher-only, origin-guarded, session-validated; guest
  host 404 pinned (`requestGuard.test.ts:113-118`,
  `tests/e2e/guest-join.spec.ts:342-363`).
- `GuestJoinPrompt`/`WaitingRoom` stay billing-free.

### 11.4 Test conventions

- Real-object exemplar `TeacherRoomsPanel.test.tsx:7-26`; network behavior
  behind injected `request` props; do not add mocks to the mock-based
  `UserProfileMenu.test.tsx` (AGENTS.md:62-66).
- Fix the conditional `aria-controls` (`UserProfileMenu.tsx:184` vs `:204`)
  only with a red test.

---

## 12. Phased implementation plan (TDD)

Every phase: red test first → smallest green change → refactor; real objects
only; `npm test`, `npm run test:workers` (build `out/` first), `npm run
typecheck`; `npm run test:e2e` when browser/HTTP/session reachable; kill the
listed mutants and revert them; rate limits ship with their routes. Commit at
each phase gate. §3.7 row ids identify the behavior each red test pins.

### Phase 0 — Decisions and SEC-015 amendment (docs only)

- Owner answers are recorded in §2.1 (2026-09-11). **Done 2026-09-11:** §5.2
  items 1–7 applied to `security.md` (target market, `(account_id, source)`
  entitlements with `entitlement_audit` and no entitlement epoch bump, Free =
  1 room / host + 1 student / 90 days, seat counting, audit acceptance, billing
  acceptance text); webhook reachability choice recorded in §5.3 item 7.
- D12 prerequisite. **Verified 2026-09-11 against Stripe docs:** the
  Subscription object exposes `pause_collection` and its status is unchanged
  while collection is paused; the Customer Portal cannot pause or un-pause
  payment collection (`features.subscription_pause` was removed on 2024-08-01
  and Stripe support states "The Customer Portal does not support allowing a
  customer to pause a subscription"). Option (a) stands. Re-confirm on the
  pinned `Stripe-Version` when `stripeClient.ts` pins it (Phase 2); switch to
  option (c) only if that check fails.
- Verify referenced paths/commands; run `git diff --check` (and, while `spec/`
  is untracked, `git diff --no-index --check /dev/null <file>` per file). No
  code.
- Evidence: `git diff --check` clean; SEC-015 text reviewed against §5.2.
- Note (2026-09-11): local dev/e2e state has accumulated >50 access accounts,
  so `wrangler.local.toml` sets `TUTOR_ACCOUNT_CAP = "1000000"` (local only;
  production `wrangler.toml` keeps 50, worker tests bind 10000).

### Phase 1 — Catalog, resolver, entitlement writer

**Status: done 2026-09-11 (`15fe06e`).** Evidence: unit 1608 passed, workers
463 passed, typecheck clean, e2e 130 passed / 5 skipped; mutants killed for the
resolver grace boundary/pause/precedence, the writer no-op and
processor_event_id guards, the audit unique index, the cap boundary, the
guest-count filter, and the internal plan-route exposure. Deviations recorded:
worker tests bind `TUTOR_ACCOUNT_CAP=10000` and `wrangler.local.toml` sets
1000000 because test/e2e storage is shared per file/accumulates across runs;
production `wrangler.toml` keeps 50. D12 re-confirmation on the pinned
Stripe-Version moves to Phase 2.

- Files: `catalog.ts`, `effectivePlan.ts`, `entitlementWriter.ts`;
  `identityStore.ts` (`entitlements`, `entitlement_audit`, tutor cap §3.9);
  `IdentityDO.ts` (`GET /accounts/plan`); `worker.ts` (403 on
  `tutor_cap_reached`); `wrangler.toml` (`TUTOR_ACCOUNT_CAP`).
- Red tests: catalog; resolver precedence, grace (P-6), and pause; writer
  audit once per cause for every cause kind; no-op writes no audit; static
  writer guard; no epoch bump on writer calls; the four §3.9 tutor-cap tests.
- Mutants: precedence; `now < grace_until` comparison; `collection_paused`
  check; audit unique index; writer epoch bump; tutor-cap check removed;
  guests counted toward the cap.

### Phase 2 — Stripe plumbing and ordering

**Status: implemented 2026-09-11 (`1bc6006`, follow-up `64fd1b8`); verifier
verdict APPROVE-AS-BLOCKED — staging absent (§15.2), no defect found.** Evidence:
unit 142 files / 1639 passed, workers 26 files / 499 passed, typecheck clean,
e2e 130 passed / 12 skipped (the 12 include the 7 `E2E_STAGING_BASE_URL`-gated
`billing-staging` tests). An independent verifier on `1bc6006` in an isolated
worktree re-ran the scoped suites and killed the class-1 watermark, webhook
signature-verification, and origin-exemption mutants; the orchestrator killed
the watermark-gating and origin-exemption mutants in the main checkout; the
staging runner fails closed (exit 2) without `E2E_STAGING_BASE_URL`. The
follow-up closed the verifier's two §7.1 gaps (`invoice.payment_failed` after a
recovering `invoice.paid`; pause retry after a newer resume) and moved signature
verification to `crypto.subtle.verify` (killing a rotated-secret mutant).
Deviations: the load-sensitive scene-write rate-limit test timeout was raised
20 s → 60 s after the two added worker files (assertions unchanged); the webhook
handler normalizes fetched Stripe JSON into the DO's camelCase objects contract;
a successful fetch-then-apply is staging-only evidence, so every §14 staging
clause remains APPROVE-AS-BLOCKED. D12 re-confirmed on the pinned
`2026-08-26.dahlia` (option (a): `pause_collection` on Subscription update).

- Files: verifier, config, `stripeRequest.ts`, `stripeClient.ts`;
  `billing_events`/`billing_subscriptions`/`billing_dispute_holds`/
  `billing_effects`/`billing_sweeps`/`billing_operations`/`billing_payments`;
  webhook route, guard exemptions,
  branch placement; `/billing/events/apply`, `/billing/events/status`,
  `/billing/operations`, `/billing/operations/settle`;
  `.github/workflows/billing-staging.yml`.
- Red tests: verifier cases; route cases from §7.6 "Worker route"; apply:
  dedupe, rollback → 500, class-1 skip and tie, absorbing cancel, class-2
  once-per-object, every reversed-delivery case in §7.1; P-4/P-5/P-8 grace;
  operations subject scoping and hash 409.
- Mutants: tolerance; dedupe; livemode; effect gated by watermark (must fail
  the reversed `invoice.paid` test); tie dropped; `grace_until` overwritten on
  repeat failure.

### Phase 3 — Personal subscriptions, disputes, enforcement, profile

**Status: complete on the local evidence layers 2026-09-12 (waves 1–4; latest
`4e885cc`, `7105284`); independent verifier APPROVE on `e0a379f`, `00ad95b`,
`cd67bac` and `7105284`; staging stays APPROVE-AS-BLOCKED.** Evidence: unit
1728 passed, workers 28 files / 562 passed, typecheck clean, e2e 136 passed /
12 skipped. Delivered wave 1: checkout/portal builders (P-1 server-selected
price, `op:account:<id>:<op>` idempotency keys, referral metadata per §9.1,
promotion-code discount); effective-plan occupancy at room create/settings and
the waiting queue; RoomDO admission capped on both approve paths
(`/room/waiting` and `/room/requests/:accountId`) with fail-closed plan reads;
the client plan parameter is always stripped before forwarding
(`planMaxUsers.ts`, unit-tested). Verifier mutants killed: admission cap
removal, direct-approve clause, forged plan parameter, `resolvePlanMaxUsers`
null, checkout price substitution; the one surviving mutant — unconditional
strip when the plan read fails — was fixed in `e0a379f` and re-verified.
Deviations: load-sensitive burst tests in `roomDO.workers.test.ts` were given
60 s caps after the per-admission cross-DO read; `handlers/room.ts` and
`limits.ts` were edited beyond the original slice list; `membership.ts` is
unchanged because the waiting-queue cap follows the plan-derived room
occupancy written at the named enforcement sites. Wave 2 added
archive-on-downgrade/restore (derived from the effective plan and owned count,
both approve paths gated, reads open, never deleted, fault-injected fail-closed
coverage) and the profile plan/company summary (real-object component tests,
server-issued URLs only); the burst rate-limit test now delivers through the
DO's real handler so load cannot split a burst across the sliding window.
Verifier mutants killed in wave 2: archived-write gate, archived admission,
restore cap, profile grace notice, server-URL navigation, and the
consecutive-breach close; the one surviving archive fail-open mutant was pinned
by `00ad95b` and re-verified. Wave 3 added owned-room reservation from the
effective plan (`c6a40e3`, fail-closed to Free), gating of the remaining
archived-room writes (`e7e9d88`: settings POST/PATCH, library, file
reserve/settle/authorize-write), and the session `plan` payload with the
profile-menu wiring (`e378414`, `7efeb05`, `cd67bac`): the effective plan now
carries `graceUntil`/`collectionPaused` from the selected entitlement row, so
the grace and hold notices render, `company` stays null until Phase 4, and the
in-room call sites pass the props. One verifier REJECT (the `page.tsx`
session→menu bridge survived a mutant) was fixed by `7efeb05`/`cd67bac` and
re-verified APPROVE. Wave 4 completed Phase 3: checkout/portal routes with
teacher-only guards, session, exact origin, server price, server-built URLs and
10/hour/account counters (`4e885cc`); SEC-A17 base/key validation and SEC-A27
closed before wiring; SEC-A18/A19 webhook attestation (verified payload hash
stored verbatim, `signatureVerified` required, livemode re-asserted at the
writer); the D-6 executor (claim → Stripe outside the transaction → settle with
the claimed version; superseded versions never sent); the profile sends a fresh
`operationId` per click; `tests/e2e/billing-funnel.spec.ts` (6 tests); and the
verifier-REJECTed company seat defects were fixed (pending state persisted
through writer-owned functions, invite TTL 72 h) — verifier APPROVE on
`7105284`, unit 1728, workers 562, typecheck clean, e2e 136 passed / 12
skipped. Phase 3 is complete on the local evidence layers; the staging paid
path stays APPROVE-AS-BLOCKED (§15.2), the H2 confirm-on-webhook-read wiring is
deferred to R-1 (Phase 7), and `company` stays null until Phase 4 writes
memberships.

- Files: checkout/portal routes; effective-plan enforcement at every boundary
  (§4.1); archive-on-downgrade; dispute rows D-1…D-6 and the collection
  executor (§7.2) per the D12 answer; `UserProfileMenu` plan section.
- Red tests: P-1 builder; paid-state HTTP tests (§7.6) for limits, admission,
  and grace expiry at a boundary; archive/restore; D-1…D-6 (including lost
  observed first, two open disputes, and a superseded collection call);
  component tests with injected request; e2e for the unpaid browser path; staging spec for the
  paid path; an open socket with no HTTP activity closes at idle expiry, the
  alarm never refreshes `idle_expires_at`, and an HTTP-refreshed session
  survives to the 12 h absolute bound (pins §5.2 item 7).
- Mutants: client price accepted; grant from redirect; admission cap;
  downgrade bumps epoch; dispute hold not applied; resume while another
  dispute still holds; executor sends a superseded version; R-1 skips repair
  when `applied_version = desired_version`; confirmation leaves the in-flight
  marker set; P-9 leaves `desired_collection` unchanged; settle skips the
  version check.

### Phase 4 — Corporate accounts

**Status: implemented on the local layers 2026-09-12 (`8ed04bd`, fixes
`ce680b1`, `7a2651a`); independent verifier APPROVE on `ce680b1` and
`7a2651a`; staging corporate flows remain APPROVE-AS-BLOCKED.** Evidence: the
public `/api/company*` routes and internal DO routes (C-1…C-13) with per-route
rate limits, the `/account/company` page with real contracts and live
transfer/rename/disable, C-4/C-5 first-paid fan-out and status copies through
the writer, and `tests/e2e/corporate-account.spec.ts` (create, 409 repeat,
owner-only seat list, fragment invite mint/revoke, second identity 402).
Deferred with spec lines: O-1 invoice approval, real Stripe Customer success
(C-2) and seat-update success (staging), member display names, hosted invoice
URL. One verifier REJECT (unreachable page, parser/body contract mismatches,
inert actions, missing fan-out) was fixed by `ce680b1` and re-verified.

- Files: company tables and triggers; company DO + Worker routes;
  `/account/company`; card and invoice flows; seat reservation;
  `assertOneActiveOwner`.
- Red tests: C-1…C-13 and O-1 acceptance tests (multi-member cases against a
  writer-seeded subscription, §7.6); E-1 owner transfer; single-seat local e2e
  corporate spec; multi-member browser flow in the staging spec.
- Mutants: owner assertion removed; capacity check reads `quantity` instead of
  `seatCapacity`; invite consumption tested via `redeemed_by`; invoice approval
  gate.

### Phase 5 — Referrals

**Status: implemented on the local layers 2026-09-12 (`8ed04bd`, `ce680b1`);
independent verifier APPROVE on `ce680b1`; v1.1 credit/reward flows are out of
scope.** Evidence: `src/lib/referrals/` (CSPRNG codes, ledger with
self-referral/one-per-account/£0/reversal rules, caller-only summary), the
teacher-only `GET /api/referrals/me` with its 60/hour/account counter, checkout
code validation (dead codes silently ignored), P-3 pending redemption on
`checkout.session.completed`, P-7/P-11 through the ledger, the lazy
`ReferralPanel` (link copy, `role="status"` counter, retryable error), and
`tests/e2e/referral.spec.ts` (lazy load, honest empty state, guest denial,
session requirement; 2 sub-cases skipped for lack of local paid state).

- Files: referral tables; `src/lib/referrals/`; checkout attribution; P-3/P-7/
  P-11 effects; `GET /api/referrals/me`; `ReferralPanel`; v1.1 credit
  operation.
- Red tests: code entropy; self-referral; one referrer per account; £0 invoice
  does not confirm; reversal reduces net; caller-only; panel error state.
- Mutants: self-referral; one-per-account index; `amount_paid` check.

### Phase 6 — Pricing page and copy lock

**Status: done 2026-09-12 (`ce680b1`); independent verifier APPROVE.**
Evidence: `public/pricing.html` rebuilt to §4.2 with every advertised figure
locked by a 15-test copy-lock suite (prices, bands, ex-VAT wording, limits from
`PLAN_CATALOG`/`CORPORATE_SEAT_BANDS`, comparison table, FAQ, no referral copy
before Phase 5, no price/amount links or card fields); `.compare*`/`.bands`/
`.vat` CSS recipes pinned; band-figure, ex-VAT, allowlist, and `indexable`
mutants killed.

- Files: `public/pricing.html`, `public/brand.css`; copy-lock test; tax
  wording; band lock. Mutants: path allowlist, `indexable`, band constant.

### Phase 7 — Reconciliation, erasure, evidence

**Status: R-1 core done 2026-09-12 (`7a2651a`); R-1 authoritative fetch and
dispute sweep plus SEC-A22…A26 done (`a8e348f`); per-host e2e header evidence
added (`bcecca1`) and independently verified APPROVE; the rest of Phase 7 is
open.** Decisions and residuals recorded here:
Strict-Transport-Security deliberately omits `preload` (it would commit the
whole `sen-tutor.co.uk` zone; an owner/zone decision); a dispute page larger
than 100 applies the page and alerts but advances the watermark only over the
mapped page (no spec-mandated pagination); the spec-named `reconcile drift is
applied once per run id` test exists, while run-scoping is more directly
protected by `applies a fetched subscription once per run id`. Evidence: daily
Cron Trigger
(`17 3 * * *`) → IdentityDO `/billing/reconcile`: stale in-flight markers
(>15 min) settle failed and open an H1 repair generation, `applied < desired`
re-claims, drift repairs from authoritative observations, and a P-6 grace audit
exactly once per deadline without touching status/`grace_until`; the cron
executes repaired claims through the existing executor (Stripe success remains
staging-only); drift/timeout/failed-operation alerts. Delivered since:
per-subscription Stripe fetch/apply (P-2/C-5), dispute sweep, seat-settlement
recovery, company-create/seat-change retries, the price-tier check, E-2
erasure core, and `SECRETS_ROTATION.md` + `SECURITY_OPERATIONS.md`
(`a8e348f`, `2b2505a`, `29b7578`, `510d821`). Delivered last: the D11
operator surface (env allowlist on Worker and DO, audited `operator:<email>`,
`scripts/operator.mjs`), O-1 invoice approval, O-2 dispute review, member
display names, and the hosted invoice URL with an awaiting-payment state.
Remaining Phase 7: the D10
Access-cost recheck and the operational owner assignments / alert rules /
PITR drill recorded as placeholders in `SECURITY_OPERATIONS.md`. The SEC-015
§14 evidence set and every staging clause stay APPROVE-AS-BLOCKED (§15.2), and
`security.md` boxes stay unchecked until a staging-backed verifier APPROVEs.
Note: the Stripe 24-hour-window recovery (`29b7578`) classifies from the
authoritative fetched quantity with a pure unit-tested classifier; the real
Stripe read remains staging-only, and drift is release-plus-alert rather than
persisting the fetched quantity. Note also that `4f5dabd` on the
`infra/terraform-cloudflare-parametrised` branch moved production under
`[env.prod]` and dropped the top-level Cron Trigger; main carries the trigger
at the top level, and the branch needs `[env.prod.triggers]` when merged.

- R-1 (drift, grace sweep, seat settlement, outbound retries, dispute sweep,
  price tiers); O-2; E-2 erasure and export; secrets rotation doc; Access-cost
  recheck (D10); SEC-015 evidence per §14; independent verifier before any
  checkbox.

---

## 13. Test matrix

| Area | Files |
| --- | --- |
| Catalog/resolver/writer | new `src/lib/plan/catalog.test.ts`, `src/lib/plan/effectivePlan.test.ts`, `src/lib/identity/entitlementWriter.test.ts` (incl. static writer guard); extend `src/lib/plan/limits.test.ts` |
| Identity/store/erasure | extend `src/lib/identity/identityStore.test.ts`, `src/lib/identity/sessionStore.test.ts` |
| Billing units | new `src/lib/billing/stripeSignature.test.ts`, `stripeConfig.test.ts`, `stripeRequest.test.ts` |
| DO behavior | new `src/do/billing.workers.test.ts`, `src/do/company.workers.test.ts`; extend `src/do/identityDO.workers.test.ts` |
| Worker routes | new `src/worker.billing.workers.test.ts`; extend `worker.access.workers.test.ts`, `worker.marketing.workers.test.ts`, `src/do/roomDO.workers.test.ts` |
| Route guards | extend `src/lib/worker/requestGuard.test.ts` |
| Components | new plan/referral/company tests; `UserProfileMenu.test.tsx` props-only |
| E2E (local; Stripe unset; single-seat company paths) | new `tests/e2e/billing-funnel.spec.ts`, `tests/e2e/corporate-account.spec.ts`, `tests/e2e/referral.spec.ts`; extend `account-profile.spec.ts`, `guest-join.spec.ts`, `ux-capture.spec.ts` |
| Staging (named) | new `tests/e2e/billing-staging.spec.ts`, `npm run test:billing:staging`, `.github/workflows/billing-staging.yml` (workflow_dispatch) |
| Copy lock / CSS | new pricing copy test; extend `src/deployment/brandCss.test.ts` |

Mutation record format: file, line, mutation, failing test.

---

## 14. SEC-015 acceptance mapping

| Clause | Local unit/workers (always) | Local e2e (always) | Staging (required where marked) |
| --- | --- | --- | --- |
| Forged/replayed/stale/wrong-signature webhook changes nothing | verifier + route tests | — | — |
| Client-declared plan/price ignored | P-1 builder test | — | staging: Stripe accepts the built request |
| Checkout redirect alone entitles nobody | no grant path outside apply (static writer guard + DO tests) | redirect page shows Free | staging: grant arrives only with the webhook |
| Duplicate delivery applies once; failed apply retries | dedupe + rollback tests | — | — |
| Out-of-order delivery never loses an effect or resurrects a cancel | §7.1 reversed-delivery tests | — | — |
| Cancel / failed renewal past grace / chargeback remove entitlement at the next boundary | P-6, P-9, D-1 DO tests + paid-state HTTP tests | — | staging: Portal cancel and test-card dispute |
| Dispute suspends billing; `won` resumes only when no other dispute holds; `lost` cancels even when observed first (D12) | D-1…D-6 DO tests incl. lost-first, two disputes, superseded collection call | — | staging: test-card disputes (won and lost) |
| One account cannot read/modify another's billing state | caller-only + role negatives; subject-scoped operations | guest/other-account denial | — |
| Plan limits enforced server-side against a raw client | paid-state HTTP tests incl. RoomDO admission | Free limits | — |
| Student session can never reach a billing route | route guard tests | guest e2e | — |
| No entitlement row behaves exactly as Free | resolver tests | Free e2e | — |
| Archive-on-downgrade reversible | Phase 3 tests | — | — |
| Catalog immutable at runtime | static module | — | — |
| Every transition audited exactly once | writer cause tests | — | — |
| Downgrade does not break an in-progress lesson (amended) | no-epoch-bump + idle-expiry tests | — | — |
| Real processor round-trip | — | — | staging: required |

---

## 15. Risks and open questions

1. **D1/D2 are material SEC-015 amendments**; do not implement before they
   land.
2. **Staging does not exist yet** (`CLOUDFLARE_ACCESS_STAGING.md:114-126`);
   without it the staging-marked clauses in §14 stay blocked.
3. **Dispute policy (D12)** depends on Stripe capabilities: if
   `pause_collection` is unavailable on the pinned version, or the Portal can
   un-pause, option (a) falls back to (c).
4. **Operator staffing (D11/D12):** invoice approval, non-won/lost dispute
   closures, unmapped disputes, and failed outbound operations all page a
   person.
5. **Re-fetch latency:** a Stripe outage returns 500 and Stripe retries for up
   to three days; R-1 is the backstop.
6. **Concurrent-delivery drift** (§7.1 residual) is bounded by the next event
   or R-1 and cannot resurrect a cancel.
7. **Access seats (D10):** tutors are capped at 50 (§3.9). The app's count and
   Cloudflare's seat count diverge unless departed tutors are also removed
   from Zero Trust; lifting the cap needs a re-costed Access plan.
8. **Seat-list display names** are a new cross-account disclosure (SEC-016).
9. **Referral attribution shape** (`session.discounts[].promotion_code`) must
   be validated in staging before the schema freezes.
10. **Prices unattested**; consider a price test before locking the catalog.
11. **Reconciliation requires Workers Paid**; confirm.
12. **Marketing-host e2e origin** does not exist in `run-e2e.mjs`; keep testing
    `/pricing` on the teacher host.
13. **Erasure vs invoice retention** documented per D8/SEC-016.
14. **Accepted lesson residual:** an already-open lesson keeps its admitted
    participants after a downgrade until the session's idle check, or up to
    the 12 h absolute expiry while HTTP activity refreshes idle (§5.2 item 7).
15. **Price-tier drift** is checked only by R-1; its alert must page.
16. **Unconfirmed collection calls wait for the next read.** A timed-out
    pause/resume/cancel is confirmed or failed by the next authoritative read
    of that subscription, which may be the daily R-1 if no webhook arrives.
    Until then Stripe billing can lag; entitlement does not, because
    `collection_paused` follows the dispute holds directly (§3.7 Disputes).

---

## 16. Traceability and implementation rules

- findings 01 → §3; findings 02 → §5.3, §10; findings 03 → §4.2, §9.3;
  findings 04 → §3.5, §7, §9; findings 05 → §11.
- AGENTS.md rules: one behavior per cycle; no production code before a failing
  test; no mocks/stubs/test doubles in new tests; negative test before every
  guard; `npm run build` before worker tests; e2e only through
  `scripts/run-e2e.mjs`; one mutant at a time with recorded evidence; separate
  verifier before `security.md` checkboxes.

---

## 17. Review history and v5 findings

### 17.1 History

Earlier review items are resolved in the body; their superseded wording has
been removed rather than annotated. Where each resolution now lives:

- Review 1 (A1–A5, B1–B4, C1–C4, D-1–D-6, E1–E5, F): §3.2, §3.4, §3.7, §5.2,
  §5.3, §6.3, §6.4, §7.1, §7.6, §9, §12.
- Review 2 (V2–V8) and residuals R1–R3: §3.2, §3.7 C-3/C-4, §5.2 item 7,
  §6.3, §7.1, §7.2, R-1, D10.
- Review 3 (N1–N6 and minors) and the v4 addendum (D12, dispute mapping and
  sweep, idle-expiry regression test): §2 D12, §3.5 (`billing_subscriptions`,
  `billing_sweeps`, `collection_paused`), §3.7 D-1…D-5, O-2, R-1, §5.2 item 7,
  §6.2, §6.3, §7.1, §12 Phase 0 and Phase 3.

### 17.2 Review 4 (F1–F7)

| # | Finding (validated) | Resolution | Acceptance test |
| --- | --- | --- | --- |
| F1 | **Confirmed.** v4's `billing_subjects` watermark was per subject and gated the whole event, so an older `invoice.paid` or dispute delivered after a newer subscription update was dropped with its payment, referral, and `first_paid_at` effects. | §7.1: three classes. Subscription state is ordered per `processor_subscription_id` (`billing_subscriptions`), strict `<`, ties applied, cancel absorbing. Payment, referral, and dispute effects are deduplicated per object in `billing_effects` and never compared with the watermark. Dispute effects follow the fetched dispute status. | `billing.workers.test.ts › reversed: older invoice.paid after newer subscription.updated still records payment and confirms referral`, plus the five other §7.1 reversed-delivery cases; mutant "effect gated by watermark" must fail it. |
| F2 | **Confirmed.** v4 §3.3 said billing writes entitlements only inside the webhook transaction, while membership redemption/revoke, company disable, reconcile, operator actions, and erasure must also change entitlements, and its audit index assumed a processor event id. | §3.3: one `entitlementWriter.ts`, called inside the caller's transaction, never opening its own or calling the network. Every write names a cause; audit is unique per `(subject_kind, subject_id, cause_kind, cause_id)`; `processor_event_id` only for processor causes. | `entitlementWriter.test.ts › audit is written once per cause for every cause kind` and `› no module other than entitlementWriter.ts writes the writer-owned tables`. |
| F3 | **Confirmed.** v4's resolver entitled `past_due` with no deadline. | §3.1/§3.5: `grace_until` persisted (CHECK ties it to `past_due`), set from the first failure's `event.created` + 7 d, never moved by repeat failures, cleared on recovery, re-opened only by a failure after recovery. The resolver compares with the boundary's `now`, so expiry needs no job; the daily sweep only audits. | `effectivePlan.test.ts › past_due entitles before grace_until and not at it`; `billing.workers.test.ts › grace: repeat failure does not extend grace_until`; `› grace: failure after recovery starts a new window`. |
| F4 | **Confirmed.** v4 checked "decrease ≥ active members" before an out-of-transaction Stripe call; a redemption could land in between. | §3.2: two-phase reservation with `pending_quantity`/`pending_operation_id`; capacity = `MIN(quantity, pending_quantity)` from reservation commit, checked in the redemption transaction; one pending change per company; settle on success/failure; unknown outcomes recovered by webhook or R-1 with the same idempotency key. | `company.workers.test.ts › redemption during a pending decrease is refused above the target`; `› Stripe failure releases the reservation; unknown outcome stays pending until reconcile settles it`. |
| F5 | **Confirmed.** v4 §7.6 said local e2e drives the webhook state machine with signed payloads, but a successful webhook needs the Stripe re-fetch, which local runs cannot reach without a double. | §7.6: evidence table. Local tests prove each side of the fetch (route up to the fetch, apply with fetched objects, paid-state HTTP via writer-seeded DO state) and never claim end-to-end success; local e2e covers unpaid paths only (narrowed to single-seat company paths by G4), with no seeding backdoor; staging is required evidence for the marked §14 clauses and is `APPROVE-AS-BLOCKED` until run. Production verification is unchanged. | `worker.billing.workers.test.ts › a correctly signed event whose fetch fails returns 500 and writes no billing_events row`; `billing-staging.spec.ts › test-mode checkout upgrades the profile badge only after the real webhook`. |
| F6 | **Confirmed.** v4 erasure nulled `redeemed_by` under `CHECK ((redeemed_at IS NULL) = (redeemed_by IS NULL))`, which would abort the erasure transaction. | §3.5/§3.8: CHECK becomes `redeemed_by IS NULL OR redeemed_at IS NOT NULL`; consumption is `redeemed_at`/`revoked_at`; erasure clears only `redeemed_by`; redemption never reads `redeemed_by`. | `sessionStore.test.ts › erasure keeps a redeemed invite consumed and its token still returns 404`; `identityStore.test.ts › CHECK rejects redeemed_by without redeemed_at`. |
| F7 | **Confirmed.** v4 required a seat-cap check against `company_subscriptions.quantity` for the founder's membership before any subscription row exists, and its partial unique index guaranteed at most one owner, not exactly one. | §3.2: bootstrap transaction creates company + owner membership; `seatCapacity` is 1 without a subscription row; the Stripe Customer is a separate outbound operation. `assertOneActiveOwner` ends every membership/company-state transaction; owner revoke is 409; ownership moves only by transfer, disable, or erasure. | `company.workers.test.ts › create inserts company and owner atomically; founder already in a company gets 409`; `› a transaction that would leave the company ownerless rolls back`; `› revoking the owner returns 409 and leaves one owner`. |

### 17.3 Review 5 (G1–G4)

| # | Finding (validated) | Resolution | Acceptance test |
| --- | --- | --- | --- |
| G1 | **Confirmed.** v5 D-3 required an existing matching hold, so a dispute whose first observed state was `lost` consumed its effect without cancelling. | §3.5/§3.7: disputes leave `billing_effects`; each dispute is a forward-only upsert in `billing_dispute_holds` from the fetched status, and terminal outcomes apply on first observation. | `billing.workers.test.ts › reversed: lost observed first still cancels` |
| G2 | **Confirmed.** A single `dispute_hold_id` per subscription let two disputes overwrite each other, so winning one could resume service while another was open. | §3.5/§3.6.9/§3.7: one hold row per dispute; a subscription is held while any hold is `open`/`review`/`lost`; resume only when none remain. | `billing.workers.test.ts › two disputes: winning one keeps the subscription paused until the other closes` |
| G3 | **Confirmed.** D-1/D-2 enqueued separate pause and resume operations, so an old pause retried after a resume could re-pause the subscription. | §3.5/§7.2/§3.6.14/D-6: `desired_collection` + `desired_version` recomputed transactionally; a single-flight executor sends only the current desired state, keyed per version; superseded versions are never claimed; R-1 corrects actual vs desired. | `billing.workers.test.ts › a pause retried after a newer resume is never sent`; `› R-1 re-issues the current desired state when Stripe disagrees` (test superseded by the §17.4 H1/H2/H3 tests) |
| G4 | **Confirmed.** With Stripe unset and nothing seeded, a company's capacity is 1, so the local e2e could not redeem, revoke a member, or transfer ownership. | §7.6/§12/§13: local e2e covers single-seat flows including the 402 refusal; multi-member cases are worker tests against a writer-seeded `company_subscriptions` row; the multi-member browser flow is staging evidence. | `corporate-account.spec.ts › a second account's redemption is refused with no free seats`; `company.workers.test.ts › redemption over capacity returns 402` (seeded capacity); `billing-staging.spec.ts › owner invites, member redeems, ownership transfers` |

### 17.4 Review 6 (H1–H4)

| # | Finding (validated) | Resolution | Acceptance test |
| --- | --- | --- | --- |
| H1 | **Confirmed.** The claim rule required `applied_version < desired_version`; after a success the two are equal, so R-1's promised repair could never claim when Stripe later drifted from the desired state. | §7.2 step 5: a repair generation increments `desired_version` without changing `desired_collection`, re-opening the claim with a fresh idempotency key; a Stripe-canceled subscription is never repaired. | `billing.workers.test.ts › R-1 repairs drift after a successful operation by opening a new generation` |
| H2 | **Confirmed.** An unknown outcome kept the in-flight marker and R-1 cleared it only on a mismatch, so a timed-out call that Stripe had applied left the marker set and blocked every later change. | §3.5 `in_flight_state`; §7.2 step 4: any authoritative read whose actual state matches `in_flight_state` settles the call as a success (`applied_version` advances, the marker clears, a newer version is claimed); an unconfirmed marker older than 15 minutes is failed and repaired through step 5. | `billing.workers.test.ts › a timed-out call Stripe applied is confirmed: applied_version advances and the marker clears` |
| H3 | **Confirmed by the v5.3 verifier.** Step 5 relied on P-9 setting `desired_collection = 'canceled'`, but no row wrote it, so a plain Portal cancel could look like drift and trigger a repair that tries to resume a canceled subscription. | P-9 now writes the terminal collection state (desired `canceled`, `applied_version = desired_version`, marker cleared); the §7.2 recompute list includes an observed Stripe cancel. The verifier's liveness note — an unconfirmed call can wait for the daily R-1 — is recorded as accepted residual §15.16. | `billing.workers.test.ts › Stripe cancel sets desired canceled, clears the in-flight marker, and is never repaired` |
| H4 | **Confirmed.** Step 3 settled against whatever marker was current, so if a webhook confirmed version 1 and version 2 was claimed before version 1's own response arrived, that late response would clear version 2's marker and mark it applied. | §7.2 step 3: settlement carries the claimed version and checks `in_flight_version` against it inside the transaction; a stale response only updates its own operation row and never touches `billing_subscriptions`. | `billing.workers.test.ts › a late response for version 1, after a webhook confirmed it and version 2 was claimed, changes nothing` |
