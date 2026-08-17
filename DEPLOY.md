# Deployment

The app deploys to Cloudflare Workers as a single Worker that serves both the
static frontend and the room API, with one Durable Object per whiteboard room.

## Architecture

```
Browser
  |
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
- **Signaling sockets**, replacing the in-process `topics` map that
  `server.js` used. Because the object *is* the room, every socket it holds is
  on the same topic, so a `publish` fans out to the other sockets on that
  object. Keepalives are answered by `setWebSocketAutoResponse`, so idle rooms
  stay hibernated.

This is why the room API must not be scaled horizontally: signaling peers have
to meet on one instance. The Durable Object guarantees that per room.

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

`npm run dev` still runs `next dev` with the standalone signaling server for
fast UI iteration, but the API routes no longer exist in the Next.js app, so
room persistence and presence are unavailable in that mode.

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

## Legacy Node deployment

`server.js`, `signaling-server.mjs`, and the `better-sqlite3` path in
`src/lib/whiteboard/roomDb.ts` remain for local development and for the test
suite. `Dockerfile` still builds that Node server, which persists rooms to a
bind-mounted `.data` directory. It is not used by the Cloudflare deployment.
