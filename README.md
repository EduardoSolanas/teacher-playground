# Teacher Playground

Collaborative whiteboard (Excalidraw + Yjs) with Cloudflare Access, a waiting
room, and optional **LiveKit** video/voice for admitted participants.

## Stack

- Next.js static export + Cloudflare Worker (`src/worker.ts`)
- One Durable Object per room (`RoomDO`) for board state + signaling
- LiveKit SFU for A/V (server-issued short-lived JWTs)

### Three hostnames, one Worker

All three route to the same Worker; the surface is chosen from the `Host`
header in code, not by separate deployments (`wrangler.toml`, `[vars]`).

| Var | Hostname | Surface | Cloudflare Access |
|---|---|---|---|
| `TEACHER_HOSTNAME` | `app-playground.sen-tutor.co.uk` | Teacher app | **Protected** — exact hostname only |
| `GUEST_HOSTNAME` | `join-playground.sen-tutor.co.uk` | Guest join | Must **not** be covered |
| `MARKETING_HOSTNAME` | `playground.sen-tutor.co.uk` | Public landing page | Must **not** be covered |

A `*.sen-tutor.co.uk` wildcard Access application would cover all three: it
breaks guest join and puts a login in front of the marketing site. If
`TEACHER_HOSTNAME` or `GUEST_HOSTNAME` is unset, every request is treated as
teacher-host and the guest surface does not exist — it never defaults to guest.

## Collaboration and signaling

Board state is a Yjs document synced over a WebSocket to `RoomDO`. Three
constraints are load-bearing and have each been broken at least once.

**The server holds the board.** `RoomDO` relays raw bytes between sockets *and*
keeps its own Y.Doc per room (`getRoomDoc`), rehydrated from a stored snapshot
or seeded from the SQL `elements` row so a board created before snapshots
existed does not open empty. `handleSyncFrame` (`serverSync.ts`) applies each
sync frame to that document and answers a peer's sync step 1 with both the diff
it is missing *and* the server's own step 1 — without that second frame the
server would only ever hand boards out and never take one in. An empty room is
therefore no longer whatever the first peer happened to have.

The provider still re-issues sync step 1 on an interval (`RESYNC_INTERVAL_MS`
in `yWebsocketProvider.ts`). Do not remove it because the server is now
authoritative: it is the recovery path for a peer whose updates arrived with a
causal gap, which Yjs parks in `pendingStructs` so that its cursors and
elements silently never appear on the other side while the socket looks
perfectly healthy. Removing it needs a convergence test, not this paragraph.

**Signaling is budgeted at 120 messages/second per account**
(`SIGNALING_MAX_MESSAGES_PER_WINDOW` in `requestGuard.ts`, mirrored as
`SIGNALING_BUDGET` in `signalingBudget.ts`). Going over the budget does not
close the socket. `decideSignalingAction` sheds *awareness* frames
(`messageType === 1`, i.e. cursors) and never sheds sync frames, because
y-websocket does not retransmit a dropped delta over an open socket and the
drawing would be lost for good. The Worker closes with 1008 only on sustained
abuse: at or above the ceiling of 360 messages/window (`SIGNALING_ABUSE_CEILING`,
3x the budget) across two consecutive windows. A single transient spike sheds
cursors and stays connected.

Every Yjs write is still one message, so anything driven by pointer movement
must be throttled. Cursors go through `cursorPublishDelay`
(`cursorPublishRate.ts`) in *both* writers — the room pointer handler and
Excalidraw's `onPointerUpdate`. Publishing on every `pointermove` measured 64
msg/sec; under the earlier 60-message budget that closed the socket four times
in two seconds, which the UI shows as a board stuck on "Connecting to room…".
The budget is higher and the shedding is gentler now, but an unthrottled writer
still spends the whole allowance on cursors.

**Peer ids are minted by presence, not chosen by the client**
(`peerIdForAccount`; clients may not pick their own — see the "issues a stable
server peerId" test). An account with no `room_presence` or `waiting_peers` row
gets a fresh one, so dropping that row mid-session silently re-identifies the
peer and strands every id the host holds: roster rows, moderation targets,
cursors. The row is released only when the room is actually left, never as a
side effect of a re-render. Moderation targets the **account** rather than a
peer id (`moderationTargetBody`), and `resolveModerationTarget` falls back to a
known account when the peer id is stale.

Regression coverage: `tests/e2e/cursor-signaling.spec.ts` for the rate budget,
and "a peer keeps one peer id across admission" in
`tests/e2e/waiting-room.spec.ts`.

## Video and voice (Phase 3)

**Provider choice:** LiveKit (self-hostable SFU, Workers-friendly HS256 tokens).
Daily and Cloudflare Calls were considered; LiveKit won for self-hosting and
token signing with Web Crypto on Workers (no Node SDK required).

### Required env vars

Set these as Wrangler secrets (production) or `[vars]` / `.dev.vars` (local):

| Variable | Purpose |
|----------|---------|
| `LIVEKIT_URL` | WebSocket URL, e.g. `wss://your-project.livekit.cloud` |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret (never commit) |

If any value is missing, `POST /api/av/token` returns **503** and the room UI
shows a graceful “not configured” message. Whiteboard collaboration keeps
working without LiveKit.

### Local smoke steps

1. Create a free project at [LiveKit Cloud](https://cloud.livekit.io/) (or run
   a self-hosted LiveKit server).
2. Copy `.env.local.example` → `.dev.vars` (Wrangler) and fill the three
   `LIVEKIT_*` values. For `wrangler.local.toml` you can also put non-secret
   placeholders under `[vars]` and keep the secret in `.dev.vars`.
3. Start Access issuer + Worker:

```bash
npm run dev:access          # terminal 1
npx wrangler dev --config wrangler.local.toml   # terminal 2
```

4. Open two browsers (or a normal + incognito window), join the same
   `/whiteboard/<roomId>` as host and peer.
5. Admit the waiting peer. Both should see the Call panel: mute/unmute and
   camera toggles; remote tiles update when the other peer changes media.
6. Leave or kick a peer — local tracks tear down (Call panel stops).

Waiting-room users never receive an A/V token (API returns **403**).

### API

`POST /api/av/token?roomId=<id>&identity=<peerId>&name=<displayName>`

- Requires Cloudflare Access + local app session (same as other `/api/*` routes)
- RoomDO admits **owner/member** only; waiting → 403; unconfigured → 503
- Response: `{ token, url, room, identity }`

## Scripts

```bash
npm test              # Vitest unit tests (jsdom)
npm run test:workers  # Durable Object / Worker integration tests (real workerd)
npm run test:e2e      # Playwright against a local Worker + Access issuer
npm run typecheck     # both tsconfig.json and tsconfig.worker.json
npm run lint
npm run build
npm run deploy        # next build + wrangler deploy
```

`npm run test:e2e` must go through `scripts/run-e2e.mjs`: it allocates the
ports and starts the local Access issuer, and `playwright.config.ts` throws
without the `E2E_PORT` / `E2E_ACCESS_ISSUER` / `E2E_ACCESS_TOKEN` it sets.

See `DEPLOY.md` for Cloudflare deployment and Access setup.
