# Deployment

The app deploys to Cloudflare Workers as a single Worker that serves both the
static frontend and the room API, with one Durable Object per whiteboard room.

## Architecture

```
Browser (teacher hostname)
  |  Cloudflare Access assertion + local app session
  |-- GET /whiteboard/<roomId>        -> static asset (placeholder page)
  |-- /api/whiteboard/room/<roomId>/* -> RoomDO for that room
  |-- POST /api/av/token?roomId=…     -> RoomDO /room/av (LiveKit JWT)
  |-- WS  /signaling?room=<roomId>    -> RoomDO for that room
```

A Durable Object is created per room id (`ROOMS.idFromName(roomId)`), and it
owns two things at once:

- **Room state**, in SQLite-backed Durable Object storage. `DODatabase`
  (`src/lib/whiteboard/doDatabase.ts`) adapts `ctx.storage.sql` to the
  `RoomDatabase` interface, so the same handler code runs on Durable Object
  SQLite in production and on `better-sqlite3` under test.
- **Signaling sockets**, replacing the previous in-process signaling topic map.
  Because the object *is* the room, every socket it holds is on the same topic,
  so a `publish` fans out to the other sockets on that
  object. Keepalives are answered by `setWebSocketAutoResponse`, so idle rooms
  stay hibernated.

This is why the room API must not be scaled horizontally: signaling peers have
to meet on one instance. The Durable Object guarantees that per room.

### Guest hostname

Guest join uses a **second hostname** on the same Worker. The teacher hostname
keeps the existing Access application (exact hostname only — no wildcard). The
guest hostname gets DNS and a Worker route but **no Access application**; adding
one breaks guest join. `wrangler.toml` sets `TEACHER_HOSTNAME` and
`GUEST_HOSTNAME` from `infra/environments.json`; if either is unset, every
request is treated as teacher-host. `workers_dev` and `preview_urls` are already
`false`, so the Worker has no Cloudflare-generated alternate origin. The zone's
single free rate-limit rule is spent on `POST /auth/guest` on the guest hostname
by `infra/cloudflare/ratelimit.tf`; it is the outer bound that sheds volumetric
abuse before a Worker invocation, and stays deliberately looser than the
in-Worker `GUEST_AUTH_RATE_MAX` so a legitimate client always meets the Worker's
considered 429 rather than an opaque edge block. See `CLOUDFLARE_ACCESS_STAGING.md` and `guest_implementation.md` §6.5;
the Access application and DNS state live in the Cloudflare account and are not
verified in this repository.

### Live-socket revocation

A signaling socket is authorized once, at upgrade time, so the room re-checks it
afterwards. Each socket carries the verified account id and authorization epoch,
written by the Worker on the internal request, and a Durable Object alarm
re-reads account state from `IdentityDO` every 30 seconds
(`REVOCATION_CHECK_INTERVAL_MS`). Sockets belonging to a disabled account or a
superseded epoch are closed with code `4401`.

That interval is the documented revocation bound for live collaborators; new
requests are refused immediately. If `IdentityDO` is unreachable the check is
retried and sockets stay open, so the bound assumes a reachable identity object.
See `SECURITY_IDENTITY_MODEL.md`.

### Static export and room URLs

Room ids are created at runtime, so `output: 'export'` cannot enumerate them.
The build emits one placeholder page at `/whiteboard/_room`, and the Worker
serves it for every `/whiteboard/<roomId>` URL. `RoomClient.tsx` reads the real
id from `window.location.pathname`, so the address bar is never rewritten and
room links stay shareable.

## Infrastructure as code

Everything this deployment needs from the Cloudflare account is declared in
`infra/`, and every per-environment value comes from one file,
`infra/environments.json`:

- **Terraform** (`infra/cloudflare`) owns the R2 bucket, the Access application
  and its policy, the zone's rate-limit rule, and the login branding.
  `.github/workflows/infra.yml` plans on every change and applies only from a
  named manual run.
- **Wrangler** owns the Worker, its Durable Objects, and its three custom
  domains. It is not split between the two tools, so a `terraform apply` can
  never revert a deploy.
- **`npm run infra:check`** reads the live account for what Terraform
  structurally cannot prove: that no Access application covers the guest
  hostname, that no Bypass policy exists, and that the R2 bucket has no public
  domain. Terraform sees only the resources it manages, so an absence is
  invisible to it.

`wrangler.toml` holds a copy of the manifest's values, because Wrangler reads
TOML at deploy time. Each environment is an `[env.<name>]` block there —
production is `[env.prod]`, deployed with `wrangler deploy --env prod`. Nothing
environment-specific sits at the top level, so a second environment cannot
inherit production's hostnames or bucket by accident.
`src/infra/environments.test.ts` fails when the two disagree. Edit the manifest;
let the test tell you what must follow.

See `infra/README.md` for the runbook, including how production — which predates
the stack — is adopted rather than recreated.

## Prerequisites

- A Cloudflare account. SQLite-backed Durable Objects are available on the
  Workers Free plan; key-value backed Durable Objects are not, which is why
  `wrangler.toml` uses `new_sqlite_classes`.
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub secrets for CI.
- `TFSTATE_ACCESS_KEY_ID` and `TFSTATE_SECRET_ACCESS_KEY` (R2 API token
  credentials) for Terraform state, and a private R2 state bucket bootstrapped
  once by hand.

## Production hostname closure (externally blocked)

`wrangler.toml` disables both `workers.dev` and version preview URLs and
declares three custom domains: `app-playground.sen-tutor.co.uk` (teacher,
behind the exact-hostname Access application), `join-playground.sen-tutor.co.uk`
(guest join), and `playground.sen-tutor.co.uk` (public landing page). What the
repository does not contain is proof that the deployment account controls the
`sen-tutor.co.uk` zone, or a sanitized inventory and probe record showing the
declared hostnames behave as documented.

Before production custom-hostname closure is complete, an authorized owner must
complete this runbook in the Cloudflare account:

1. Inventory every currently deployed hostname and route for this Worker,
   including existing `workers.dev` URLs, version preview URLs, custom domains,
   and zone routes, and compare it with the three domains declared in
   `wrangler.toml`.
2. Provide evidence that the deployment account controls the `sen-tutor.co.uk`
   zone for those three declared custom domains.
3. Confirm the reviewed Wrangler custom-domain configuration matches the
   approved hostnames, then deploy through the supported GitHub workflow.
4. Disable or remove every other Worker route, custom domain, `workers.dev`
   hostname, and preview hostname found by the inventory.
5. Verify that each approved hostname reaches the Worker with the intended
   Access boundary and that every inventoried alternate or direct backend
   hostname fails closed.

Keep the following evidence with the deployment record: the approved hostnames
and routes, the controlled zone and account (identifiers may be redacted), a
Cloudflare Dashboard or API inventory before and after the change, the reviewed
Wrangler diff and deployment identifier, and HTTP/WebSocket probes showing each
approved hostname succeeds while each alternate hostname is unreachable. Until
that evidence exists, production custom-hostname closure remains incomplete.

### LiveKit voice secrets (optional)

When enabling voice calling, add `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and
`LIVEKIT_API_SECRET` as GitHub `prod` environment secrets, then manually run
the **Configure LiveKit secrets** workflow. It validates all three values before
changing Cloudflare, syncs them to the Worker in one request, and verifies only
their names. Never commit or paste their values into a workflow log. See README
“Voice calling” for local smoke steps.

For an operator working directly with Wrangler, the equivalent commands are:

```bash
npx wrangler secret put LIVEKIT_URL
npx wrangler secret put LIVEKIT_API_KEY
npx wrangler secret put LIVEKIT_API_SECRET
```

## Deploying

```bash
npm run deploy
```

That runs `next build` (static export into `out/`) and then
`wrangler deploy --env prod`, which uploads the Worker together with the
contents of `out/`.

`--env` is required, not stylistic. Each environment is an `[env.<name>]` block
in `wrangler.toml`; the top level holds only what every environment shares and
deliberately sets **no `main`**. Wrangler merely warns when environments exist
and `--env` is omitted, and the deploy it would then make publishes the Worker
with no routes, no vars and no bindings — over the live script, because
`[env.prod]` keeps the Worker's real name. Withholding the top-level entry point
turns that into an immediate `Missing entry-point` error instead.
`src/infra/environments.test.ts` asserts that every wrangler invocation in
`package.json` and in the workflows passes `--env`.

Pushes to `main` deploy automatically via
`.github/workflows/deploy-cloudflare.yml`, which typechecks, runs both test
suites, builds, and deploys the Worker. The workflow uses the existing
production `CLOUDFLARE_API_TOKEN` secret and `CLOUDFLARE_ACCOUNT_ID` variable;
the Excalidraw distribution is published separately by its fork repository.

### Excalidraw release CDN

The production build points Excalidraw at the immutable release base:

`https://excalidraw-assets.sen-tutor.co.uk/releases/0.18.1-tp.11/dist/prod/`

The fork repository is the sole owner of the R2 bucket, custom domain, release
objects, and release metadata. This repository only consumes the pinned
immutable base URL above; it does not provision the bucket or publish release
objects, and it never resolves floating release metadata such as `latest.json`.
The URL is pinned in `src/lib/whiteboard/excalidrawAssetPath.ts`. The CDN custom
domain is live and serves immutable release objects. The local fallback remains
`/` when running outside a production build or when
`NEXT_PUBLIC_EXCALIDRAW_ASSET_PATH=/` is supplied.

#### Historical CDN publisher evidence

Earlier parent revisions contained a duplicate Terraform stack and an
imperative publisher. Those were deliberately removed after the fork became
the sole owner. Historical deployment runs `32680222826` and `32688811548`
recorded the old publisher failing before R2 was enabled; they are retained as
history only and are not current workflow behavior. Historical release
`0.18.1-tp.6` was published by fork workflow run `32781207895` and its package
is 9,445,242 bytes. The parent production deployment at the time was green: run
`32783092806` completed clean install, security scan, typecheck, unit tests,
static export, real Worker tests, and Wrangler deployment while consuming
`0.18.1-tp.6`. The pins have since moved to `0.18.1-tp.11`.

#### The production asset host must exist before the first production deploy

`resolveExcalidrawAssetPath` returns the CDN base whenever
`NODE_ENV === 'production'`, so the hostname is a hard production dependency
rather than an enhancement. The hostname is now provisioned and reachable.

`NEXT_PUBLIC_EXCALIDRAW_ASSET_PATH` overrides the default and is the rollback
lever. Setting it to `/` restores same-origin assets from `public/`, which the
`prebuild` copy still populates, and requires no code change:

```sh
NEXT_PUBLIC_EXCALIDRAW_ASSET_PATH=/ npm run build
```

Keep that escape hatch working. It is the only way to ship the application
while the CDN is unavailable.

#### Changing the CDN hostname touches the CSP

The hostname now has one home: `excalidraw.assetBaseUrl` and
`excalidraw.assetOrigin` in `infra/environments.json`. The deploy workflow reads
the base URL into `NEXT_PUBLIC_EXCALIDRAW_ASSET_PATH` at build time, and
`EXCALIDRAW_ASSET_ORIGIN` in `wrangler.toml` carries the origin into the Worker's
CSP through `fontSrcForAssetOrigin`. `src/infra/environments.test.ts` asserts
that the origin is the origin of the base URL, and that the binding equals the
manifest.

`EXCALIDRAW_CDN_BASE_PATH` in `src/lib/whiteboard/excalidrawAssetPath.ts` remains
as the default for a build that sets no asset path, and
`src/deployment/deploymentPolicy.test.ts` keeps it on the same fork release as
the package and the manifest.

A hostname change that missed the CSP used to produce a green test suite and a
board with no fonts, because the failure appears only as a browser console
violation. That is what the single source and its test close.

No automated check covers the cross-origin load itself. Parent unit tests assert
the CSP header string, and fork tests cover uploader MIME and cache contracts,
but no live public-origin verification exists yet. Reachability is not
acceptance: a served font and a font the page's CSP permits are different
claims, and only the second one puts glyphs on a board.
Before trusting a CDN deploy, open a room against the deployed hostname and
confirm the console
reports no CSP violation for either `font-src` or `connect-src`. `font-src`
carries the CDN origin; `connect-src` does not, so any asset Excalidraw
retrieves with `fetch` rather than the font loader would still be refused.
That distinction is unverified and a browser is the only thing that settles it.

## Running locally

```bash
npm run dev:worker
```

Builds the static export and serves it through `wrangler dev`, which runs the
real `workerd` runtime with real Durable Objects. This is the only local mode
that exercises the production code path.

`npm run dev` invokes `npm run dev:worker`, so it uses the same real Worker and
Durable Object path as production. The legacy Node `signaling-server.mjs` was removed; Cloudflare Worker `/signaling` is the only signaling path.

### Local Access verification harness

`wrangler.local.toml` is a separate, test-only Wrangler environment. It marks
itself `ENVIRONMENT = "local-test"` and permits the Worker to omit the runtime
`ctx.access` object only there; the production `wrangler.toml` has no such
marker and remains HTTPS-only. Start the ephemeral issuer in one terminal:

```bash
npm run dev:access
```

It generates a new RSA keypair in memory on every start and serves only a JWKS
and short-lived test assertion. Use the local config explicitly when running a
real Worker process:

```bash
npx wrangler dev --config wrangler.local.toml
```

Never copy the local marker, loopback issuer, or local config into a production
deployment. The deploy workflow and default deploy command reference only
`wrangler.toml`.

## Testing

```bash
npm test          # app + handler tests, on better-sqlite3
npm run test:workers  # the same handlers on real workerd + Durable Objects
npm run typecheck     # app and worker tsconfigs
```

`npm run test:workers` runs under `@cloudflare/vitest-pool-workers`, so it
exercises genuine Durable Object SQLite rather than a stand-in.

Two behaviours are worth keeping covered, because both are silent failures:

- `run()` returns SQLite's `changes()`, **not** `cursor.rowsWritten`.
  `rowsWritten` counts index writes, and `revokeGrant`/`denyRequest` derive
  authorization booleans from the change count.
- A `publish` must not be echoed to its sender, and must not reach another
  room's object.

## Storage limits

SQLite-backed Durable Objects are capped at 1 GB **per object**, i.e. per
room, on the Workers Free plan. Writes fail past that limit while reads and
deletes keep working.

## Unsupported legacy paths

Cloudflare Worker + Durable Objects is the only supported production
deployment. The removed Node and Docker/GHCR paths are not supported. The
legacy Node `signaling-server.mjs` was removed; Cloudflare Worker `/signaling`
is the only signaling path. The `better-sqlite3` path in
`src/lib/whiteboard/roomDb.ts` remains for the test suite only.
