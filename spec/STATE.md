# Accounts, Billing & Referrals — Investigation State

Orchestrator: primary session (owns architecture + final merge).
Started: 2026-09-11.
Goal: one merged implementation spec for personal/corporate accounts, a rebuilt
pricing page with personal and corporate options, referral invites with usage
counts, Stripe checkout, and subscription management in the profile.

Note (v2, corrected): `git` **is** installed at
`C:\Program Files\Git\cmd\git.exe`; it is not on this shell's `PATH`.
This repo is on `main`; `spec/` is untracked. Use the full path for checks.

## Working agreement

- Each investigator writes **only** its own file under `spec/findings/`.
- Investigators do not edit `spec/STATE.md`, production code, tests, or configs.
- Evidence is cited as `path:line`; market claims cite URLs + access date.
- The orchestrator merges findings into `spec/IMPLEMENTATION_SPEC.md`.

## Recon summary (orchestrator, pre-investigation)

- Stack: Next.js static export + Cloudflare Worker (`src/worker.ts`), Durable
  Objects `RoomDO` (per room) and `IdentityDO` (global identity store, SQLite),
  LiveKit A/V, optional Access auth.
- Accounts: `src/lib/identity/identityStore.ts` — `accounts`,
  `access_subjects`, `sessions`, `authorization_audit`, `account_rooms`,
  `pending_erasures`. Account ids are opaque UUIDs; no email stored.
- Plans: `src/lib/plan/limits.ts` — every account is Free (1 room, 2 users).
  Paid tiers are designed but unbuilt in `security.md` SEC-015 (lines 848-1073).
- Pricing page: static `public/pricing.html` (Free + Tutor Pro, prices TBD).
  Marketing host routing in `src/lib/worker/requestGuard.ts`
  (`MARKETING_PAGES = ['/', '/pricing', '/terms', '/privacy']`).
- No Stripe code and no referral code exists anywhere in the tree (grep).
- Profile UI: `src/components/whiteboard/UserProfileMenu.tsx`.
- SEC-015 already fixes hard constraints (server-owned catalog, webhook-only
  entitlement, epoch-bound revocation, students never billable). The spec must
  extend, not contradict, unless the owner amends a decision.

## Investigators

| # | Area | Findings file | Status |
| --- | --- | --- | --- |
| 1 | Accounts/identity model, corporate (org) membership, seat data model | `spec/findings/01-accounts-identity.md` | complete |
| 2 | Pricing/marketing surface, plan limits, host/route constraints | `spec/findings/02-pricing-surface.md` | complete |
| 3 | Market research: corporate/team pricing + referral benchmarks (web) | `spec/findings/03-market-corporate-pricing.md` | complete |
| 4 | Stripe on Workers, subscriptions, referral mechanics (web + repo) | `spec/findings/04-stripe-subscriptions-referrals.md` | complete |
| 5 | Profile/subscription UI entry points and student-safe surfaces | `spec/findings/05-profile-ui.md` | complete |

## Merge status

- [x] All findings reviewed (01-05)
- [x] Open questions triaged into decisions vs assumptions (see spec §2)
- [x] `spec/IMPLEMENTATION_SPEC.md` written (phases, schema, routes, tests, security)
- [x] Final self-check against `security.md` SEC-015 acceptance criteria (spec §14)
- [x] Independent review (2026-09-11) processed: A1-A5, B1-B4, C1-C4, D-1-D-6,
      E1-E5 and smaller items resolved; spec rewritten as v2 (see spec §17)
- [x] Second review (V2-V8) + orchestrator residuals R1-R3 resolved in v3
      (re-fetch-before-transaction ordering, evidence split, tier drift,
      subject-scoped operations, SEC-015:937-944 amendment, signature-before-
      rate-limit, seat decrease semantics, first_paid_at, account-wide Access)
- [x] Third review (N1-N6 + minors) resolved in v4 (dispute outbox cancel,
      terminal_subscription_id, seats_provisioned dropped, fan-out statements,
      12 h residual bound, duplicate-lookup, webhook body cap/no rate limit)
- [x] D12 + dispute sweep added (v4 addendum): suspend-via-pause_collection,
      hold_state, collection_paused resolver rule, primary charge.customer
      mapping, reconcile sweep with billing_sweeps, N5 idle-expiry test
- [x] Fourth review (F1-F7) resolved in v5: ordering split into per-subscription
      state vs per-object effects, single entitlement writer with cause-keyed
      audit, persisted grace_until, two-phase seat reservations, evidence-layer
      split, consumed-invite CHECK, company bootstrap + one-owner guard; one
      authoritative lifecycle table (spec §3.7). Independent verifier: APPROVE
- [x] Fifth review (G1-G4) resolved in v5.1: per-dispute holds (terminal
      outcomes on first observation), desired-state collection executor,
      local e2e limited to single-seat company paths. Independent verifier:
      APPROVE
- [x] Owner decisions D1-D12 answered 2026-09-11 (spec §2.1). All as
      recommended except D10: tutors capped at 50 for now (spec §3.9). D5
      confirmed after clarification: invoice access starts on first payment
- [x] Sixth review (H1-H3) resolved in v5.3: collection executor gains a
      confirm step (in_flight_state) for timed-out calls Stripe applied, a
      repair generation for drift after success, and P-9 writes the terminal
      collection state so a Stripe cancel is never "repaired". Independent
      verifier: REJECT twice (H3, then a P-9 sub-case), APPROVE on the third
      pass
- [x] H4 resolved in v5.3: settle carries the claimed version and checks it
      against `in_flight_version` inside the transaction, so a late response
      for a confirmed/failed/cleared/replaced version changes nothing.
      Independent verifier: APPROVE
- [ ] `security.md` SEC-015 amendment recorded (spec §5.2: target market,
      entitlement model, downgrade propagation, seat counting, audit table,
      billing acceptance text)
- [ ] D12 prerequisite: `pause_collection` exists on the pinned
      `Stripe-Version` and the Customer Portal cannot un-pause (else D12
      falls back to operator queue)
- [ ] Webhook reachability chosen (spec §5.3 item 7: Access Bypass on the
      exact path vs a no-Access hostname)

## Orchestrator merge decisions (conflicts resolved)

- Entitlement stays account-keyed per SEC-015: per-account `entitlements` rows with
  `source='personal'|'company'`; company billing state lives in
  `company_subscriptions`; agent 1's `company_entitlements` table dropped in favor
  of agent 4's materialized-row model (spec §3.3).
- `company_members` is the seat list (agent 4) with owner/admin/member roles
  (agent 1); no separate `company_seats` table.
- Seat identity uses single-use invite tokens (agent 1) hashed like sessions.
- Referral primary flow uses `?ref=` on the app entry with server validation at
  checkout creation (CSP-safe), not a marketing-site cookie; agent 4's cookie
  variant kept as fallback (spec §9).
- Corporate page route must be `/account/company`, not `/whiteboard/company`:
  `/whiteboard/<id>` treats any valid room-id-shaped segment as a room on both
  hosts (`requestGuard.ts:150-157`), so `/whiteboard/company` would be a
  guest-reachable room URL. Verified in this session.
