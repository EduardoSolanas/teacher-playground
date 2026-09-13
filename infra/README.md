# Infrastructure

Everything this deployment needs from Cloudflare, as code.

```
infra/
  environments.json                 single source of truth, one entry per environment
  cloudflare/                       the Terraform root module
    environments/<env>.tfvars       which environment, and what already exists
    environments/<env>.backend.hcl  where that environment's state lives
```

## The manifest is the source of truth

`environments.json` holds every per-environment value: hostnames, account, zone,
bucket name, Access issuer and audience, caps, rate limits, asset origin.

Three consumers hold a **copy** of parts of it, because none of them can read a
JSON file at the moment they need it — Wrangler reads TOML at deploy time,
Terraform reads variables at plan time, and an S3 backend block cannot
interpolate at all:

| Copy | Kept honest by |
|---|---|
| `wrangler.toml` (`[env.<name>]`: vars, routes, bucket, account) | `src/infra/environments.test.ts` |
| `infra/cloudflare/environments/<env>.tfvars` | `src/infra/environments.test.ts` |
| `infra/cloudflare/environments/<env>.backend.hcl` | `src/infra/environments.test.ts` |

That test is the reason the copies are safe. Edit the manifest; let the test tell
you what must follow. A hostname that disagrees with the Access application's
domain does not fail a build — it fails every teacher's login, in production,
after a green deploy.

One value flows the other way: **the Access application AUD**. Cloudflare
generates it, so the manifest cannot be its source. After an apply that creates
or replaces the application, read `terraform output access_application_aud` and
write it into `access.audience`. `npm run access:check` compares the two against
the live application on every infrastructure run.

## What Terraform owns

| Resource | File |
|---|---|
| R2 bucket for board files (private, WEUR) | `r2.tf` |
| Access application for the teacher hostname + its allow policy | `access.tf` |
| Rate-limit rule on `POST /auth/guest`, guest hostname only | `ratelimit.tf` |
| Zero Trust login page branding (opt-in) | `branding.tf` |

## What Terraform deliberately does not own

- **The Worker, its Durable Objects, its routes and custom domains.** Wrangler
  owns those, and the deploy workflow is what publishes them. Splitting a Worker
  between two tools means a `terraform apply` can revert a deploy.
- **Absences.** No Access application on the guest hostname, no Bypass policy
  anywhere, no public domain on the R2 bucket. Terraform sees only the resources
  it manages, so something another tool created is invisible to it. Those are
  read from the live account by `npm run infra:check`, which the infrastructure
  workflow runs.
- **The Excalidraw asset CDN.** The fork repository is its sole owner. This
  repository only consumes the pinned immutable base URL.
- **Secrets.** `LIVEKIT_*` and `STRIPE_*` are Worker secrets, synced by
  `.github/workflows/configure-livekit.yml` and `wrangler secret bulk`. They are
  never Terraform inputs, never in the manifest, and never in a tfvars file.
- **The DNS zone itself, and Access identity providers.** Zone ownership and the
  Google/Facebook OAuth applications are account-level prerequisites; see
  `CLOUDFLARE_ACCESS_STAGING.md`.

## Credentials

Everything comes from the environment. Nothing is written to a file this
repository tracks.

```bash
export CLOUDFLARE_API_TOKEN=...      # Access: Apps+Orgs edit, R2 Storage edit, Zone Rulesets edit
export AWS_ACCESS_KEY_ID=...         # R2 API token id, for state only
export AWS_SECRET_ACCESS_KEY=...     # R2 API token secret, for state only
```

The `AWS_*` names are what the S3 backend reads; the values are R2 API token
credentials, not AWS ones.

## One-time bootstrap: the state bucket

State cannot hold its own bucket, so this one step is manual. Create a private
R2 bucket named in `<env>.backend.hcl` (`teacher-playground-tfstate` for
production), then create an R2 API token scoped to it.

It must **never** be given an r2.dev managed domain or a custom domain: state
contains resource ids and configuration for the whole account.

## Adopting production

Production predates this stack, so its first run is an **adoption**, not a
creation. Applying with the `adopt_*` variables unset would try to create a
second Access application covering the teacher hostname — which
`npm run access:check` reports as a failure — and would fail outright on the
taken bucket name.

Read the ids, with `CLOUDFLARE_API_TOKEN` exported:

```bash
npm run access:check
```

That prints every Access application on the account with its domain and AUD. For
the application ids and its policy id:

```bash
ACCOUNT=$(node -e 'import("./scripts/lib/environments.mjs").then(m=>process.stdout.write(m.readEnvironment(m.resolveEnvironmentName()).accountId))')
curl -s -H "authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/access/apps" \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{for(const a of JSON.parse(b).result)console.log(a.id,a.domain)})'
```

and for the zone's rate-limit ruleset, if one already exists:

```bash
curl -s -H "authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/<zone id>/rulesets" \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{for(const r of JSON.parse(b).result)if(r.phase==="http_ratelimit")console.log(r.id,r.name)})'
```

Write each into `environments/prod.tfvars`, then plan. The ids are safe to leave
set afterwards — an import block whose resource is already in state is a no-op.

## Running it

```bash
cd infra/cloudflare
terraform init -backend-config=environments/prod.backend.hcl
terraform plan -var-file=environments/prod.tfvars
```

`.github/workflows/infra.yml` plans automatically on any change under `infra/`,
and applies only from a named `workflow_dispatch` with `apply: true`, against the
GitHub environment whose reviewers govern the Cloudflare account. Applies are
serialised by a `concurrency` group, which is what stands in for state locking —
R2 offers none.

**Read the plan before applying.** Two diffs deserve particular care:

- **The Access policy's `include` rule.** `scripts/cloudflare-access.mjs` created
  production's policy with a `login_method` rule; this stack declares `everyone`.
  If those differ, the plan proposes a change to an authorization rule.
- **Anything marked for replacement.** The bucket and the Access application both
  carry `prevent_destroy`, so a plan that wants to replace one fails rather than
  proceeding — that is the guard working, not a bug to route around.

## Adding an environment

1. Add an entry to `environments.json`. Set `wranglerEnv` to the name of its
   wrangler block — every environment has one, and no two share it. There is no
   implicit default environment, which is the point: a forgotten `--env` fails
   rather than selecting production.
2. Add `environments/<env>.tfvars` and `environments/<env>.backend.hcl`. Leave
   every `adopt_*` unset — a new environment has nothing to adopt.
3. Add the matching `[env.<name>]` section to `wrangler.toml`, alongside
   `[env.prod]`. It **must** set `name` explicitly — Wrangler otherwise appends
   the environment to the top-level Worker name and publishes a different
   Worker, with different Durable Objects, so the rooms are simply not there.
   `main`, `account_id`, `vars`, `routes`, `r2_buckets`, `durable_objects` and
   `assets` all belong in the block; only genuinely shared settings
   (compatibility date, migrations, observability) stay at the top level.
   Then deploy it with `wrangler deploy --env <name>`.
4. Run `npm test -- src/infra`. It will tell you what is missing.
5. Bootstrap that environment's state bucket, then plan.

Steps 3 and 4 are the loop: the test enumerates the manifest, so a new entry
immediately requires the rest to exist.
