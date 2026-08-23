# The room object holds the board

This started as a plan. Most of it has shipped, so it is now a record of what
the system does, what is deliberately still open, and what the next implementer
should do about it. Read the whole thing before touching `RoomDO`; several of
the odd-looking decisions here are load-bearing and are explained nowhere else.

**Shipped baseline:** `befdfc5`, `2bb52c5`, `4e3c41d`. The corrective tasks
that were open in this handover are now implemented in the main worktree.

---

## 1. Why this exists

`RoomDO` used to be a pipe. It relayed bytes between sockets and held no
document, so the only durable copy of a board lived in a browser. Everything
that was wrong followed from that one fact:

| Symptom | Cause |
| --- | --- |
| Whole-board `POST` per client, debounced 3s | the only durable copy is in a browser |
| Two peers racing to store different views | two writers, no authority |
| `413` on a large board | the whole board travels as one HTTP body |
| Board depends on a tab staying open | nobody writes it down otherwise |
| Late joiner needs another peer connected | no server state to sync from |
| 3s resync interval | no authority to ask for a baseline |

`53a1a66` patched the race and `df6ff5b` shrank the payload. Neither addressed
the cause. The fix was to let the object hold a `Y.Doc` and answer sync itself —
a superset of what it already did, so no client rollout and no coordinated
deploy.

## 2. What the system does now

### Who stores what

| Store | Written by | When | Role |
| --- | --- | --- | --- |
| `Y.Doc` in the object's memory | `RoomDO`, from client sync frames | every binary frame | live truth while the room is awake |
| `ydoc:<roomId>` in DO storage | `RoomDO.flushDirtyDocs` | throttled, see below | **the durable record** |
| `rooms.elements` (SQL row) | `RoomDO.flushDirtyDocs` | same flush | projection, so the HTTP read path is not stale |
| `rooms.viewport` (SQL row) | the host's browser, debounced 1s | on pan/zoom | the view a room reopens at |
| `localStorage` | `usePersistence` | opt-in per room | offline cache, unrelated to durability |

No client uploads a board. `saveState`, `shouldPersistBoard` and their debounce
are gone. `usePersistence.saveState` survives and is **not** the same thing —
it is the opt-in local cache and shares only a name.

### The path a stroke takes

1. A peer draws; its y-websocket provider sends a binary sync frame.
2. `RoomDO.webSocketMessage` (`src/do/RoomDO.ts:1169`) **relays the bytes to the
   other sockets first**, unchanged from before this work.
3. It then applies the frame to the room's `Y.Doc` via `handleSyncFrame`
   (`src/lib/whiteboard/serverSync.ts:23`) and answers the sender.
4. Applying it marks the room dirty and moves the single DO alarm earlier when
   needed, so the final accepted edit has a 3s durability deadline.
5. A flush writes `ydoc:<roomId>`, then projects the elements into the row.

### When a flush runs

- **while drawing** — `flushIfDue`, at most once every `FLUSH_INTERVAL_MS` (3s).
- **on the earliest alarm** — the earlier of the dirty-document deadline and
  the revocation deadline. Early durability alarms skip the identity fetch.
- **on the last socket closing** — `webSocketClose` (`src/do/RoomDO.ts:1341`).

The durable Yjs write and the SQL projection have separate dirty sets. A
successful snapshot followed by a failed SQL update therefore retries the
projection instead of forgetting it. The projection-retry marker is stored
alongside the Yjs snapshot, so the retry also survives Durable Object eviction.

### Reading it back

A joining peer gets the board over sync. On a cold frame `getRoomDoc`
(`src/do/RoomDO.ts:668`) loads the snapshot; if there is none — a room from
before this work — it seeds the document from `rooms.elements`. Rehydration and
seeding deliberately happen before the update listener is installed, so neither
is itself a dirty edit. Seeding happens **on read**, so no migration can miss a
room.

`GET /api/whiteboard/room/:id` still serves from the row, which is why the flush
projects into it.

A viewer may send sync step 1 and receives the authoritative baseline. Its sync
step 2/update is neither applied to the server document nor relayed. Editors and
owners retain the bidirectional handshake.

### File map

| File | What lives there |
| --- | --- |
| `src/do/RoomDO.ts` | documents, flushing, sweeping, sockets, alarm |
| `src/lib/whiteboard/serverSync.ts` | y-protocol handling: `handleSyncFrame`, `encodeUpdateFrame` |
| `src/lib/whiteboard/snapshotBudget.ts` | the storage ceiling and when to say something |
| `src/lib/whiteboard/viewportPersist.ts` | whose view is stored and how often |
| `src/lib/whiteboard/presence.ts` | `activePeerIds`, the roster's 10s window |
| `src/lib/whiteboard/yjsDoc.ts` | the element shape shared by client and server |
| `src/hooks/useCollaboration.ts` | client: no board upload, `storeViewport` only |
| `src/components/whiteboard/ExcalidrawWrapper.tsx` | client: applies the stored view once |
| `src/do/roomDO.workers.test.ts` | `describe('server-side y-websocket sync')` |

## 3. Invariants — things that look wrong and are not

Break one of these and the tests may still pass. They are here because each cost
something to learn.

1. **Relay before document work.** The peer relay in `webSocketMessage` runs
   first and outside the server-document `try`. A bug in the document must cost
   peers nothing, and nothing in the drawing path may wait on storage.
2. **Only a non-empty elements array supersedes the document.** Creating a room
   posts `{elements: [], viewport}` (`src/app/whiteboard/page.tsx:111`).
   Superseding on any array erased a live board the moment anyone re-issued the
   create call — two existing tests caught it. An erase travels over the socket
   like any other edit; it does not arrive as an empty HTTP body.
3. **Presence decides who is present, not the socket.** The socket attachment
   carries an account, and a peer id can change at an admission boundary. Sweep
   by `activePeerIds`, never by attachment or socket count.
4. **Presence outlives a socket by ten seconds.** A peer that drops mid-lesson
   is still "present" when `webSocketClose` runs, which is why the sweep also
   runs on the alarm.
5. **The revocation interval may tighten, never loosen.**
   `REVOCATION_CHECK_INTERVAL_MS` is a documented security bound. Firing the
   alarm more often is safe; checking identity less often is not.
6. **Never `storage.deleteAll()`.** Tombstones, alarms and the whole SQL
   database share that storage.
7. **Seed on read, never from a script.** It is the only reason a pre-existing
   room cannot open empty.
8. **The stored view is the host's.** A student panning to their own corner must
   not decide where the next person to open the room lands.
9. **Periodic resync is loss recovery, not the live path.** The normal frame is
   relayed immediately. The 3s sync step 1 repairs an update deliberately shed
   by signaling rate control; disabling it reproduced permanent divergence.

## 4. Corrections to the earlier record

- **The storage ceiling is 2 MB, not 128 KiB.** `wrangler.toml:71` puts `RoomDO`
  in `new_sqlite_classes`; SQLite-backed objects cap key and value together at
  2 MB with 10 GB per object. 128 KiB is the legacy key-value backend.
  (https://developers.cloudflare.com/durable-objects/platform/limits/)
- **The 3s resync interval is not only a baseline workaround.**
  `decideSignalingAction` **sheds frames** under load (`e67db67`), so resync is
  also the only repair for a dropped update short of a reconnect. The original
  "what gets deleted" list is wrong about this. See sections 5 and 7.
- **`flushIfDue` is a throttle, not an idle debounce.** `befdfc5`'s commit
  message calls it an "on idle" beat. It is not. See sections 2 and 5.
- **The viewport was never persisted before this work**, despite a column that
  looked like it was: nothing wrote it after a pan and nothing applied it to the
  canvas. `2bb52c5` wired both ends.

## 5. Completed corrective tasks

- **Deletion:** room DELETE, owner erasure and idle TTL purge now remove the
  cached document, both retry markers and `ydoc:<roomId>` while preserving the
  tombstone. Worker tests prove a later close/alarm cannot resurrect it.
- **Durability:** the first dirty transition schedules a flush no later than 3s;
  revocation checks retain their own cadence; failed SQL projections retry.
- **Viewers:** read-only sync step 1 is answered, while update/step 2 is rejected
  before document mutation or relay. A real-socket worker test keeps the owner
  socket open and proves it neither receives nor persists a valid viewer update.
- **Loss recovery:** the 3s resync remains. With it disabled, the overload E2E
  left the host permanently empty; restored, the same test passed.

Targeted mutants killed during this pass: omitting durable snapshot deletion,
disabling the read-only subtype/relay gate, disabling periodic resync, and
removing signaling-upgrade revocation scheduling.

## 6. Verification gate

For every task: `npm test`, `npm run test:workers`, `npm run typecheck`,
`npm run lint`, and `npm run test:e2e` for anything reachable from a browser, an
HTTP route or a socket. `npm run test:workers` needs `npm run build` first
because it serves from `./out`.

Prove the test, not just the code: disable the implementation, watch the new
test fail for the right reason, restore it. For an authorization guard, kill a
targeted mutant and say which one. Report real output — a suite that was still
running is not a pass.

Useful while working:

- `npm run test:workers -- src/do/roomDO.workers.test.ts -t "server-side y-websocket sync"`
- `npm run test:e2e -- --grep "Stored room view"`
- `evictDurableObject(stub)` from `cloudflare:test` is a **real** eviction — it
  tears the instance down the way hibernation does and keeps storage. Use it
  rather than inventing a test-only hook; there used to be one and it was worse.

## 7. ChatGPT improvements and suggestions for the main model

The next main-model pass should treat perceived fluidity as a measured latency
problem, not another persistence rewrite. The live relay is already ahead of
document and storage work; keep it there.

Recommended order:

1. Instrument publish-to-render p50/p95 separately for strokes and cursors on
   host→peer and peer→host. Record shedding and resync recovery as separate
   events so a repaired frame is not mistaken for ordinary latency.
2. Add browser assertions for continuous strokes, not only final elements. The
   user-visible target should be a smooth remote stroke while persistence stays
   on the 3s durability cadence.
3. Prioritize protocol control frames under overload. Today one account budget
   covers JSON discovery and Yjs bytes; a burst can shed the recovery handshake
   itself until the window clears. A small reserved lane for sync step 1/2 is a
   better next experiment than raising every rate limit.
4. Measure cursor churn in stored snapshots. If it materially grows snapshots,
   move ephemeral cursors to awareness or a non-persisted channel; do not change
   this protocol without size evidence.
5. Keep `RESYNC_INTERVAL_MS = 3_000` until an alternative loss-recovery test is
   green with resync disabled. A server-held document does not by itself repair
   a frame the server never received.

Do not reintroduce client whole-board uploads. They create two authorities and
make latency, conflict resolution and deletion correctness harder at once.

### Latency baseline (2026-08-23)

The first measurement slice now lives in `tests/e2e/latency.spec.ts`. It uses
two separately authenticated browser contexts, real Excalidraw canvases, the
real y-websocket provider, and the local Worker. Debug-only bounded events
correlate local publish with the other browser's canvas/DOM render; production
builds do not collect them or perform the added scene walks.

The main verifier's focused run measured:

| Path | Samples | p50 | p95 | Gate |
| --- | ---: | ---: | ---: | ---: |
| stroke host -> peer | 4 | 13ms | 16ms | <= 2,000ms |
| stroke peer -> host | 8 | 13ms | 22ms | <= 2,000ms |
| cursor host -> peer | 4 | 3ms | 3ms | <= 1,000ms |
| cursor peer -> host | 4 | 3ms | 4ms | <= 1,000ms |

The overload test records loss recovery separately: a frame proven shed by the
rate limiter reappeared through periodic Yjs resync in 2,921ms, under its
8,000ms test ceiling. That number is not mixed into the ordinary live-path
percentiles.

These are local deterministic E2E baselines, not an Internet SLA. The current
free-plan authority caps a room at two occupants (host plus one student), so
10- and 15-peer browser tiers are not reachable product states. Do not bypass
that authorization rule merely to manufacture a scale result; add those tiers
when a server-verified paid entitlement makes them real.

## 8. Out of scope, on purpose

- **The latency workstream** — p95 targets, publish-to-render instrumentation,
  bidirectional drawing e2e. Worth doing, but it is a workstream, not a
  corrective slice. Its structural demand is already met: the relay runs before
  any document or storage work.
- **Moving cursors onto y-websocket awareness.** Cursors live in the persisted
  document and the sweep is the small fix. Measure snapshot growth from cursor
  churn before redesigning the protocol.
- **Waiting peers still have no socket.** `/signaling` opens on admission, so
  admission latency for the student is untouched. That is a security question
  before it is a performance one.

## 9. Provenance

An implementation review from another model prompted tasks 1–7; it was appended
to this file on 2026-08-22 and is preserved in git history at `764c660~1`. Its
findings were checked rather than taken on faith: the deletion gap and the
SQLite storage limit were confirmed and are folded into sections 4 and 5, its
account of the resync interval was found incomplete, and its latency section was
scoped out above. Tasks 2 and 4 were completed in `4e3c41d`.
