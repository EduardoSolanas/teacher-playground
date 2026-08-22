# Plan: let the room object hold the board

## Why

`RoomDO` is a pipe. It relays bytes between sockets and deliberately holds no
document of its own — the comment in `src/lib/whiteboard/yWebsocketProvider.ts`
records the consequence: a client connecting first syncs into an empty room and
nobody ever asks the later joiner for its baseline, which is why a 3s resync
interval exists to paper over it.

Because no server copy exists, clients own durability. Everything below follows
from that one fact:

| Symptom | Cause |
| --- | --- |
| Whole-board `POST` per client, debounced 3s | the only durable copy is in a browser |
| Two peers racing to store different views | two writers, no authority |
| `413` on a large board | the whole board travels as one HTTP body |
| Board depends on a tab staying open | nobody writes it down otherwise |
| Late joiner needs another peer connected | no server state to sync from |
| 3s resync interval | no authority to ask for a baseline |

`53a1a66` patched the race and `df6ff5b` shrank the payload. Neither addresses
the cause.

## The thing that makes this cheap

**Clients do not change.** They already speak the y-websocket protocol to this
endpoint. Today the object forwards those frames to peers; afterwards it also
applies them to a document of its own and answers sync requests itself. That is
a superset of current behaviour, so there is no client rollout, no mixed-version
hazard of the kind `df6ff5b` carried, and no coordinated deploy.

`yjs` is already a direct dependency and `y-protocols` is present via
`y-websocket`, so the protocol handling is wiring rather than authorship.

## Slices

Each slice ships on its own and is verifiable on its own. Stop after any of them
and the system is still coherent.

### Slice 1 — the object keeps a document

Give `RoomDO` a `Y.Doc` per room. On a binary frame, decode the y-protocol
message and handle it rather than only forwarding:

- **sync step 1** (a client's state vector): reply with the diff the client is
  missing, instead of hoping a peer answers.
- **sync step 2 / update**: apply to the server document, then broadcast to the
  other sockets exactly as today.
- **awareness**: keep forwarding untouched.

Relaying continues unchanged, so peers keep converging even if the server
document is wrong — this slice cannot make sync worse, only add a second path.

*Done when:* a peer joining a room where **no other peer is connected** receives
the existing board from the server. Today it receives nothing. That is a workers
test: open a socket, write elements, close it, open a fresh socket, assert sync.

*Risk:* getting sync step 1/2 wrong. Contained, because the relay is still
there — a bug shows as "server sync adds nothing", not as lost work.

### Slice 2 — the document survives hibernation

`RoomDO` uses `ctx.acceptWebSocket`, so it is evicted between messages and any
in-memory document is lost. Persist and rehydrate:

- write `Y.encodeStateAsUpdate(doc)` into DO storage, debounced — on idle, on
  the existing alarm, and on last-socket-close, never per update
- on a cold message, load that snapshot before handling the frame
- keep the doc in memory while the object is awake

*Done when:* a room with no sockets for long enough to be evicted still returns
its board to the next joiner. Workers tests can force this by exercising the
storage path directly rather than waiting for a real eviction.

*Risks worth naming:*
- **Storage cadence.** Per-update writes would trade HTTP amplification for
  storage amplification. Debounce, and measure the write rate before and after.
- **Snapshot size.** Boards are small today (~44KB measured, smaller since
  binary points), but a single stored value has limits. Chunk only if a measured
  board approaches them — do not pre-build for it.
- **Rehydrate cost on a cold frame.** One storage read plus `applyUpdate`.
  Measure it; if it hurts, keep a short-lived in-memory cache keyed by room.

### Slice 3 — retire the client uploads

Only once slices 1 and 2 are proven:

- seed the server document from the existing stored elements the first time a
  room is opened and no Yjs snapshot exists, so boards created before this work
  are not lost
- stop clients calling `POST /api/whiteboard/room/:id` for scene writes
- delete `saveState`, `shouldPersistBoard`, and the debounce that goes with them
- keep the read path until the seed has run everywhere

*Done when:* no client uploads a board, and a room created before the change
still opens with its contents.

*Risk:* the migration. A room must never open empty because the seed did not
run. Guard it: seed on read, not on a script, so it is impossible to miss.

## Effort

Slice 1 is the interesting one — perhaps half a day, most of it spent on
y-protocol correctness and its tests. Slice 2 is a similar size and its risk is
operational rather than logical. Slice 3 is small in code and needs the most
care, because it is the only irreversible one.

Call it a focused day for someone who knows this codebase, plus a deliberate gap
between slice 2 and slice 3 to watch the storage write rate in production.

## What gets deleted

The measure of success is subtraction: `saveState` and its debounce,
`persistOwnership`, the whole-board `POST`, the `413` surface, and the 3s resync
interval that exists only because no authority can answer a baseline request.

## What this does not fix

- **Waiting peers still have no socket.** `/signaling` opens on admission, so
  admission latency for the student is untouched. That is a separate decision
  about giving waiting peers a restricted connection, and it is a security
  question before it is a performance one.
- **Ghost cursors.** A departed peer's cursor stays in the document because
  nothing removes it on close. A server-held document makes the fix easy —
  sweep on `webSocketClose` — but it is not automatic.

## ChatGPT review for the main model (2026-08-22)

### Read this as an implementation review, not a fresh proposal

Commit `befdfc5` has already landed most of slices 1–3: `RoomDO` owns a Yjs
document, answers sync frames, stores `ydoc:<roomId>`, rehydrates after
eviction, seeds from the SQL scene, mirrors the document back to the SQL read
path, and the collaboration hook no longer uploads the board. The remaining
work should therefore be small corrective slices around the implementation
that exists, not a second rewrite.

### Non-negotiable product outcome: fluid and server-authoritative

The desired experience is that drawing on the host appears on the peer, and
drawing on the peer appears on the host, as one continuous live stroke rather
than as periodic snapshots. The server is the authority: a browser may keep an
optional offline cache, but reopening or joining a room must never depend on
another browser or on that browser having uploaded a final copy.

The hot path should be:

1. Excalidraw writes a small Yjs delta locally, currently at most once per 50ms
   during a stroke and once immediately on pointer-up.
2. The existing WebSocket sends that delta to the room's Durable Object.
3. `RoomDO` applies it to the in-memory server document and broadcasts it to the
   other admitted sockets immediately, without waiting for SQL, object storage,
   an HTTP poll, or the durable flush interval.
4. The receiving canvas applies the Yjs change immediately. React state may be
   coalesced for non-visual bookkeeping, but that coalescing must not delay what
   the user sees.
5. Persistence happens behind the live relay. The server snapshot is flushed on
   a bounded cadence and on last-socket-close, and it supplies the baseline to
   every reload, reconnect, and late join.

"All stored on the server" means every state item that must survive a reload is
server-owned: board elements and deletions, the host's stored viewport, room
settings, membership, and moderation state. Live pointer positions and transient
presence should still be server-mediated so peers do not depend on a direct
browser-to-browser connection, but they should not be retained as durable lesson
content after those peers leave. Persisting cursor churn inside the board
snapshot adds size and ghost state without improving recovery.

Use measurable acceptance targets rather than calling it "real time" by feel:

- under the supported host-plus-peer plan, a live stroke or cursor sample should
  appear remotely within one 50ms publish window plus network/Worker latency;
  target p95 under 150ms in the browser E2E environment
- pointer-up must force the final stroke state immediately; throttling may
  coalesce intermediate samples but must never lose the final sample
- the drawing path must contain no HTTP request, 2s poll, 3s resync wait, or
  durable-storage wait
- after both browsers close, a fresh browser must reconstruct the same board
  from `RoomDO` with no previous peer online
- after the final accepted edit, bound the server durability window to 3s even
  if the socket stays connected and no more frames arrive
- a reconnect must converge automatically without duplicating shapes,
  resurrecting deletions, or overwriting a peer's concurrent edit

Add latency instrumentation to the test/debug path before tuning constants:
stamp a local publish, observe the corresponding element version in the other
browser, and record p50/p95. Test continuous simultaneous drawing in both
directions, not just one isolated rectangle. Keep board traffic ahead of cursor
traffic under load; a moving cursor must not consume the signaling budget and
cause a board update or final pointer-up update to be dropped.

The original deletion list also needs qualifying:

- the client whole-board upload and `persistOwnership` are gone
- the HTTP scene-write route still accepts `elements`, so there are still two
  possible writers even though the current client uses only the Yjs path
- the 3s `resyncInterval` is still enabled in `yWebsocketProvider.ts`
- `usePersistence.saveState` still exists for the explicit, opt-in local
  offline cache; it is no longer the server durability mechanism and should
  not be deleted merely because it shares the old name

### Current working-tree evidence

The focused unit command for `serverSync.test.ts` and the new
`snapshotBudget.test.ts` passes 11 tests. The focused Worker command for
`server-side y-websocket sync` currently passes six tests and fails two:

1. `sweeps a departed peer cursor and tells the peers still connected` times
   out because `webSocketClose` does not sweep or broadcast cursor deletion.
2. `re-seeds from the row when a board is written straight to it` receives the
   old rectangle instead of the replacement ellipse because an HTTP
   `elements` write updates SQL but leaves both the in-memory and stored Yjs
   documents authoritative and stale.

Those tests and the untracked snapshot-budget files are existing work. Preserve
them and complete their red/green cycles; do not replace or weaken the tests.

### Recommended order of work

#### 1. Finish the two existing red tests

For ghost cursors, remove only cursor entries that no longer correspond to an
active peer, transact the deletion in the room document, relay the resulting
Yjs update to the remaining sockets, and let the ordinary dirty-document path
persist it. Account for multiple sockets and for a peer id changing at an
admission boundary; do not assume the closing socket attachment contains the
current peer id.

For direct HTTP scene writes, choose one contract and state it explicitly. The
current red test specifies that a successful `POST` containing `elements`
supersedes the current Yjs document. If compatibility is retained, update or
invalidate the in-memory document and `ydoc:<roomId>` in the same RoomDO turn;
updating only the SQL projection is split-brain. If the intended contract is
instead to retire existing-room `elements` writes, change the API and its tests
deliberately rather than silently accepting a write that will never win.

#### 2. Make deletion delete the actual board

This is the highest-priority missing lifecycle rule. `handleRoomDelete` and the
idle-room purge remove SQL rows and add a tombstone, but neither removes
`ydoc:<roomId>`, the cached `Y.Doc`, or its dirty marker. Owner erasure calls the
same incomplete path. The board can therefore remain stored after a successful
deletion and can be written back by a later close or alarm.

Add a Worker test that writes a non-empty board through the socket, deletes the
room, and proves all of the following:

- the SQL room-scoped rows are gone
- `ctx.storage.get('ydoc:<roomId>')` is absent
- the cached document and dirty marker cannot recreate the snapshot on close
  or alarm
- the same cleanup happens for owner erasure and idle TTL purge

Keep the room tombstone; remove only the room's board state, not the whole
Durable Object database, because tombstones and alarms share that storage.

#### 3. Fix the promised persistence bound

`flushIfDue()` is a throttle triggered by a later incoming frame, not an idle
debounce. After one flush, a final edit inside the next three seconds can remain
dirty until the 30s revocation alarm or socket close. Either schedule the one DO
alarm for the earlier of the dirty-flush deadline and revocation deadline, or
document and accept the larger loss window. Add a fake-time/Worker test for
"edit once, remain connected and otherwise idle"; continuous drawing alone
does not cover this case.

Also track SQL projection failure separately. `flushDirtyDocs()` clears the
dirty marker immediately after the Yjs `put`; if the following SQL `UPDATE`
fails, the HTTP read path can remain stale forever despite the comment calling
it a convenience. The Yjs snapshot should remain the authority, but the SQL
projection needs a retry bit or a read path that can obtain the authoritative
document.

#### 4. Correct the snapshot-limit work before integrating it

The current untracked `snapshotBudget.ts` assumes the 128 KiB limit of legacy
KV-backed Durable Objects. This repository declares `RoomDO` in
`new_sqlite_classes` and uses `ctx.storage.sql`; Cloudflare's current
[SQLite-backed Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
allow a key and value combined up to 2 MB. Do not ship the 128 KiB constants or
start chunking based on them.

Still add observability: measure the encoded update's `byteLength`, log or emit
a metric before the verified SQLite-backed limit, and log failed writes with
room-safe metadata. The present blanket `catch` silently retries forever, so an
oversized or otherwise unwritable board looks durable while only browsers hold
it. Test the warning and failure paths against the correct backend limit.

#### 5. Separate sync-read permission from sync-write permission

`webSocketMessage` currently applies `canWriteBoard(role)` before parsing a
binary frame. That correctly blocks viewer updates, but it also blocks a
viewer's sync-step-1 read from receiving the server baseline. Meanwhile viewers
can receive later binary broadcasts from an editor. Parse the y-protocol subtype
first: allow a granted viewer to request server state, but never apply or relay
its step-2/update frames. Start with both positive and negative Worker tests,
then mutation-test the role check.

#### 6. Retire only workarounds proven unnecessary

After the fixes above, add a browser E2E that opens from the server-held
document when the room API does not supply a board, plus an assertion that
drawing sends no element-bearing HTTP `POST`. Then temporarily disable the 3s
resync interval and run the late-join, reload, disconnect/reconnect, and
multi-peer specs. Remove it only if those flows remain green; otherwise keep it
as a recovery mechanism and rewrite its now-stale comment.

Cursor state is ephemeral but currently lives inside the same persisted Yjs
document as elements. The immediate sweep is the right small fix. As a later,
separate optimization, measure snapshot growth from cursor churn and consider
moving cursors to y-websocket awareness rather than pre-emptively redesigning
the protocol.

Finally, clean stale comments in `ExcalidrawWrapper.tsx` that still describe a
debounced HTTP whole-board persist. They now obscure which path is authoritative
and make future reviews harder.

### Verification gate for the main model

Use strict red → green → refactor for one item at a time, with real workerd and
no mocks. For any changed authorization or request-boundary guard, kill one
targeted mutant and restore it. Before calling a slice done, run `npm test`,
`npm run test:workers`, `npm run typecheck`, and `npm run test:e2e`; record the
specific mutant and test that killed it. Do not commit the user's unrelated
dirty files or the current red tests as a half-finished checkpoint.

## Tasks for the implementer (2026-08-22)

Written by the model that shipped `befdfc5` and `2bb52c5`, in answer to the
review above. Its findings are accepted except where a task says otherwise, and
two of them were checked against the repo and the current Cloudflare docs before
being written down here.

### State of the tree when this was written

`HEAD` is `2bb52c5`. Uncommitted, and deliberately left for you:

- `src/do/roomDO.workers.test.ts` — two **red** tests inside
  `describe('server-side y-websocket sync')`: `sweeps a departed peer cursor and
  tells the peers still connected`, and `re-seeds from the row when a board is
  written straight to it`. They fail for the right reasons. Finish their cycles;
  do not weaken them.
- `src/lib/whiteboard/presence.ts` — a new `activePeerIds(db, roomId)` helper,
  using the roster's own 10s window, added for the sweep. Nothing calls it yet.
- `src/lib/whiteboard/snapshotBudget.ts` and its test — **built on the wrong
  limit**. See task 4.

Also untracked and **not yours**: `.playwright-mcp/`, `gemini_improvements.md`.
Leave them alone and never stage them.

### Ground rules

Red → green → refactor, one item at a time, real workerd, no mocks. Run
`npm test`, `npm run test:workers`, `npm run typecheck` and `npm run lint` for
every task, and `npm run test:e2e` for anything reachable from a browser, an
HTTP route or a socket. `npm run test:workers` needs `npm run build` first,
because it serves from `./out`.

Do not commit red tests. Do not commit the untracked files above.

---

### Task 1 — deletion must delete the board (do this first)

**Why.** `deleteRoomScopedData` (`src/lib/whiteboard/roomSchema.ts:203`) deletes
SQL rows only. Nothing removes `ydoc:<roomId>` from DO storage, the cached
`Y.Doc` in `RoomDO.docs`, or its entry in `RoomDO.dirtyRooms` — so a deleted
board is still stored, and a later `webSocketClose` or `alarm` flush can write it
back out. Owner erasure and the idle-TTL purge go through the same incomplete
path. That is a data-protection defect, not a tidiness one.

**What.** Every path that drops a room's data must drop its board state too:
`handleRoomDelete`, `handleRoomAccountErasure`, and
`purgeExpiredRoomsAndTombstones`. The board state is three things and all three
go together: the stored `ydoc:<roomId>` value, `docs.delete(roomId)`, and
`dirtyRooms.delete(roomId)`.

The SQL helpers are pure functions over a `RoomDatabase` with no access to
`ctx.storage` or the in-memory maps, so the cleanup belongs on `RoomDO`: a
private method the routes call after a successful delete, and a call from
`alarm()` for the rooms the purge tombstoned. Have the purge report which room
ids it tombstoned rather than guessing at them.

**Keep the tombstone.** Never `storage.deleteAll()` — tombstones, alarms and the
whole SQL database share that storage.

**Tests** (workers). Write a non-empty board through a socket, then for each of
delete, owner erasure and idle purge prove: the SQL room rows are gone,
`ctx.storage.get('ydoc:<roomId>')` is `undefined`, and a subsequent
`webSocketClose` or `runDurableObjectAlarm` does not bring it back. That last
assertion is the one that catches the cached-document half.

---

### Task 2 — finish the two red tests

**Ghost cursors.** On `webSocketClose`, delete from the room document's `cursors`
map every entry whose peer id is not in `activePeerIds(db, roomId)`, in one
`doc.transact(..., 'sweep')`, then send the resulting update to the remaining
sockets as a sync frame (`writeVarUint(MESSAGE_SYNC)` +
`syncProtocol.writeUpdate`). Capture that update with a temporary
`doc.on('update')` listener around the transaction; the ordinary dirty path then
persists it.

Do **not** read the peer id off the closing socket's attachment — the attachment
carries the account, and a peer id can change at an admission boundary. Presence
rows are the only source of truth for which peers a room still claims. One
account may hold several sockets; the presence window already accounts for that,
so sweep by presence, never by socket count.

**Direct HTTP scene writes.** The contract, chosen deliberately: **a successful
`POST` carrying `elements` supersedes the server document.** Refusing element
writes on an existing room is the alternative, and it is not being taken because
the pre-existing-board seed path depends on rooms whose elements arrived exactly
that way. So in the same `RoomDO` turn as a successful scene POST that carried
`elements`, invalidate `docs`, `dirtyRooms` and the stored `ydoc:<roomId>`, so
the next open re-seeds from the row. Updating only SQL is split-brain.

`request.clone()` before handing the request to `handleRoomPost` if you need to
inspect the body — the handler consumes it. A viewport-only POST, which the host
now sends on every pan, must **not** invalidate anything.

---

### Task 3 — make the durability bound real

**Why.** `flushIfDue()` is a throttle on incoming frames, not an idle debounce.
One edit followed by silence stays dirty until the 30s alarm or the socket
closes. The commit message for `befdfc5` calls it an "on idle" beat; that is
overstated, and the review is right about it.

**What.** When a room becomes dirty, ensure the object's single alarm is set no
later than `lastFlushAt + FLUSH_INTERVAL_MS`, taking the earlier of that and any
pending revocation alarm.

**The trap.** `alarm()` also runs the revocation check, which fetches the
identity object. Firing the alarm every 3s while someone draws would turn a 30s
identity check into a 3s one, per room. Decouple them: record when the identity
check last ran and skip it inside `alarm()` while the interval has not elapsed,
so the alarm may fire as often as durability needs while the identity fetch keeps
its own cadence. `REVOCATION_CHECK_INTERVAL_MS` is a documented security bound —
it may run *more* often, never less — and the revocation tests in
`src/do/roomDO.workers.test.ts` must stay green.

**Also.** `flushDirtyDocs` clears the dirty bit after the Yjs `put` and then
updates the SQL row in a separate `try`. A failed row update is currently
forgotten, so the HTTP read path can stay stale forever behind a comment calling
it a convenience. Give the projection its own retry set, drained on the next
flush.

**Tests** (workers). "Edit once, stay connected, then go idle": the snapshot must
appear within the flush interval, with no further frame and without waiting out
the revocation interval. Plus one proving the identity check does not run on
every early alarm.

---

### Task 4 — rebuild the snapshot budget on the right limit

`snapshotBudget.ts` in the tree is built on 128 KiB. That is the **legacy
KV-backed** Durable Object limit. `wrangler.toml:71` puts `RoomDO` in
`new_sqlite_classes`, and SQLite-backed objects cap **key and value combined at
2 MB**, with 10 GB per object
(https://developers.cloudflare.com/durable-objects/platform/limits/). Fix the
constants, keep the module and its unit tests, and do not build chunking: a
measured board is ~44 KB against a 2 MB ceiling.

Keep the observability, which is the part that matters. Log the encoded
`byteLength` when a snapshot approaches the real limit, and log a failed write
with room-safe metadata. The blanket `catch` in `flushDirtyDocs` retries forever
in silence today, so an unwritable board looks durable while only browsers hold
it. Follow the existing structured-log shape (`{"event": ...}`, see
`src/lib/security/authEvents.ts`) and put no board content in the line.

---

### Task 5 — a viewer may read the board, never write it

**Why.** `webSocketMessage` applies `canWriteBoard(role)` before the frame is
parsed, so a granted viewer's sync step 1 is dropped and it never receives the
server baseline. A viewer sees a board only if an editor happens to broadcast
while it is watching.

**What.** Parse the y-protocol subtype first. A granted viewer's **step 1** is
answered from the server document. A viewer's **step 2 / update** is neither
applied nor relayed, exactly as today. Editors are unchanged. `handleSyncFrame`
(`src/lib/whiteboard/serverSync.ts`) wants a read-only mode, not a second copy of
the protocol handling.

This is an authorization boundary. Per `AGENTS.md` the negative test comes first:
a viewer's update must reach neither the document nor another socket. Then
mutation-test the guard — break it, watch a test fail, restore it — and report
which mutant and which test.

---

### Task 6 — retire the resync interval only if the flows survive without it

`RESYNC_INTERVAL_MS` in `src/lib/whiteboard/yWebsocketProvider.ts` is still 3s,
and the comment above it still says the Worker holds no server-side document,
which is no longer true.

The "what gets deleted" list above says to remove it, and that reasoning is
incomplete: `decideSignalingAction` **sheds frames** under load (`e67db67`), so
resync is also the only repair for a dropped update short of a reconnect.
Deleting it removes a recovery path the server document does not replace.

So: disable it, run the late-join, reload, disconnect/reconnect and multi-peer
e2e specs, and remove it only if they stay green. If they do not — or if you
cannot show that a shed frame recovers without it — keep it, raise the interval
now that a real authority can answer a baseline, and rewrite the comment to say
what it is actually for. Report which of the two you did, and on what evidence.

While in there, fix the stale comments in
`src/components/whiteboard/ExcalidrawWrapper.tsx` that still describe a debounced
HTTP whole-board persist. No client uploads a board any more.

---

### Task 7 — leave the record straight

Rewrite the top of this document so it describes what the system does rather than
what it was going to do, keeping the "why" and the symptom table as history.
Record what shipped, what was deliberately not done, and the two corrections: the
storage ceiling is 2 MB and not 128 KiB, and the resync interval is a shed-frame
repair and not only a baseline workaround.

### Out of scope for these tasks

The review's latency section — p95 targets, publish-to-render instrumentation,
bidirectional drawing e2e — is a separate workstream, not a corrective slice.
Worth doing; not in this list. Note that the structural demand it makes is
already met: the relay to peers runs before any document or storage work, so
nothing in the drawing path waits on persistence.

Moving cursors out of the persisted document and onto y-websocket awareness is
deferred on purpose too. Task 2's sweep is the small fix; measure snapshot growth
from cursor churn before redesigning the protocol.
