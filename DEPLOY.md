# Deployment

The app deploys to Cloudflare Workers as a single Worker that serves both the
static frontend and the room API, with one Durable Object per whiteboard room.

## Architecture

```
Browser
  |  Cloudflare Access assertion + local app session
  |-- GET /whiteboard/<roomId>        -> static asset (placeholder page)
  |-- /api/whiteboard/room/<roomId>/* -> RoomDO for that room
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

## Deploying

```bash
npm run deploy
```

That runs `next build` (static export into `out/`) and then `wrangler deploy`,
which uploads the Worker together with the contents of `out/`.

Pushes to `main` deploy automatically via
`.github/workflows/deploy-cloudflare.yml`, which typechecks, runs both test
suites, and builds before deploying.

## Running locally

```bash
npm run dev:worker
```

Builds the static export and serves it through `wrangler dev`, which runs the
real `workerd` runtime with real Durable Objects. This is the only local mode
that exercises the production code path.

`npm run dev` invokes `npm run dev:worker`, so it uses the same real Worker and
Durable Object path as production. The unreferenced `signaling-server.mjs` file
is not started by any supported script and is not a supported runtime.

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
unreferenced `signaling-server.mjs` file is not a supported runtime. The
`better-sqlite3` path in `src/lib/whiteboard/roomDb.ts` remains for the test
suite only.
