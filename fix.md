# fix.md — implementation brief

Audience: an implementing model working in `D:\new-projects\teacher-playground`.
Everything below was verified against the tree at commit `44120a2` plus the
uncommitted working-tree changes. Baseline is green: `npm run typecheck` clean,
`npx vitest run` = 110 files / 1187 tests passing. Keep it that way.

## Ground rules (from CLAUDE.md — non-negotiable)

- **TDD, strict.** Red → Green → Refactor for every item. Write the failing
  test first, watch it fail, then make it pass.
- **Real objects only.** No mocks, no stubs, no test doubles. If a test needs a
  LiveKit `Room` or a Y.Doc, construct a real one.
- **Surgical changes.** Change only what the item requires. Match surrounding
  style — this codebase writes long explanatory comments above non-obvious
  decisions; keep that voice.
- **KISS + SOLID.** No new abstractions unless an item asks for one.
- Run `npx vitest run` and `npm run typecheck` before reporting any item done.
  Worker-pool tests: `npm run test:workers`.
- Commit directly to `main`, one commit per numbered item, and push after each
  commit. Stage only the files your item touched — the tree is edited
  concurrently.

## Priority order

§0 first — it is small, risk-free, and it makes every item after it debuggable
instead of guessable. Then §1 (the user-visible bug), §2 (a live production
500), §3 (LiveKit quality pass), §4 (cosmetic), §5–§7 (structural, pick up when
the fires are out).

---

# §0 — Make the silent failures loud (DO THIS FIRST)

Not a bug fix. This is why the bugs below took an evening each to find instead
of ten seconds, and it is the highest ratio of relief to effort in this file.

`src/do/RoomDO.ts` alone contains roughly fifty `try { … } catch { /* ignore */ }`
blocks. Every one was a defensible local decision — "a presence update is not
worth dropping a lesson's connection over" — and collectively they mean the
system never says what went wrong. The frame drop in §1 is silent. The presence
500 in §2 hides its cause behind a generic body. A user reports "it broke" and
there is nothing to read.

**Scope: observability only. No behaviour changes. No control flow changes.**

1. Audit every empty/comment-only `catch` in `src/do/RoomDO.ts`,
   `src/hooks/useCollaboration.ts`, and `src/lib/whiteboard/`. For each, decide:
   genuinely nothing to say (a socket that is already closed), or a swallowed
   symptom. Add a structured log line to the second kind. Follow the existing
   shape — `logSocketClose`, `logBoardSnapshot`, `serializeInternalError` — and
   respect `redactForLog` in `src/lib/http/safeError.ts`; these lines must never
   carry board content, emails, or tokens.
2. Add one client-visible degraded state — "sync degraded", distinct from the
   existing `connectionLost` — that any of these conditions can raise: a shed
   frame reported by the server, a 5xx heartbeat, a socket closed with 1008/1009.
   The user should never again be the last to know the board stopped syncing.
3. Write down (in the commit message) the `wrangler tail` invocation that shows
   these lines, so the next person does not have to rediscover it.

Tests: assert the log line is emitted and redacted for a representative case of
each kind. Do not test the exact wording.

---

# §1 — Host↔peer sync breaks while drawing (CRITICAL)

## Symptom

Host draws; the peer's board silently stops updating. No error, socket still
open. Sometimes the socket closes with 1008 and the peer bounces through
"Connecting to room…".

## Root cause

`src/do/RoomDO.ts` → `webSocketMessage` (around line 1594) rate-limits every
inbound frame per **account** at 60/1000ms, then consults
`src/lib/worker/signalingBudget.ts`:

```
messagesInWindow <= 60          → 'relay'
60 < messagesInWindow < 180     → 'drop'   (silent)
messagesInWindow >= 180         → 'close'  (1008)
```

The `'drop'` branch does a bare `return` **before both** the peer relay loop
*and* the `handleSyncFrame(doc, bytes, ws)` call that applies the update to the
server's own `Y.Doc`. So a shed frame reaches neither the other peers nor the
server. y-websocket does **not** retransmit on a still-open socket, so that
delta is lost forever — the host's local doc believes it was delivered.

`signalingBudget.ts`'s header comment claims "Dropping a frame is invisible to
the person". That is true for awareness (cursor) frames and **false** for sync
frames. The whole bug is that one sentence applied to the wrong message type.

The asymmetry that matters:

- A **closed** socket self-heals — y-websocket reconnects and runs sync step
  1/2 against the server doc, which the DO answers from `getRoomDoc`.
- A **dropped sync frame** never heals.

The current design reserves the safe action for abuse and hands the destructive
one to a teacher drawing quickly.

## Why it triggers in ordinary use

Steady-state cost of one drawing host:

| source | rate |
|---|---|
| stroke commits — `strokeCommitIntervalMs`, `src/components/whiteboard/ExcalidrawWrapper.tsx:795` | ~20/s |
| cursor publishes — `CURSOR_PUBLISH_INTERVAL_MS = 50`, `src/lib/whiteboard/cursorPublishRate.ts` | ~20/s |
| sync replies, follow frames, paste / undo / image bursts | spiky |

~40/s against a 60/s cap: 20 frames of headroom. Worse,
`countRejected: true` on the limiter (`src/do/RoomDO.ts:206`) means refused
frames keep incrementing the counter, so a client that crosses 60 **cannot get
back under it** while the pen keeps moving; a sustained burst walks the counter
to 180 and closes the socket. The comment block in `cursorPublishRate.ts`
records that the 1008 close has already bitten this project once.

## Files

- `src/lib/worker/signalingBudget.ts` (+ `signalingBudget.test.ts`)
- `src/do/RoomDO.ts` — `webSocketMessage`, and the limiter field at ~line 206
- `src/lib/worker/requestGuard.ts` — `SIGNALING_MAX_MESSAGES_PER_WINDOW`
- `src/lib/whiteboard/relayPolicy.ts` — already decodes the frame type; reuse it
- `src/do/roomDOSync.workers.test.ts`, `src/do/signalingAdversarial.workers.test.ts`

## Required behaviour

1. **Sync frames (y-protocol message type 0) are never shed.** They are either
   relayed + applied, or the socket is closed. `relayPolicy.ts` already decodes
   the leading varint message type — reuse that, do not write a second decoder.
2. **Awareness frames (type 1) are the only sheddable ones.** Shedding a cursor
   position genuinely is invisible; the next one supersedes it.
3. **When relay is shed, still apply the frame to the server doc** so the
   server stays authoritative and peers converge on their next sync.
4. **Raise the budget.** `SIGNALING_MAX_MESSAGES_PER_WINDOW` / `SIGNALING_BUDGET`
   goes from 60 to 120 per 1000 ms, because a drawing host plus cursors plus
   several peers' sync replies leaves 60 with no headroom. Document the
   arithmetic in the comment the way the existing constants do.
   **Caveat: 120 is derived from the code's own throttle constants (~20/s
   strokes + ~20/s cursors + peer replies), not from a measurement under real
   load.** If §0 has landed, the shed-frame log gives you the true distribution
   within a day of use — prefer that number over this one, and say in the
   comment which of the two it is.
5. **The abuse ceiling judges sustained abuse, not one bucket.** A single
   1000 ms window over the ceiling must not close a socket; require the breach
   to persist across consecutive windows. Keep it simple — a count of
   consecutive over-ceiling windows is enough.
6. **Stop counting rejected frames** (`countRejected: true` → remove), or scope
   that counting to awareness only. As written it makes recovery impossible for
   a legitimately busy client.
7. **Log every shed.** `'close'` already logs via `logSocketClose`; `'drop'` is
   completely silent, which is why this never showed up in production. Emit a
   structured line with `roomId`, `accountId`, `messagesInWindow`, and the frame
   type, following the existing `logSocketClose` / `logBoardSnapshot` shape.

## Tests to write first

In `src/lib/worker/signalingBudget.test.ts` — the decision function now takes
the frame type as input:

- a sync frame over budget resolves to relay (never drop)
- an awareness frame over budget resolves to drop
- one window over the ceiling does not close; N consecutive windows do

In the workers suite (`src/do/roomDOSync.workers.test.ts`):

- **the regression test that proves the bug**: push ~100 real Yjs sync frames
  through one socket inside a single rate window, then assert (a) the server's
  `Y.Doc` contains every update, and (b) the second peer socket received them.
  Build the frames with real `yjs` + `y-protocols` encoders — no fakes.
- an awareness flood over budget does not close the socket and does not lose
  any sync update interleaved with it.

## Client-side follow-on (same item)

- On a 1008/1009 close the user sees nothing but a silent reconnect. Surface the
  existing degraded state (`connectionLost` in `src/hooks/useCollaboration.ts`)
  for those codes.
- Add a test asserting a reconnect performs a full resync rather than resuming
  blind.

---

# §2 — `/api/whiteboard/room/<id>/presence` returns 500 in production

Observed in the browser console alongside the drawing break. Separate bug, same
apparent symptom to the user: peers vanish from the roster.

## What is wrong

**a. The error is unloggable in practice.** Every DB failure in
`src/lib/whiteboard/handlers/presence.ts` is swallowed by
`internalErrorResponse(e, 'handlePresenceGet' | 'handlePresencePost' |
'handlePresenceDelete')` and surfaces only as a `console.error` line
`{"event":"internal_error","op":…,"name":…,"message":…}`.

→ **First action, before changing anything: run `wrangler tail` against the
deployment, reproduce, and capture that line.** It names the throwing op and
the real error. Do not guess a fix ahead of that output. Record what it said in
the commit message.

**b. A 500 silently deletes the peer from the room.**
`src/lib/whiteboard/presenceAdmission.ts` maps 500 → `'ignore'`, so the client
skips the beat and keeps its backoff. `ACTIVE_WINDOW_MS = 10_000`
(`src/lib/whiteboard/presence.ts:10`) and the heartbeat caps at
`PRESENCE_POLL_MAX_MS = 5_000`, so **two consecutive 500s and a present peer is
swept out of everyone's roster** while its own UI shows nothing wrong.

Fix: a 5xx must retry promptly (reset the backoff to `POLL_BASE_MS` rather than
waiting it out) and, after repeated failures, raise the same visible degraded
state the socket loss uses. Test `admissionFromPresenceStatus` and the
heartbeat effect in `src/hooks/useCollaboration.ts` for this.

**c. The presence POST path is absurdly expensive, and is the prime suspect for
whatever is throwing.** `src/do/RoomDO.ts:371` and `:403` call
`presenceSignature(this.db, roomId)` **twice per POST**. Each call runs
`readActiveUsers` — which itself executes a `DELETE` sweep — plus
`readWaitingPeers`. The handler then builds the payload with another
`readActiveUsers`. That is roughly five roster scans and three writes **per
heartbeat per peer**, every 2 seconds. Ten peers ≈ 25 scans/second on a single
Durable Object.

Fix: compute the roster once per request and derive both the signature and the
payload from it, or detect "did anything change" from the mutation's own result
instead of a before/after signature. Behaviour must be identical — a heartbeat
that only moves a timestamp still must not broadcast.

**d. `RoomDO.fetch` has no top-level try/catch** (it starts at
`src/do/RoomDO.ts:275`). Everything the presence wrapper does —
`presenceSignature`, `bindPeerAccount`, `broadcastPresence`,
`purgeExpiredGrants`, `purgeExpiredRoomLifecycle` — runs outside any handler
guard, so a throw escapes the object rather than becoming a response. Wrap the
body of `fetch` and return `internalErrorResponse(e, 'RoomDO.fetch')`. Add a
workers test that a throwing section yields a logged 500 and leaves existing
sockets usable.

---

# §3 — LiveKit React integration review

Introduced across `d9c4dd4..HEAD`. It works, but it churns and carries a
test-only branch in production UI.

**3.1 `useAvSession` returns a new object every render.**
`src/hooks/useAvSession.ts:202` returns a fresh object literal with fresh
arrays and fresh closures on every render. Any consumer with `av` in a
dependency array re-runs constantly — notably `ParticipantTile`'s
attach/detach effect at `src/components/av/AvSessionPanel.tsx:201`, which tears
down and re-attaches the video element on every parent render. Memoize the
returned object; give each action a stable `useCallback`. Test: render, force a
parent re-render, assert the effect ran once.

**3.2 `room` is read from a ref during render.**
`room: (sessionRef.current?.getRoom?.() as Room | null) ?? null` — impure, and
not a reactive source; it only appears because `setSession` happens to
re-render. Hold the room in state.

**3.3 Two rendering paths per tile.** `AvSessionPanel.tsx:238` renders LiveKit's
`<VideoTrack>` when `av.room` exists and a manual `<video>` + `av.attachTrack`
when it does not. The second exists only because the tests do not supply a
`Room`. That is a test-only branch shipping to users. Per "real objects only",
give the tests a real `Room` and delete the fallback path — and its
`attachTrack` / `detachTrack` plumbing if nothing else uses it.

**3.4 Screen-share publication preference is unguarded.**
`getTrackPublication(Track.Source.ScreenShare) ?? getTrackPublication(Track.Source.Camera)`
(`AvSessionPanel.tsx:216`): a lingering, unsubscribed screen-share publication
renders a blank tile *and* hides the camera. Require a subscribed publication
with a live track before preferring it.

**3.5 A rename tears down the call.** `displayName` is in the join effect's deps
(`src/hooks/useAvSession.ts:194`), so renaming mid-call disconnects and rejoins
LiveKit. Update the participant's name/metadata on the existing connection
instead, and keep only identity-affecting values in the deps.

**3.6 Verify teardown releases the media.** `LiveKitProvider` constructs
`new Room()` as a field initializer (`src/lib/av/livekitProvider.ts`). Confirm
`leave()` disconnects it and releases published tracks — a leaked `Room` keeps
the microphone hot and the browser's recording indicator lit after hanging up.
Test against a real `Room`'s own state, not a spy.

**3.7 Double audio.** `RoomAudioRenderer` plus the manual attach path can both
play the same remote audio track. Once 3.3 lands this should be impossible;
assert it.

**3.8 The call flag is persisted with the board (working-tree change).**
`src/app/whiteboard/[roomId]/RoomClient.tsx:262` writes call state into
`yDoc.getMap('call')`. That map is part of the persisted room document, so
`active: true` **outlives the session**: a host who reloads or crashes leaves
every peer auto-joining a call forever. Move it to awareness (ephemeral), or
clear it when the host disconnects. In the same effect, the observer
re-subscribes on every `users` change — that array is rebuilt by the 2 s
presence poll, so it re-subscribes twice a second. Depend on the host's
presence, not the array identity.

---

# §4 — Cosmetic

`__next/tree.txt?_rsc=…` 404s in the console are Next 16's RSC prefetch hitting
a deployment that does not serve the RSC tree. Harmless. Silence it by
disabling prefetch on the links that request it, or by serving the route.

---

# §5 — The multi-peer e2e is flaky, which hides real regressions

`tests/e2e/whiteboard.spec.ts` fails a different subset of its cases on each
run. That is not a nuisance — it is the reason a drawing-sync regression like
§1 can ship. When the only test that exercises two peers on one board is
untrusted, nobody can tell a new break from the usual noise, so every failure
gets re-run instead of read.

This is worth more than any single bug fix on this list, and it is the item
most likely to be skipped. Do not skip it.

1. Run it ten times at `HEAD` **before changing anything** and record which
   cases fail and how often. That baseline is the deliverable of step 1 — you
   cannot tell a fix from luck without it.
2. Diagnose the flake, do not paper over it. Expect fixed-duration waits where
   the code should await a condition, assertions racing the 2 s presence poll,
   and shared room ids across parallel workers. Note that §1's frame shedding is
   itself a plausible source of nondeterminism in a two-peer drawing test —
   re-baseline after §1 lands before concluding a case is inherently flaky.
3. `test.retries` is not a fix; it is how a flaky test stays flaky forever.
   Only quarantine a case (`test.fixme` with a linked note) if you have
   diagnosed it and are deliberately deferring the fix.
4. Done means ten consecutive green runs, and the count recorded in the commit
   message.

---

# §6 — `as any` at the y-websocket provider seam

`strict: true` is set in both `tsconfig.json` and `tsconfig.worker.json`, and
`npm run typecheck` runs both — the type checking is real and there is no
config gap. But it is cast away at exactly the seam where the sync bugs live:
37 non-test `as any` in `src/`, concentrated in `yjsDoc.ts` (18),
`yWebsocketProvider.ts` (3), `collaboration.ts` (3), `store.ts` (3),
`selection.ts` (3), `useCollaboration.ts` (2).

That is how `provider.connected === true` survived review: the provider is
reached as `(collaborationRef.current.provider as any).on?.('status', …)`, so
`.connected` was compared against nothing at all — `undefined === true`, false
forever, on a healthy socket. The comment in `useCollaboration.ts` narrating
that bug is worth reading before starting.

Declare a real interface for the provider surface actually used —
`on`/`off`/`connect`/`disconnect`/`wsconnected`/`synced`/`awareness`/
`shouldConnect` — and delete the casts against it. Where a cast covers a
genuine gap in the upstream `y-websocket` types, keep it but narrow it to the
one property and comment why.

Do not attempt all 37 in one commit. `yjsDoc.ts` is a separate concern from the
provider seam; the provider files are the ones that pay for themselves.

---

# §7 — What would stop the next one

Optional, and the right time is after §0 and §5 land, not before.

The load-bearing knowledge in this repo lives in prose. The comments are
genuinely excellent — `cursorPublishRate.ts` explains exactly why the 1008
close matters, `pollBackoff.ts` explains exactly why presence cannot back off
past half the active window — but a comment cannot fail a build. §1 is the same
shape as the bug `cursorPublishRate.ts` describes: a budget the real drawing
rate outgrew.

Where a comment states a numeric invariant, add the test that asserts it:

- the cursor publish rate plus the stroke commit rate must fit inside the
  signaling budget with headroom (this single test would have caught §1)
- `PRESENCE_POLL_MAX_MS * 2 <= ACTIVE_WINDOW_MS` (the invariant
  `pollBackoff.ts` states in prose)
- `PRESENCE_POST_RATE_MAX` must exceed the client's actual heartbeat rate with
  margin (the comment in `rateLimits.ts` records this being violated once)

These are cheap, they read as documentation, and they turn the graveyard of
past bugs into a fence.

---

## Definition of done

- Every item has a test that failed before the change and passes after.
- `npx vitest run` — 110+ files, all passing.
- `npm run typecheck` — clean.
- `npm run test:workers` — passing (the §1 and §2d tests live here).
- `npm run lint` — clean.
- One commit per numbered item on `main`, pushed.
- For §2, the commit message records what `wrangler tail` actually reported.
- For §5, the commit message records the ten-run baseline and the ten-run
  green result.
- `npm run test:e2e` — see §5; if a case is quarantined, it is quarantined
  deliberately and linked, not retried into passing.
