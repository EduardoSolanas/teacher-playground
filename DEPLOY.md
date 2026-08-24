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

### Guest hostname (planned — dashboard not applied)

Guest join uses a **second hostname** on the same Worker. The teacher hostname
keeps the existing Access application (exact hostname only — no wildcard). The
guest hostname gets DNS and a Worker route but **no Access application**; adding
one breaks guest join. Set `TEACHER_HOSTNAME` and `GUEST_HOSTNAME` in Worker
env; if either is unset, every request is treated as teacher-host. Before
enabling guests in production, set `workers_dev = false` in `wrangler.toml` and
spend the zone's single free rate-limit rule on `POST /auth/guest` on the guest
hostname. See `CLOUDFLARE_ACCESS_STAGING.md` and `guest_implementation.md` §6.5;
none of this dashboard or Wrangler work is applied or verified in this
repository yet.

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

## Prerequisites

- A Cloudflare account. SQLite-backed Durable Objects are available on the
  Workers Free plan; key-value backed Durable Objects are not, which is why
  `wrangler.toml` uses `new_sqlite_classes`.
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub secrets for CI.

## Production hostname closure (externally blocked)

`wrangler.toml` disables both `workers.dev` and version preview URLs. It does
not declare a route or custom domain because this repository does not contain
an approved production hostname or proof that the deployment account controls
its Cloudflare zone. Do not guess either value.

Before the next production deployment, an authorized owner must complete this
runbook in the Cloudflare account:

1. Inventory every currently deployed hostname and route for this Worker,
   including existing `workers.dev` URLs, version preview URLs, custom domains,
   and zone routes.
2. Provide the exact approved production hostname and evidence that the
   deployment account controls its Cloudflare zone.
3. Add that single hostname as the reviewed Wrangler custom-domain or route
   configuration, then deploy through the supported GitHub workflow.
4. Disable or remove every other Worker route, custom domain, `workers.dev`
   hostname, and preview hostname found by the inventory.
5. Verify that the approved hostname reaches the Worker and that every
   inventoried alternate or direct backend hostname fails closed.

Keep the following evidence with the deployment record: the approved hostname
and route, the controlled zone and account (identifiers may be redacted), a
Cloudflare Dashboard or API inventory before and after the change, the reviewed
Wrangler diff and deployment identifier, and HTTP/WebSocket probes showing the
approved hostname succeeds while each alternate hostname is unreachable. Until
that evidence exists, production custom-hostname closure remains incomplete.

### LiveKit voice secrets (optional)

When enabling voice calling, set LiveKit credentials as Wrangler secrets (never
commit them). See README “Voice calling” for local smoke steps.

```bash
npx wrangler secret put LIVEKIT_URL
npx wrangler secret put LIVEKIT_API_KEY
npx wrangler secret put LIVEKIT_API_SECRET
```

## Deploying

```bash
npm run deploy
```

That runs `next build` (static export into `out/`) and then `wrangler deploy`,
which uploads the Worker together with the contents of `out/`.

Pushes to `main` deploy automatically via
`.github/workflows/deploy-cloudflare.yml`, which typechecks, runs both test
suites, builds, and deploys the Worker. The workflow uses the existing
production `CLOUDFLARE_API_TOKEN` secret and `CLOUDFLARE_ACCOUNT_ID` variable;
the Excalidraw distribution is published separately by its fork repository.

### Excalidraw release CDN

The production build points Excalidraw at the immutable release base:

`https://excalidraw-assets.sen-tutor.co.uk/releases/0.18.1-tp.6/dist/prod/`

The fork repository is the sole owner of the R2 bucket, custom domain, release
objects, and release metadata. This repository only consumes the pinned
immutable base URL above; it does not provision the bucket or publish release
objects. Release `0.18.1-tp.6` is published by fork workflow run
`32781207895`; public `latest.json` points to it and the package is 9,445,242
bytes. The CDN custom domain is live and serves immutable release objects. The
local fallback remains `/` when running outside a production build
or when `NEXT_PUBLIC_EXCALIDRAW_ASSET_PATH=/` is supplied.

#### Historical CDN publisher evidence

Earlier parent revisions contained a duplicate Terraform stack and an
imperative publisher. Those were deliberately removed after the fork became
the sole owner. Historical deployment runs `32680222826` and `32688811548`
recorded the old publisher failing before R2 was enabled; they are retained as
history only and are not current workflow behavior. The current parent
production deployment is green: run `32783092806` completed clean install,
security scan, typecheck, unit tests, static export, real Worker tests, and
Wrangler deployment while consuming `0.18.1-tp.6`.

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

The hostname is written in three places that must move together:

- `EXCALIDRAW_CDN_BASE_PATH` in `src/lib/whiteboard/excalidrawAssetPath.ts`
- the `font-src` default in `src/lib/worker/requestGuard.ts`
- the assertion covering that default in `src/lib/worker/requestGuard.test.ts`

A hostname change that misses the CSP produces a green test suite and a board
with no fonts, because the failure appears only as a browser console violation.

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

### Cloudflare Realtime voice control plane

The first voice slice provisions only the Cloudflare Calls SFU application;
browser/provider migration and room media routes remain a separate change. Run
the manually dispatched `.github/workflows/provision-cloudflare-realtime.yml`
workflow after granting the production `CLOUDFLARE_API_TOKEN` account-level
Calls SFU app read/write permission. It uses the same
`CLOUDFLARE_ACCOUNT_ID` production variable as the playground deployment.

The workflow runs security scan, typecheck, unit tests, build, and real Worker
tests before its first Cloudflare API mutation. It reconciles the named app,
stores `CLOUDFLARE_REALTIME_APP_ID` as a Worker secret on every run, and stores
the one-time `CLOUDFLARE_REALTIME_APP_SECRET` only when the app is first
created. It never logs the secret or recreates an existing app. The Terraform
specification is in `infra/cloudflare/realtime-sfu/` and uses
`prevent_destroy`.

The R2 asset deployment is complete through the fork-owned release workflow.
The remaining independent blocker is Cloudflare Calls token permission; it does
not affect the CDN or the playground deployment.

The Realtime-only production attempt in GitHub Actions run `32783632121`
passed installation, secret scanning, typecheck, 901 unit tests, the static
build, and 324 real Worker tests. Cloudflare then rejected the first read-only
`GET /accounts/{account_id}/calls/apps` request with HTTP 403/code 10000
(`Authentication error`). No Calls app was created; the UID and secret storage
steps were skipped. Grant the existing production token effective account-level
Calls SFU Read and Calls Write/Edit permission, with the correct account scope,
before rerunning the `realtime` target.

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
