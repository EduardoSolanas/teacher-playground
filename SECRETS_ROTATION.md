# Secret and key rotation runbook

Created 2026-09-12. This is the document the Phase 7 item calls for
("secret rotation", `security.md:1552-1554`; `spec/IMPLEMENTATION_SPEC.md:892-894`,
`:1549`, `:1555`) and the "session/key rotation" half of the Phase 6 operational
gate row (`security.md:1862`).

Every command, path, and line number below was verified against this working
tree on 2026-09-12. Where the repository does **not** pin a command, the entry
says so instead of inventing one. Cadences are proposals for the owners named in
[`SECURITY_OPERATIONS.md`](SECURITY_OPERATIONS.md) to approve, except where a
value is fixed in code.

## 1. Ground rules

- No secret value is stored in this repository. `.gitignore` ignores `.env*`
  and `.dev.vars*` ([`.gitignore:19-23`](.gitignore)); the scan at
  `npm run security:scan` ([`package.json:18`](package.json),
  [`.github/workflows/ci.yml:40-41`](.github/workflows/ci.yml)) is a blocking CI
  gate.
- Three storage locations exist, and they are not interchangeable:
  - **Worker secrets**: what production reads at runtime, set with Wrangler.
  - **GitHub environment secrets**: what workflows read, scoped to the
    `prod` / `staging` environments (`deploy-cloudflare.yml:21`,
    `configure-livekit.yml:13`, `billing-staging.yml:42`).
  - **`.dev.vars`** or a shell export: local only, throwaway credentials only
    (`security.md:1826-1831`; README's copy instruction at `README.md:107`).
    `.dev.vars.example` does **not** exist; `.env.local.example` is the template.
- Never put a secret in `[vars]`, code, client bundles, or logs
  (`spec/IMPLEMENTATION_SPEC.md:892-894`).
- **Every Wrangler command must name the production environment.** The
  in-flight (uncommitted) refactor moves the deployable configuration under
  `[env.prod]` and deliberately omits a top-level entry point so that a command
  without `--env prod` fails instead of publishing the live Worker with no
  routes, vars, or bindings ([`wrangler.toml:8-20`](wrangler.toml),
  [`:58-64`](wrangler.toml)). The deploy workflow passes
  `command: deploy --env prod`
  ([`deploy-cloudflare.yml:111-115`](.github/workflows/deploy-cloudflare.yml))
  and `package.json:13` is `wrangler deploy --env prod`. The secret commands in
  sections 3-4 therefore use `--env prod`. `DEPLOY.md:155-161` still shows the
  pre-refactor form; do not copy it verbatim until it is updated.
- After every rotation, run the verification step in that secret's section and
  append a row to the log in section 8. If a rotation cannot be completed,
  revoke the old credential anyway and treat the exposure as an incident
  ([`SECURITY_OPERATIONS.md`](SECURITY_OPERATIONS.md) section 2).
- Rotate immediately, not on cadence, after: suspected disclosure, a person
  with access leaving, a workflow log leak, or an unexplained billing/auth
  anomaly.

## 2. Inventory

| Secret | Nature | Production set via | Workflow consumers | Cadence (proposed) |
| --- | --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | Stripe API credential | Worker secret | `billing-staging.yml:72,109` | 12 months / on suspicion / on staff change |
| `STRIPE_WEBHOOK_SECRET` | Stripe endpoint signing secret | Worker secret | `billing-staging.yml:110` | With the Stripe endpoint / on suspicion |
| `LIVEKIT_URL` | Non-secret endpoint | Worker secret or `[vars]` | `configure-livekit.yml:30,48` | When the project moves |
| `LIVEKIT_API_KEY` | LiveKit key id | Worker secret | `configure-livekit.yml:31,49` | With its secret |
| `LIVEKIT_API_SECRET` | LiveKit HS256 signing secret | Worker secret | `configure-livekit.yml:32,50` | 6-12 months / on suspicion |
| `CLOUDFLARE_API_TOKEN` | Cloudflare account API token | GitHub environment secret + local env | `deploy-cloudflare.yml:94,109`, `configure-livekit.yml:46,62`, `infra.yml:74,150` | 90 days / on staff change |
| `CLOUDFLARE_ACCOUNT_ID` | Not a secret (variable) | GitHub variable | `deploy-cloudflare.yml:95,110` | Not rotated |
| `TFSTATE_ACCESS_KEY_ID` / `TFSTATE_SECRET_ACCESS_KEY` | R2 API token for Terraform state | GitHub environment secret | `infra.yml:78-79` | 90-180 days / on staff change |
| `E2E_STAGING_ACCESS_TOKEN` | Staging Access credential for the naming run | GitHub `staging` secret | `billing-staging.yml:108` | Staging-only; rotate on suspicion |
| `SUPPORT_EMAIL` | Public support address (build-time) | GitHub environment secret | `deploy-cloudflare.yml:85` | When the mailbox changes |
| App sessions | Random 256-bit tokens, hash-only storage | Server-generated | - | No scheduled rotation; revoke on demand |

## 3. Stripe

### 3.1 `STRIPE_SECRET_KEY`

Read at runtime in `readBillingEnv` ([`src/lib/billing/stripeConfig.ts:59`](src/lib/billing/stripeConfig.ts)).
A missing value reads as `null` and callers degrade rather than throw
(`stripeConfig.ts:50-65`).

The repository documents **no Stripe-specific Wrangler command** - the only
`wrangler secret put` lines in the tree are LiveKit's
([`DEPLOY.md:155-161`](DEPLOY.md)). The command form is the same:

```bash
npx wrangler secret put STRIPE_SECRET_KEY --env prod
```

Steps:

1. In the Stripe Dashboard, **Developers -> API keys**, create a replacement
   key with the minimum required scope (secret key; no publishable or
   platform key).
2. From the repository root: `npx wrangler secret put STRIPE_SECRET_KEY --env prod`
   and paste the replacement when prompted.
3. Verify the Worker can read it and that no route regressed:
   `npx wrangler secret list --config wrangler.toml --format json --env prod`
   should still list the name (pattern: `deploy-cloudflare.yml:98`), and a manual
   **Deploy to Cloudflare** run (`workflow_dispatch`,
   [`.github/workflows/deploy-cloudflare.yml`](.github/workflows/deploy-cloudflare.yml))
   should stay green.
4. If the staging environment exists, run **Billing staging evidence**
   (`.github/workflows/billing-staging.yml`) to exercise the real test-mode
   round trip. It consumes the GitHub `staging` secret at
   `billing-staging.yml:72,109`.
5. Revoke the old key in the Stripe Dashboard. Delete any local copy.
6. Log the rotation (section 8).

Mode safety (SEC-A17): the code allows a custom `STRIPE_API_BASE` only when the
key starts with `sk_test_` ([`stripeConfig.ts:45-47`](src/lib/billing/stripeConfig.ts)),
and the staging workflow refuses a non-`api.stripe.com` base for a live key
([`billing-staging.yml:68-92`](.github/workflows/billing-staging.yml)). Never
point a live key at a non-Stripe base; never put a live key in `staging`.

### 3.2 `STRIPE_WEBHOOK_SECRET`

Read at [`src/worker.ts:1910`](src/worker.ts) and used for every webhook
signature check ([`src/worker.ts:1912-1920`](src/worker.ts)).

**Verified limitation - read before rotating.** The signature verifier accepts
several configured secrets and several `v1` signatures, which is what makes a
cosigned rotation possible ([`src/lib/billing/stripeSignature.ts:5-8`](src/lib/billing/stripeSignature.ts),
`:100-112`; `security.md:2269-2273` lists it as a control). But the Worker
passes exactly **one** configured secret:

```ts
billing.webhookSecret === null ? [] : [billing.webhookSecret]
```

([`src/worker.ts:1915`](src/worker.ts); `readBillingEnv` returns a single string,
[`stripeConfig.ts:64`](src/lib/billing/stripeConfig.ts)). The deployment cannot
hold old and new at the same time. A Stripe endpoint roll only works without a
gap if Stripe cosigns events with both secrets for the roll window; the reverse
order leaves a window where the Worker rejects valid events. Until the Worker
parses a secret set (a small, testable change), rotate in the order below and
accept the small gap, or treat the wiring change as a prerequisite.

Steps:

1. Stripe Dashboard -> **Developers -> Webhooks** -> select the production
   endpoint -> roll/reveal the signing secret (label may differ in the current
   Workbench; the value starts `whsec_`).
2. Immediately `npx wrangler secret put STRIPE_WEBHOOK_SECRET --env prod` with
   the new value.
3. Send a Stripe test event for the endpoint (or use the local flow:
   `stripe listen --forward-to http://localhost:8787/api/billing/webhook` per
   `spec/findings/04-stripe-subscriptions-referrals.md:449-457`, which prints a
   development `whsec_` for `.dev.vars`).
4. Confirm the endpoint returns 2xx and no `reconcile_*` or `unmapped_dispute`
   alert follows; the daily reconcile is the backstop that detects a missed
   window. **Cron trigger gap, verified in the working tree:** the in-flight
   move of production under `[env.prod]` removes `[triggers]` /
   `crons = ["17 3 * * *"]` from `wrangler.toml` (present at `HEAD`), so the
   backstop does not run until the trigger is restored. The scheduled handler
   itself remains at [`src/worker.ts:3270-3276`](src/worker.ts).
5. For the staging workflow, update the GitHub `staging` secret consumed at
   [`billing-staging.yml:110`](.github/workflows/billing-staging.yml).
6. Log the rotation (section 8).

## 4. LiveKit

Names read by `parseLiveKitConfig` ([`src/lib/av/livekitToken.ts:175-182`](src/lib/av/livekitToken.ts));
missing configuration returns 503, not a permissions failure
([`src/lib/av/handleAvToken.ts:55-66`](src/lib/av/handleAvToken.ts)).

**Automated path (preferred).** The **Configure LiveKit secrets** workflow
([`.github/workflows/configure-livekit.yml`](.github/workflows/configure-livekit.yml),
`environment: prod` at line 13) validates all three values (lines 28-42), syncs
them in one request with
`npx wrangler secret bulk --config wrangler.toml --env prod` (line 53), and
verifies the names with
`npx wrangler secret list --config wrangler.toml --format json --env prod`
(line 66). Rotate by updating the GitHub `prod` environment secrets
`LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`, then dispatching that workflow.

**Manual path.** The commands in the repository are at
[`DEPLOY.md:155-161`](DEPLOY.md), but that block predates the `[env.prod]`
refactor and does not pass `--env prod`. Use the environment-qualified form:

```bash
npx wrangler secret put LIVEKIT_URL --env prod
npx wrangler secret put LIVEKIT_API_KEY --env prod
npx wrangler secret put LIVEKIT_API_SECRET --env prod
```

The deploy workflow refuses to deploy if any of the three names is missing from
the Worker ([`deploy-cloudflare.yml:92-104`](.github/workflows/deploy-cloudflare.yml)).

Steps:

1. In the LiveKit Cloud project dashboard, **Settings -> Keys**, create a
   replacement key pair with the same grants (or run the equivalent command on
   a self-hosted LiveKit server).
2. Update the GitHub `prod` environment secrets (or run the manual commands).
3. Dispatch **Configure LiveKit secrets** and confirm the verify step passes.
4. Wait out the token lifetime before deleting the old key: room tokens are
   HS256 JWTs valid for **1 hour** ([`src/lib/av/livekitToken.ts:17`](src/lib/av/livekitToken.ts)).
   Deleting the old key sooner tears down any call still holding a token signed
   with it.
5. Delete the old key in LiveKit, smoke-test A/V in a room, and log the
   rotation (section 8).

Local values live in `.dev.vars` and are throwaway
(`README.md:103-109`; `security.md:1826-1831`). Never copy production LiveKit
credentials into `.dev.vars` or `wrangler.local.toml`.

## 5. Cloudflare account credentials

### 5.1 `CLOUDFLARE_API_TOKEN`

Consumed at:

- Deploy: `wrangler-action` at
  [`deploy-cloudflare.yml:107-110`](.github/workflows/deploy-cloudflare.yml)
  and the name check at `:94`.
- LiveKit sync: [`configure-livekit.yml:46,62`](.github/workflows/configure-livekit.yml).
- Terraform and live invariants:
  [`infra.yml:74,150`](.github/workflows/infra.yml).
- Local scripts: `scripts/cloudflare-access.mjs` requires **Access: Apps + Orgs
  edit** ([`scripts/cloudflare-access.mjs:39-40`](scripts/cloudflare-access.mjs));
  `scripts/cloudflare-r2.mjs` requires **Workers R2 Storage: Edit**
  ([`scripts/cloudflare-r2.mjs:54`](scripts/cloudflare-r2.mjs)). The Terraform
  README also names **Zone Rulesets edit**
  ([`infra/README.md:74`](infra/README.md)).

Steps:

1. Cloudflare Dashboard -> **My Profile -> API Tokens** (account-owned tokens
   use the same page) -> create a replacement token with the scopes above plus
   whatever `wrangler deploy` needs (Workers Scripts edit). The exact
   Workers-deploy scope is not itemized in the repository; copy the scope of
   the token being replaced rather than guessing.
2. Update the GitHub environment secret `CLOUDFLARE_API_TOKEN` for `prod`
   (repo **Settings -> Environments -> prod -> Secrets**), and for `staging`
   when that environment is provisioned. Update any local `.dev.vars` copy.
3. Verify: dispatch **Infrastructure** with `apply: false` (it runs
   `npm run access:check` and `npm run r2:check`,
   [`infra.yml:174-178`](.github/workflows/infra.yml)), dispatch **Deploy to
   Cloudflare**, and run `npm run infra:check` locally
   ([`package.json:24`](package.json)).
4. Revoke the old token in the dashboard, then log the rotation (section 8).

The repository sees one secret name but cannot tell whether one token or
several credentials back it; record the credential id that was replaced.

### 5.2 Terraform state credentials

`TFSTATE_ACCESS_KEY_ID` / `TFSTATE_SECRET_ACCESS_KEY` are **R2 API token**
credentials for the private state bucket, not AWS keys
([`infra.yml:78-79`](.github/workflows/infra.yml);
[`infra/README.md:75-80,84-86`](infra/README.md)). Rotate them as an R2 token
scoped to the state bucket only:

1. Create a replacement R2 API token scoped to the state bucket; the bucket
   must never have an r2.dev managed domain or a custom domain
   (`infra/README.md:86-89`).
2. Update the GitHub environment secrets, then run **Infrastructure** with
   `apply: false` and confirm `terraform init -backend-config=...` succeeds
   ([`infra.yml:110-111`](.github/workflows/infra.yml)).
3. Revoke the old R2 token and log the rotation.

### 5.3 `SUPPORT_EMAIL` and `CLOUDFLARE_ACCOUNT_ID`

`SUPPORT_EMAIL` is a build-time public address passed into the static export
([`deploy-cloudflare.yml:85`](.github/workflows/deploy-cloudflare.yml)); rotate
it when the mailbox changes. `CLOUDFLARE_ACCOUNT_ID` is a GitHub **variable**,
not a secret ([`deploy-cloudflare.yml:95,110`](.github/workflows/deploy-cloudflare.yml)),
and is not rotated.

## 6. Access / JWT material

### 6.1 Signing keys (routine rotation)

Cloudflare generates and rotates the team's Access signing keys; the
application follows without operator action. The verifier caches JWKS for 5
minutes and re-fetches on an unknown `kid` with a 30 s cooldown
([`src/lib/access/accessVerifier.ts:63`](src/lib/access/accessVerifier.ts),
[`:69`](src/lib/access/accessVerifier.ts)). **No repository command exists for
this rotation, and none is needed.** Do not "fix" a login blip by pinning or
flushing the cache.

### 6.2 Audience (AUD) change - only when the Access application is replaced

The AUD is generated by Cloudflare and copied into the manifest by hand; the
Terraform stack's `prevent_destroy` guards the application against accidental
replacement ([`infra/cloudflare/access.tf:65-70`](infra/cloudflare/access.tf);
[`infra/cloudflare/outputs.tf:6-19`](infra/cloudflare/outputs.tf);
[`infra/README.md:34-38`](infra/README.md)).

If the application is deliberately replaced:

1. Apply the Terraform stack for the environment.
2. Read `terraform output access_application_aud` (output definition:
   `outputs.tf:6-19`).
3. Write it into `access.audience` in
   [`infra/environments.json:74`](infra/environments.json).
4. Let `src/infra/environments.test.ts:232` fail until
   [`wrangler.toml:130`](wrangler.toml) (`ACCESS_AUDIENCE`) matches, then
   redeploy (**Deploy to Cloudflare**).
5. Run `npm run access:check` ([`package.json:21`](package.json)); it compares
   the configured audience against the live application and fails on a mismatch
   ([`scripts/cloudflare-access.mjs:197-208`](scripts/cloudflare-access.mjs)).
6. Expect every already-issued Access JWT to be rejected at the switch, so
   schedule the change. Log it (section 8).

### 6.3 Issuer / JWKS URL and staging token

The team domain flows to `ACCESS_ISSUER` / `ACCESS_JWKS_URL`
([`wrangler.toml:129,131`](wrangler.toml);
[`infra/environments.json:73,75`](infra/environments.json)) and only changes if
the Zero Trust team itself changes; follow 6.2's redeploy and `access:check`
steps.

`E2E_STAGING_ACCESS_TOKEN` is the staging credential the blocked billing
staging runner requires ([`billing-staging.yml:108`](.github/workflows/billing-staging.yml);
[`scripts/run-billing-staging.mjs:42-49,85-89`](scripts/run-billing-staging.mjs)).
It is used only by that named run; rotate it by replacing the GitHub `staging`
environment secret. The repository does not create or manage the staging
Access issuer - staging does not exist yet
(`CLOUDFLARE_ACCESS_STAGING.md:114-126`).

The local Access issuer generates a fresh RSA keypair per process
(`security.md:1815`; `scripts/local-access-issuer.mjs`); there is nothing to
rotate.

## 7. Session material

There is no shared session signing key. Sessions are 32 random bytes
(`__Host-teacher-session`, 43-character base64url) stored only as SHA-256
hashes ([`src/lib/identity/sessionStore.ts:22-35`](src/lib/identity/sessionStore.ts),
`:109-127`). TTLs are 30 minutes idle / 12 hours absolute; guest sessions 4
hours (lines 25-32). Rotation of an individual session exists as
`rotateSession` ([`sessionStore.ts:448`](src/lib/identity/sessionStore.ts)) but
no public route reaches `/sessions/rotate`, so it never runs in production
(SEC-A13, `SECURITY_AUDIT_2026-09-10.md:450-460`).

Therefore the operational answer to "session rotation frequency" is: **no
scheduled rotation**. Sessions end by logout, revoke-all, account disable, or
TTL, and compromised accounts are handled with the account-wide operations in
[`SECURITY_OPERATIONS.md`](SECURITY_OPERATIONS.md) section 4.

## 8. Rotation log template

Append one row per rotation to a team-owned file (not this repository, unless
the values are non-sensitive metadata):

```markdown
| Date (UTC) | Secret | Reason | New credential id / version | Actor | Verification (command + result) | Old credential revoked at | Incident ref |
| --- | --- | --- | --- | --- | --- | --- | --- |
| YYYY-MM-DD | STRIPE_SECRET_KEY | scheduled | key id suffix ... | <TBD> | staging run #... green | YYYY-MM-DD HH:MM | - |
```

Rules for the log: record names and dates only - never a secret value, a
`whsec_`, a token, or a full key id; "old credential revoked at" must be
non-empty, or the rotation is not finished; a failed verification means the
incident process starts, not a second log row.

## 9. Reference verification (2026-09-12)

Checked with `Test-Path` against the working tree; all of the following exist:
`.gitignore`, `DEPLOY.md`, `README.md`, `security.md`, `wrangler.toml`,
`package.json`, `infra/environments.json`, `infra/README.md`,
`infra/cloudflare/access.tf`, `infra/cloudflare/outputs.tf`,
`src/infra/environments.test.ts`, `src/worker.ts`,
`src/lib/billing/stripeConfig.ts`, `src/lib/billing/stripeSignature.ts`,
`src/lib/identity/sessionStore.ts`, `src/lib/access/accessVerifier.ts`,
`src/lib/av/livekitToken.ts`, `src/lib/av/handleAvToken.ts`,
`scripts/cloudflare-access.mjs`, `scripts/cloudflare-r2.mjs`,
`scripts/run-billing-staging.mjs`, `scripts/local-access-issuer.mjs`,
`.github/workflows/deploy-cloudflare.yml`,
`.github/workflows/configure-livekit.yml`,
`.github/workflows/billing-staging.yml`, `.github/workflows/infra.yml`,
`spec/IMPLEMENTATION_SPEC.md`, `spec/findings/04-stripe-subscriptions-referrals.md`,
`SECURITY_AUDIT_2026-09-10.md`, `SECURITY_OPERATIONS.md`.

Commands cited above and present in the repository: `npx wrangler secret put`
([`DEPLOY.md:158-160`](DEPLOY.md), pre-refactor form; add `--env prod`),
`npx wrangler secret bulk --config wrangler.toml --env prod`
([`configure-livekit.yml:53`](.github/workflows/configure-livekit.yml)),
`npx wrangler secret list --config wrangler.toml --format json --env prod`
([`configure-livekit.yml:66`](.github/workflows/configure-livekit.yml),
[`deploy-cloudflare.yml:98`](.github/workflows/deploy-cloudflare.yml)),
`npm run security:scan`, `npm run access:check`, `npm run r2:check`,
`npm run infra:check` ([`package.json:18-24`](package.json)), and
`terraform init`/`terraform output` as used by
[`infra.yml:110-111,133-135`](.github/workflows/infra.yml).

**Not present in this repository**, and therefore not asserted as procedure:

- A Stripe-specific `wrangler secret put STRIPE_*` command or workflow; the
  command form is inferred from the LiveKit pattern, and that is stated in
  section 3.
- Multi-secret parsing for `STRIPE_WEBHOOK_SECRET` (section 3.2) - the verifier
  supports it, the Worker wiring does not.
- A command or workflow for rotating Access signing keys or the AUD; section 6
  records the manual Terraform/dashboard flow.
- `.dev.vars.example` (`.gitignore:23` allows it, but the file does not exist;
  `.env.local.example` is the template, `README.md:107`).
- A provisioned staging environment or its Access token source
  (`CLOUDFLARE_ACCESS_STAGING.md:114-126`; `scripts/run-billing-staging.mjs:11-31`).
