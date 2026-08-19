# Teacher Playground

Collaborative whiteboard (Excalidraw + Yjs) with Cloudflare Access, a waiting
room, and optional **LiveKit** video/voice for admitted participants.

## Stack

- Next.js static export + Cloudflare Worker (`src/worker.ts`)
- One Durable Object per room (`RoomDO`) for board state + signaling
- LiveKit SFU for A/V (server-issued short-lived JWTs)

## Collaboration and signaling

Board state is a Yjs document synced over a WebSocket to `RoomDO`. Three
constraints are load-bearing and have each been broken at least once.

**The Worker is a blind relay.** `RoomDO` forwards raw bytes between sockets and
keeps no server-side Y.Doc, so nothing holds authoritative state. Whoever
connects first sends sync step 1 into an empty room, and nobody ever asks a
later joiner for its baseline. The provider therefore re-issues sync step 1 on
an interval (`RESYNC_INTERVAL_MS` in `yWebsocketProvider.ts`). Without it a
peer's updates arrive with a causal gap, Yjs parks them in `pendingStructs`,
and their cursors and elements silently never appear on the other side — the
socket looks perfectly healthy the whole time.

**Signaling is capped at 60 messages/second per account**
(`SIGNALING_MAX_MESSAGES_PER_WINDOW`); the Worker closes the socket with 1008
above that. Every Yjs write is one message, so anything driven by pointer
movement must be throttled. Cursors go through `cursorPublishDelay`
(`cursorPublishRate.ts`) in *both* writers — the room pointer handler and
Excalidraw's `onPointerUpdate`. Publishing on every `pointermove` measured 64
msg/sec and closed the socket four times in two seconds, which the UI shows as
a board stuck on "Connecting to room…".

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
npm test              # Vitest unit tests
npm run test:workers  # Durable Object / Worker integration tests
npm run typecheck
npm run lint
npm run build
npm run deploy        # next build + wrangler deploy
```

See `DEPLOY.md` for Cloudflare deployment and Access setup.
