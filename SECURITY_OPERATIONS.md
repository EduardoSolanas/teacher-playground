# Security operations runbook

Created 2026-09-12; revised 2026-09-13 when `security.md` was reduced to controls
and decisions. This is where the operational side lives: ownership, incident
response, monitoring, emergency revocation, backup and restore, billing
operations, and the owner actions in section 8 that code cannot perform.

Everything below is either **verified in this working tree** (with a
`path:line` citation) or explicitly marked **not present / unverified**. No
person is assigned anywhere in this repository, and this document does not
invent names: every owner, deadline, and contact field is a placeholder to be
filled by the account and product owners.

Companion documents:

- [`SECRETS_ROTATION.md`](SECRETS_ROTATION.md) - per-secret rotation procedures.
- [`SECURITY_REVOCATION_BOUND.md`](SECURITY_REVOCATION_BOUND.md) - measured
  revocation delays per path.
- [`SECURITY_BACKUP_RESTORE.md`](SECURITY_BACKUP_RESTORE.md) - PITR-only backup
  and restore procedure.
- [`SECURITY_INCIDENT_2026-08-17.md`](SECURITY_INCIDENT_2026-08-17.md) - the
  only recorded incident and the containment pattern it established.

## 1. Ownership and on-call (all placeholders)

Nothing in the repository defines a rota, a pager, an escalation path, or a
named owner. The table records the roles the Phase 6 gate requires; assign a
person and a date in the "Assigned" column before the release owner signs the
release sign-off (section 8).

| Role | Responsibility in this runbook | Assigned (TBD) |
| --- | --- | --- |
| Security / incident owner | Declares severity, commands containment, owns the incident record, decides notification with the data owner | **TBD - unassigned** |
| On-call primary and secondary | First response inside the acknowledgment window, executes revocation and rotation | **TBD - unassigned; no rota or pager exists** |
| Release owner | Signs the Phase 6/Phase 7 gates, accepts bounded waivers | **TBD - unassigned** |
| Cloudflare account owner | Owns zone, Access application, API tokens, and the hostname-closure runbook | **TBD - unassigned** ([`DEPLOY.md:112-144`](DEPLOY.md)) |
| Backup / restore operator | Runs the PITR restore and the staging drill | **TBD - unassigned** (`SECURITY_BACKUP_RESTORE.md:53` calls the RTO "operator-dependent") |
| Billing on-call | Decides when payment state and access state disagree (dunning, disputes, stuck holds) | **TBD - unassigned** (section 7) |
| Data owner | Decides whether affected rows are real personal data and whether notification applies | **TBD - unassigned** (`SECURITY_INCIDENT_2026-08-17.md:46-56`) |

Deadlines are also unassigned. Proposed starting values, to be confirmed or
replaced by the security owner: acknowledge Sev1 within **1 hour**; begin
containment within **4 hours**; publish an incident record within **5 business
days**; complete a post-incident review within **10 business days**. These are
drafts, not policy.

## 2. Incident response

### 2.1 Severity classification (proposed; confirm before relying on it)

| Class | Examples in this product |
| --- | --- |
| **Sev1** | Suspected exposure of sessions, credentials, board content, or pupil/customer PII; authentication or authorization bypass; billing entitlement obtained without a verified payment event; total outage of the teacher or guest surface |
| **Sev2** | Revocation not propagating within the documented bound; webhook/reconcile drift that could grant or retain access incorrectly; Access misconfiguration on the wrong hostname; one credential compromised but unused |
| **Sev3** | Single-account abuse; rate-limit or frame-shed anomalies without a confirmed victim; documentation drift with no runtime effect |

### 2.2 Process

1. **Detect.** From the alerts and log lines in section 3, or from a report.
2. **Triage.** Identify the boundary involved (Access/JWT, app session, room
   grant, billing entitlement, storage) and the worst plausible scope. Read
   logs through the redaction already built in - see 2.3.
3. **Contain.** For account or session compromise, revoke first (section 4) and
   rotate the implicated credential second
   ([`SECRETS_ROTATION.md`](SECRETS_ROTATION.md)). For a bad deploy, restore or
   roll forward; see section 5.
4. **Eradicate and recover.** Remove the cause, verify the boundary with the
   checks in section 4.4, and only then restore normal operation.
5. **Notify.** The security owner and data owner make the notification decision.
   `SECURITY_INCIDENT_2026-08-17.md` is the existing pattern: aggregate
   evidence only, no names, emails, room ids, board content, or token hashes.
6. **Post-incident.** Complete the incident record template in section 9, fix
   what code can fix with a failing test first, and add anything that needs a
   person to the owner actions in section 8.

### 2.3 Evidence handling

- Application logs are already redacted: `logAuthEvent` hashes or strips JWTs,
  `Bearer` values, cookies, and emails ([`src/lib/security/authEvents.ts:25-64`](src/lib/security/authEvents.ts));
  room background errors go through `redactForLog` ([`src/do/RoomDO.ts:213-229`](src/do/RoomDO.ts)).
- Never paste a live secret, session cookie, Access JWT, or board into an
  incident record, an issue, or a workflow log. The secret scan in CI
  (`npm run security:scan`, `package.json:18`; run at
  [`.github/workflows/ci.yml:40-41`](.github/workflows/ci.yml)) will flag
  committed material, but it cannot un-publish it.
- `SECURITY_INCIDENT_2026-08-17.md` is deliberately aggregate-only and is the
  template for tone and detail.
- Repository-incident follow-up already requires rotating or revoking affected
  credentials (`SECURITY_INCIDENT_2026-08-17.md`); do not close an incident on a code fix
  alone.

## 3. Monitoring and alerting

### 3.1 What the application emits

All security and billing signals are structured JSON log lines. The tables name
the exact event and where it is emitted.

**Auth and socket events** (`logAuthEvent` / `logSocketClose`,
[`src/lib/security/authEvents.ts:91-124`](src/lib/security/authEvents.ts)):

| Event | Meaning | Emitted at |
| --- | --- | --- |
| `auth_event` `type=auth_failure` `reason=unauthorized` | 401 from a missing or invalid session | [`src/worker.ts:339`](src/worker.ts) |
| `auth_event` `type=auth_failure` `reason=origin` | 403 from the exact-origin CSRF guard | [`src/worker.ts:368`](src/worker.ts) |
| `auth_event` `type=auth_failure` `reason=guest_join` | 403 guest join refused | [`src/worker.ts:376`](src/worker.ts) |
| `auth_event` `type=rate_limit` | 429 from an in-Worker cap | [`src/worker.ts:347`](src/worker.ts) |
| `auth_event` `type=revocation` `outcome=kicked/suspended` | Owner removed a participant | [`src/lib/whiteboard/handlers/presence.ts:154-159`](src/lib/whiteboard/handlers/presence.ts), [`:190-195`](src/lib/whiteboard/handlers/presence.ts) |
| `auth_event` `type=grant_change` `outcome=approved` | Waiting peer admitted | [`src/lib/whiteboard/handlers/waiting.ts:156-161`](src/lib/whiteboard/handlers/waiting.ts) |
| `auth_event` `type=socket_close` `reason=revoke` (code 4401) | Session/account/grant revoked on a live socket | [`src/do/RoomDO.ts:2323`](src/do/RoomDO.ts) (close sites also at `:2362`, `:2461`); code map at `authEvents.ts:98-104` |
| `auth_event` `type=socket_close` `reason=oversized` (1009) | Frame over the 32 MiB cap | [`src/do/RoomDO.ts:2362`](src/do/RoomDO.ts) |
| `auth_event` `type=socket_close` `reason=rate` (1008) | Sustained signaling abuse | [`src/do/RoomDO.ts:2461`](src/do/RoomDO.ts) |
| `event=frame_shed` | A rate-limited awareness frame was dropped, not a disconnect | [`src/do/RoomDO.ts:196-207`](src/do/RoomDO.ts) |
| `event=frame_oversized` | Frame rejected for size, with `bytes` and `cap` | [`src/do/RoomDO.ts:2369-2375`](src/do/RoomDO.ts) |
| `event=internal_error` | Redacted background/handler error with `op` and room id | [`src/do/RoomDO.ts:213-229`](src/do/RoomDO.ts) |

The 429 and rate-limit thresholds themselves are constants in
[`src/lib/worker/rateLimits.ts:16-41`](src/lib/worker/rateLimits.ts) (room
create 10/min, access request 20/min, presence 90/min, scene write 120/min,
guest PIN 5/min per IP) and the edge rate-limit rule on `POST /auth/guest`
([`infra/environments.json:98-115`](infra/environments.json)).

**Billing collection and reconciliation alerts** (all `console.error` lines with
an `alert` field):

| Alert | Meaning | Emitted at |
| --- | --- | --- |
| `reconcile_unreachable` | IdentityDO could not be reached by the cron | [`src/worker.ts:2116`](src/worker.ts) |
| `reconcile_failed` | IdentityDO reconcile returned non-OK | [`src/worker.ts:2123`](src/worker.ts) |
| `reconcile_invalid_response` | Response could not be parsed | [`src/worker.ts:2132`](src/worker.ts), [`:2249`](src/worker.ts) |
| `reconcile_subscription_fetch_failed` | Stripe subscription read failed | [`src/worker.ts:2189`](src/worker.ts) |
| `corporate_price_tier_mismatch` | Corporate subscription quantity/price falls outside the code-owned seat bands; the spec requires this to page | [`src/worker.ts:2202`](src/worker.ts) |
| `reconcile_dispute_fetch_failed` | Dispute list read failed | [`src/worker.ts:2215`](src/worker.ts) |
| `reconcile_disputes_truncated` | Dispute sweep exceeded one page | [`src/worker.ts:2221`](src/worker.ts) |
| `reconcile_apply_failed` | Observations/disputes could not be applied | [`src/worker.ts:2241`](src/worker.ts) |
| `reconcile_subscription_skipped` | Fetched status not representable locally | [`src/lib/billing/reconcile.ts:260`](src/lib/billing/reconcile.ts) |
| `collection_drift` | Stripe disagrees with local desired collection; repair opened | [`src/lib/billing/reconcile.ts:646`](src/lib/billing/reconcile.ts) |
| `collection_marker_timeout` | In-flight collection marker stale > 15 min; failed and repaired | [`src/lib/billing/reconcile.ts:673`](src/lib/billing/reconcile.ts) |
| `collection_settle_failed` | Settlement callback to IdentityDO failed | [`src/lib/billing/executor.ts:259`](src/lib/billing/executor.ts) |
| `collection_failed` | Stripe refused a collection change | [`src/lib/billing/executor.ts:267`](src/lib/billing/executor.ts) |
| `outbound_settle_failed` | A seat-change/company outbound operation could not be settled with IdentityDO | [`src/lib/billing/executor.ts:319`](src/lib/billing/executor.ts) |
| `outbound_retry_failed` | A pending outbound retry (for example company creation) failed and stays pending | [`src/lib/billing/executor.ts:442`](src/lib/billing/executor.ts) |
| `unmapped_dispute` | Dispute charge maps to no local subject; needs operator review | [`src/lib/billing/apply.ts:520`](src/lib/billing/apply.ts) |

The phase-7 spec says price-tier drift "must page" (`spec/IMPLEMENTATION_SPEC.md:1633`).

### 3.2 Where the logs go

- `[observability] enabled = true` ([`wrangler.toml:32-33`](wrangler.toml))
  enables Workers Logs for the Worker.
- `scheduled()` (`src/worker.ts`) runs the daily billing reconcile and emits
  the billing alerts above. It is triggered by `[env.prod.triggers]` `crons =
  ["23 4 * * *"]` in `wrangler.toml`; `deploymentPolicy.test.ts` fails if
  production loses that trigger (triggers are not inherited by `[env.prod]`,
  which is how it went missing once). After the next deploy, confirm the trigger
  under Workers & Pages > teacher-playground > Settings > Triggers.
- Live inspection: `npx wrangler tail teacher-playground --format json --search
  frame_shed` - the command the code records for the signaling-budget signal
  ([`src/do/RoomDO.ts:194`](src/do/RoomDO.ts)).

### 3.3 Alert rules, dashboards, and notifications (not built)

Verified absence: the Terraform stack owns the R2 bucket, the Access
application/policy, the guest rate-limit rule, and login branding only
([`infra/README.md:40-47`](infra/README.md)); it contains no notification,
alert, or dashboard resource. The repository contains no dashboard JSON, no
Cloudflare notification policy, and no pager integration. Treat everything in
this subsection as work to do, not as a control that exists.

Proposed rules for the security owner to approve and an operator to create in
the Cloudflare dashboard:

| Rule | Suggested trigger | Where the signal comes from |
| --- | --- | --- |
| Auth-failure spike | `type=auth_failure` rate per 5 min above a baseline set from a normal week | `auth_event` lines, section 3.1 |
| Sustained 429s | `type=rate_limit` non-zero for 10 min, or above a baseline | `auth_event` lines |
| Revocation storm / abnormal socket closes | `socket_close` count, split by `reason`, above baseline; any sustained 1008/1009 | `auth_event` lines |
| Signaling budget | `frame_shed` non-zero for 15 min | RoomDO line |
| Reconciliation | Every `reconcile_*` alert, and every `collection_drift` / `collection_marker_timeout` / `collection_failed` / `unmapped_dispute` | billing lines |
| Billing drift pages | Price-tier drift: the spec says it "must page" (`spec/IMPLEMENTATION_SPEC.md:1633`), and the code emits `corporate_price_tier_mismatch` ([`src/worker.ts:2202`](src/worker.ts)) | R-1 reconcile |
| Stripe webhook failure notifications | Enable in Stripe Workbench for the endpoint | recommended, not configured: `spec/findings/04-stripe-subscriptions-referrals.md:471-476` |

Owner to assign: **TBD - the person who owns the Cloudflare account and the
Stripe account must create and test these rules.** A rule that has never fired
against a synthetic event is untested.

## 4. Emergency account and session revocation

The measured bounds for every revocation path are in
[`SECURITY_REVOCATION_BOUND.md`](SECURITY_REVOCATION_BOUND.md) (policy table at
lines 114-124). This section is the operator procedure; that document is the
contract.

### 4.1 Immediate, room-level (bound 0 s)

An authenticated room owner can remove a live participant synchronously:

- `POST /presence` with `action: "kick"` or `"suspend"` bumps the room grant
  version, closes matching signaling sockets with code **4401**, and schedules
  LiveKit eviction (`SECURITY_REVOCATION_BOUND.md:13-29`,
  `src/lib/whiteboard/handlers/presence.ts:148-195`).
- A waiting-queue **reject** is a ban and lands the same way
  (`SECURITY_REVOCATION_BOUND.md:21-25`).
- Turning **guest access off** closes live guest sockets in the same request
  (`SECURITY_REVOCATION_BOUND.md:69-86`).

Use this first when the threat is confined to one room and the owner is
available.

### 4.2 Account-wide disable and revoke-all (bound ALARM-INTERVAL, 30 s default)

`IdentityDO` implements both operations:

- Paths: `/accounts/disable`, `/accounts/revoke-all`, `/accounts/enable`
  ([`src/do/IdentityDO.ts:127-129`](src/do/IdentityDO.ts)).
- Handler: POST with body `{accountId, actor, reason}` (exact-shape guard
  `isAccountBody`), dispatching to `revokeAllSessions` / `disableAccount` /
  `enableAccount` ([`src/do/IdentityDO.ts:1321-1340`](src/do/IdentityDO.ts);
  guard at `:357`; [`src/lib/identity/sessionStore.ts:785-816`](src/lib/identity/sessionStore.ts)).
- Each call advances the account `authorization_epoch`, revokes all unrevoked
  sessions, and records an authorization audit row with actor and reason in the
  same transaction (`changeAccountAuthorization`, `sessionStore.ts`).
- Open sockets close **4401** at the next alarm tick (default 30 s,
  `SECURITY_REVOCATION_BOUND.md:88-99`); the next HTTP request is refused
  immediately. **Enable** restores `active` without resurrecting revoked
  sessions (`SECURITY_REVOCATION_BOUND.md:123`).

**How an operator runs them.** The internal Durable Object paths stay
unreachable through the Worker (`/api/internal/identity/*` is 404, pinned in
`identityDO.workers.test.ts`). The operator surface exposes them instead:

```bash
curl -X POST "https://app-playground.sen-tutor.co.uk/api/operator/accounts/disable"   -H "Origin: https://app-playground.sen-tutor.co.uk"   -H "Content-Type: application/json"   --cookie "CF_Authorization=<your Access cookie>"   -d '{"accountId":"<account id>","reason":"<why, as it should read in the audit>"}'
```

- Actions: `disable`, `enable`, `revoke-all`. Run from a browser session signed
  in through Access as an address on `OPERATOR_EMAILS` (the route is 404 while
  that list is unset, 403 for any other address).
- The audit actor is always `operator:<your email>`; the body cannot name one.
- Unknown account 404, malformed body 400 (`worker.company.workers.test.ts ›
  operator account revocation`).

### 4.3 Verifying a revocation took effect

1. Query the account state with `POST /accounts/authorizations`
   (`{accountIds: [...]}`) and confirm `state: "disabled"` and the expected
   `authorizationEpoch` ([`src/do/IdentityDO.ts:117`](src/do/IdentityDO.ts),
   [`:1303-1319`](src/do/IdentityDO.ts)).
2. Confirm live sockets closed 4401 in Workers Logs (`socket_close`,
   `reason=revoke`).
3. Confirm the next HTTP request from the affected session returns 401.
4. Confirm LiveKit eviction is best-effort only: a kick returns 200 even if
   LiveKit is down (`SECURITY_REVOCATION_BOUND.md:101-112`). Verify the
   participant is actually gone from the call, not just from the socket.

### 4.4 Cloudflare Access and identity-provider lockout

Blocking a user or an identity provider at Cloudflare Access (or at the IdP)
stops the next Access login and any new token, but **does not by itself close
an app session or a live socket**; that needs section 4.2, logout, or TTL
expiry. Use both:

1. **Revoke the Access session** (per Cloudflare's session-management
   documentation, checked 2026-09-13): Zero Trust > Team & Resources > Users,
   select the checkbox next to the user, **Revoke sessions**. Access clears the
   authorization cookie and stops accepting that user's tokens within 20-30
   seconds, across every application. To end every user's session for this
   application instead: Zero Trust > Access controls > Applications > Teacher
   Playground > Configure > **Revoke existing tokens**.
2. **Disable the application account** with the operator route in section 4.2,
   which revokes local sessions and closes sockets within the revocation bound.

A revoked Access user can sign in again while the policy still admits them
(the production policy admits any authenticated identity); step 2 is what keeps
them out of the product.

### 4.5 Session-level detail

- Sessions are random 256-bit tokens stored only as SHA-256 hashes
  ([`src/lib/identity/sessionStore.ts:34-35`](src/lib/identity/sessionStore.ts),
  `:109-127`); the cookie is `__Host-teacher-session` (line 22).
- TTLs: 30 min idle / 12 h absolute (lines 25-26); guest sessions 4 h
  (lines 30-32). TTL expiry ends an open socket at the next alarm tick.
- `POST /auth/session/logout` ends one session. `/sessions/rotate` exists in
  `IdentityDO` but no public route reaches it, so sessions never rotate in
  production (SEC-A13, `SECURITY_AUDIT_2026-09-10.md:450-460`). Treat logout,
  revoke-all, disable, and TTL as the only session-ending controls.

## 5. Backup and restore

Do not duplicate the procedure: follow
[`SECURITY_BACKUP_RESTORE.md`](SECURITY_BACKUP_RESTORE.md). The operator-facing
facts:

- Both `RoomDO` and `IdentityDO` are SQLite-backed and covered by Cloudflare's
  30-day point-in-time recovery (PITR) window; there is no application-managed
  snapshot or export job (`SECURITY_BACKUP_RESTORE.md:28-56`).
- RPO is the 30-day window; RTO is operator-dependent and not automated
  (`SECURITY_BACKUP_RESTORE.md:48-56`).
- Restore is per Durable Object only; cross-object consistency between room
  membership and account rows is not transactional
  (`SECURITY_BACKUP_RESTORE.md:126-136`).
- A staging drill is expected at least once per environment or after material
  platform changes (`SECURITY_BACKUP_RESTORE.md:107-124`). Owner: **TBD -
  unassigned**. No drill is recorded in this repository.
- **Erasures survive a restore only through the erasure ledger.** Restoring
  `IdentityDO` to a point before an account was erased brings that account back,
  and the restored database has no record that it was erased. Every successful
  erasure writes `erasure-ledger/<accountId>.json` (`{accountId, erasedAt}`) to
  the `BOARD_FILES` R2 bucket, which a Durable Object restore does not roll back
  (`src/worker.ts`, `accountErase`). Before reopening traffic after an
  `IdentityDO` restore:
  1. List the bucket prefix `erasure-ledger/` and take every entry whose
     `erasedAt` is later than the restore point.
  2. For each, `POST /api/operator/accounts/disable` with
     `{"accountId": "<id>", "reason": "re-applying erasure after restore"}`.
     That puts the account beyond use at once: sessions revoked, sign-in
     refused, sockets closed within the revocation bound.
  3. Record the restore and the re-applied erasures in the incident record. A
     disabled account stays disabled: there is no path from here back to a
     usable account except an operator `enable`, which must not be run for an
     account on the ledger.

## 6. Session and key rotation

Procedures and cadences live in [`SECRETS_ROTATION.md`](SECRETS_ROTATION.md).
The operational summary:

- **Sessions** have no shared server key to rotate; they are per-login random
  tokens under the TTLs above. "Rotation frequency" is therefore on demand:
  logout, revoke-all, or account disable.
- **Access JWT material** is managed and rotated by Cloudflare; the app caches
  JWKS for 5 minutes and re-fetches on an unknown `kid` with a 30 s cooldown
  ([`src/lib/access/accessVerifier.ts:63`](src/lib/access/accessVerifier.ts),
  [`:69`](src/lib/access/accessVerifier.ts)). The application-side action is
  the AUD change procedure in `SECRETS_ROTATION.md`.
- **LiveKit, Stripe, and Cloudflare API tokens** are Worker and GitHub secrets;
  rotate them with the commands in `SECRETS_ROTATION.md` and record each
  rotation in its log template.

## 7. Billing operations

What the product does on its own, and what a person decides. Stripe is the source
of truth for payment state; this application never edits entitlement rows by
hand, only through the entitlement writer, which audits every change.

| Situation | What happens automatically | What the billing on-call does |
| --- | --- | --- |
| Renewal payment fails | `invoice.payment_failed` opens a **7-day grace** window with full access; Stripe's own retries and dunning emails run; access stops at `grace_until` with no job needed (`billing.workers.test.ts › opens the 7-day grace window`) | Nothing unless the tutor asks; point them to the Customer Portal to update the card |
| Payment recovers | `invoice.paid` clears grace | Nothing |
| Subscription cancelled | Entitlement ends at the effective boundary; rooms over the Free limit are archived, never deleted | Nothing |
| Refund issued | Referral credit for that invoice is reversed; entitlement is unchanged, because a refund is not a cancellation | Cancel in the Stripe dashboard as well if access should end |
| Chargeback / dispute opened | A dispute hold suspends collection and entitlement; lost disputes cancel | Respond to the dispute in Stripe; release or confirm a hold under review with `POST /api/company/operator/disputes/review` |
| Payment and access disagree | The daily reconcile re-reads every stored subscription from Stripe, applies drift once per run, and logs `collection_drift` / `reconcile_*` alerts (section 3) | Fix the state **in Stripe**, then let the next reconcile (or the next webhook) apply it; never edit SQLite |
| Stuck in-flight collection marker | The reconcile times markers out after 15 minutes and claims a fresh repair generation | Nothing unless `collection_failed` repeats for the same subscription |
| Invoice-billed company (10+ seats) | Nothing until approved | Approve with `POST /api/company/operator/invoice-approval` |

**Webhook endpoint.** Register Stripe's endpoint as
`https://playground.sen-tutor.co.uk/api/billing/webhook`, the marketing hostname.
The teacher hostname sits entirely behind Cloudflare Access, which answers
Stripe with a login redirect (`SECURITY_ROUTE_REVIEW.md`). Enable Stripe's
webhook failure notifications for that endpoint.

**Invoice retention versus erasure.** Statutory retention wins for billing
identifiers only; see `SECURITY_DATA_PROTECTION.md` "Billing records and
erasure".

**Secrets.** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are Worker secrets,
never in `wrangler.toml` or the repository; rotate with `SECRETS_ROTATION.md` §3.

## 8. Owner actions (outside the code)

Everything the code can enforce is in `security.md`. These remain because they
need a person with authority, an outside party, or an account this repository
cannot reach. They are the only open security items.

| # | Action | Why it cannot be done in code | How |
| --- | --- | --- | --- |
| 1 | Assign the roles in section 1 and confirm the deadlines | Names and commitments belong to the business | Fill in the table |
| 2 | Protect the `prod` and `staging` GitHub environments: required reviewer, deployment branches limited to `main` (and `infra/*` for Terraform plans) | Repository security settings are changed by the owner, not by a workflow | `gh api -X PUT repos/EduardoSolanas/teacher-playground/environments/prod --input env-prod.json` with `reviewers` and `deployment_branch_policy`; the same for `staging` (SEC-A17, SEC-A28) |
| 3 | Create and test the alert rules in section 3.3 | Cloudflare notifications and Stripe Workbench settings live in those dashboards | Create each rule, then fire a synthetic event to prove it |
| 4 | Commission an independent penetration test before public launch, and an independent human sign-off of `SECURITY_ROUTE_REVIEW.md` | Independence is the point of both | Scope: authentication bypass, IDOR, privilege escalation, CSRF, WebSocket abuse, resource exhaustion, revocation, retention, alternate origins |
| 5 | Run and record the PITR restore drill, including the erasure-ledger step in section 5 | Needs the Cloudflare account and a staging copy | `SECURITY_BACKUP_RESTORE.md` "Verification" |
| 6 | Close the 2026-08-17 repository incident | The remaining steps are decisions and requests only the data owner can make | Ask GitHub Support to purge cached views of the rewritten commits; decide whether the purged local `.data/` rows were real personal data and whether notification applies; identify old clones and forks. Production never used that data: it runs on Durable Object storage first deployed 2026-09-02 (`SECURITY_INCIDENT_2026-08-17.md`) |
| 7 | Accept the Cloudflare Access plan fit | A commercial decision | `CLOUDFLARE_ACCESS_PRODUCT_FIT.md`; the code caps tutor accounts at the free plan's 50 seats, and students use the guest hostname, which consumes no seats |
| 8 | Before charging anyone: set the Stripe price variables and secrets, register the webhook endpoint above, and run the billing staging evidence run once a staging environment exists | Needs the Stripe account | `scripts/run-billing-staging.mjs`, which now refuses anything but a test key bound for `api.stripe.com` |
| 9 | Release sign-off | The release owner signs | After items 1-5 |

## 9. Incident record template

Copy this into a new `SECURITY_INCIDENT_<date>.md` (aggregate evidence only):

```markdown
# <one-line description> - <YYYY-MM-DD>

## Status
Severity: Sev1|Sev2|Sev3
Incident commander: <TBD>
Detected at / contained at / closed at: <timestamps, UTC>

## Boundary and scope
<Access/JWT | app session | room grant | billing | storage>; affected accounts
or rooms described in aggregate only; what is proven vs suspected.

## Detection
<which alert or log line, and the dashboard/log link or query>

## Containment
<revocation actions and secret rotations performed, with links to entries in
SECRETS_ROTATION.md>

## Recovery and verification
<checks run; results>

## Notification decision
<by whom; decision; date>

## Open items
<each with an owner and a due date>
```

## 10. Reference verification (2026-09-12)

Every path cited in this document was checked with `Test-Path` against the
working tree on 2026-09-12 and exists. Commands cited (`npm run security:scan`,
`npm run access:check`, `npm run r2:check`, `npm run infra:check`,
`npx wrangler tail ...`, `npx wrangler secret put ...`) exist in
[`package.json:13-33`](package.json), [`DEPLOY.md:155-161`](DEPLOY.md), and
[`src/do/RoomDO.ts:194`](src/do/RoomDO.ts).

Cited but **not present** in this repository, and therefore recorded as
operational gaps rather than procedures: a route or script that invokes
`/accounts/disable` / `/accounts/revoke-all` (section 4.2), a declared Cron
Trigger for the daily reconcile in the current working tree (present at `HEAD`,
removed by the in-flight `[env.prod]` refactor - section 3.2), Cloudflare alert
rules or dashboards (section 3.3), Stripe webhook failure notifications
(section 3.3), a pager/rota (section 1), and a recorded PITR drill
(section 5). Dashboard navigation labels in sections 3.3 and 4.4 are outside
this repository and are marked unverified.
