# Storage optimisations — board persistence review

Date: 2026-09-14. Baseline: `dd4a2a3`. Revised the same day after a second
review against `2733319`: the S1 safety argument was corrected, S2's cost was
restated, findings S5–S7 were added, and a history simulation (below and
Appendix A) replaced the estimates the first draft relied on. S7 (V2 snapshot
encoding) is now written out for implementation.

Scope: how the room's board state is written, retained, and read back — the
Durable Object's Yjs snapshot pipeline, the SQL projection, and the client
caches beside them. Checked against the current checkout; no production
storage was inspected. The S2 byte figures are arithmetic estimates; the
simulation figures are from a local Node run, not from Workers or real rooms.
Companion reading: `SERVER_SIDE_BOARD_PLAN.md` (load-bearing for RoomDO),
`SYNC_STORAGE_REVIEW.md` (the earlier evidence appendix for the same pipeline),
`PROJECT_IMPROVEMENT_TASKS.md` (the live queue — STORE-01a and SYNC-05-measure
overlap parts of this review, and SYNC-01's generation work overlaps the S1
guard), `SECURITY_BACKUP_RESTORE.md` (PITR is the backup for this storage), and
`security.md` for the shared-type staging this review builds on.

Each fix is a separate red/green slice under the `AGENTS.md` rules; do not
take this file as authorization to build them all at once.

**Implementation status (2026-09-14, unpushed on `main`):**

- **S7a done** — `cfe4a2d`. Format key, dispatching reader, fail-closed
  `format_unknown` / `decode_failed`, explicit V1 writer, delete-path cleanup,
  and the S2 `storage.list` skip. Verifier: APPROVE.
- **S5 done** — `29eb67c`, `3bc8b24`. Owner touch on first flush, then at most
  once per 60 s, forced on last-socket-close, including a room that went clean
  with a throttled touch still owed.
- **S6 part 1 done** — `7a06d26`. The legacy `ydoc:` key is deleted only after
  the room actually loaded from it.
- **S6 part 2 reverted** — `7b4c8bd`, reverted by `b3ec09e`. The success path
  skipped the projection marker on the assumption that the KV snapshot and
  the SQL row commit as one implicit transaction. The verifier rejected that
  against Cloudflare's docs ("using await will disable automatic write
  coalescing"; each SQL method is its own transaction), and no test could
  observe it. Revisit only with the two writes made atomic explicitly
  (`transactionSync`) and a restart test that can see the difference.
- **S7b done** — the writer always produces V2 and records format `2` in the
  same atomic put. One deliberate departure from the design below: the
  `SNAPSHOT_WRITE_FORMAT` toggle and its test override were **removed rather
  than flipped** — there is no format switch, V2 is the only written format,
  and the dispatching reader keeps every pre-V2 room loading until its next
  flush. The phase-2 round-trip and size reds are pinned in
  `roomRehydrate.workers.test.ts`; `storedBoard` in the sync tests now reads
  through `applyStoredSnapshot`. The rollback floor (never below S7a) is in
  `DEPLOY.md`, and `SERVER_SIDE_BOARD_PLAN.md`'s storage table names the
  chunked keys plus the format key.
- **S1 not started** — gated on the real-room measurement (execution note 5). Like `SYNC_STORAGE_REVIEW.md`, this is an evidence appendix: assignment
and status live in `PROJECT_IMPROVEMENT_TASKS.md`.

## Summary

| Id | What | Value | Risk | Recommendation |
|---|---|---|---|---|
| S7 | Store the snapshot in Yjs V2 encoding | 4.5–9× smaller at rest, 1.5–2× faster flush encode | Low (rollback ordering) | **Build first**, two phases |
| S5 | Throttle the per-flush IdentityDO call | Removes ~600 cross-object calls per room-lesson | Low | Build |
| S6 | Drop no-op bookkeeping writes per flush | A few rows per flush | Low (recovery path) | Build |
| S1 | Compact history at the empty-room boundary | 7–20× faster room open, smaller sync to joiners | **High without the stale-peer guard** | Confirm on real rooms, then guard + compaction |
| S2 | Full-snapshot rewrite every 3 s | CPU, not bill | — | Mitigated by S7/S1; `storage.list` skip is a micro |
| S3 | SQL projection | Bounded by live board | — | No action |
| S4 | Client caches | Bounded | — | No action |

## How storage works today (the path the numbers below sit on)

While a board is being drawn on, `RoomDO.flushIfDue` writes at most once every
`FLUSH_INTERVAL_MS = 3_000` (src/do/RoomDO.ts). Each flush calls
`writeSnapshot`, which encodes the **entire** document with
`Y.encodeStateAsUpdate` and rewrites every chunk (`SNAPSHOT_CHUNK_BYTES =
1_000_000`, src/lib/whiteboard/snapshotChunks.ts:24), then
`deleteSnapshotChunks` runs a `storage.list` to remove trailing chunks and the
legacy single-key snapshot is deleted. The flush also puts and later deletes a
`ydoc-projection:` retry marker, updates `rooms.updated_at`, and calls
IdentityDO to move the owner's "last used" stamp. The SQL projection rewrites
the `elements` row with the live board's full JSON in the same beat. When no
socket is open for the room, the flush first runs `pruneTombstonedElements`
(src/lib/whiteboard/yjsDoc.ts:240), which CRDT-deletes elements marked
`isDeleted`. On room open, `getRoomDoc` applies the whole snapshot, seeds from
the row when the snapshot is empty, and the first sync step 2 ships the whole
document to every connecting peer.

Clients write through `replaceSharedElements` (src/lib/whiteboard/yjsDoc.ts),
which sets only the keys whose values changed. While the pointer is down,
`ExcalidrawWrapper` publishes at ~50 ms intervals (widened by `strokeCadence`
for long strokes), and each publish of a stroke rewrites `points`, `width`,
`height`, `version`, `versionNonce` and `updated`. Every overwritten value
leaves a deleted item in the document. Adjacent same-client deletions only
merge when they are consecutive in one key's list, and interleaving keys
prevents that, so the records accumulate roughly one per overwrite.

## Simulation evidence

Method (Appendix A has the script): the project's installed `yjs`, two peers
syncing through `applyUpdate`, elements as `Y.Map`s in the `elements` array,
changed-keys-only writes as `replaceSharedElements` does, stroke publishes at
50 ms, and random bytes standing in for encoded points. "Compacted" is the live
elements copied into a fresh document, which is what `buildCleanDoc` produces.
Timings are the mean of 5 runs in Node on a development machine; a rerun varied by up to ~20% (V2 encode on board A: 38–46 ms), while byte counts are deterministic.

| Board | Live elements | Snapshot now (V1) | V1 gzip | **V2** | Compacted V1 | Compacted V2 | Row JSON | History ratio |
|---|---|---|---|---|---|---|---|---|
| A: 1,500 freedraw strokes (0.5–2.5 s each) | 1,500 | 3,750 KB | 951 KB | **820 KB** | 1,152 KB | 749 KB | 1,562 KB | 3.3× |
| B: 400 shapes, 3,000 drags (10 publishes each) | 400 | 1,670 KB | 296 KB | **181 KB** | 224 KB | 126 KB | 164 KB | 7.5× |
| B then 30% erased + prune | 295 | 1,296 KB | 223 KB | **137 KB** | 165 KB | 93 KB | 121 KB | 7.8× |

| Board | Encode V1 | Encode V2 | Load V1 | Load V2 | Load compacted V1 |
|---|---|---|---|---|---|
| A | 67 ms | 38 ms | 288 ms | 281 ms | 40 ms |
| B | 35 ms | 18 ms | 143 ms | 135 ms | 9 ms |
| B erased | 28 ms | 14 ms | 131 ms | 134 ms | 7 ms |

What it shows:

- **History is real under ordinary traffic**, 3–8× the live board. The first
  revision of this file guessed ordinary edits were cheap; that guess was
  wrong.
- **V2 encoding of the full-history document is smaller than a compacted V1
  document**, with no change to document content, and encodes 1.5–2× as
  fast. It does not make loading faster: decoding produces the same in-memory
  document.
- **Only compaction speeds up room open** (7–20×) and shrinks the V1 sync step
  2 every joiner downloads.
- Erasing and pruning barely shrinks the snapshot: the deletes add records of
  their own.

Caveats: random point bytes do not compress, so real freedraw boards should do
somewhat better under V2; Workers timings will differ from Node; two peers and
this edit mix are an assumption. Confirm with real rooms before sizing S1 (see
S1), and record V1 and V2 bytes from the S7 phase-2 logs.

## Finding S7 — store the snapshot in Yjs V2 encoding (implementation-ready)

### What V1 and V2 are

Both are Yjs's binary formats for serialising a document; they carry identical
information and decode to an identical document. **V1**
(`Y.encodeStateAsUpdate` / `Y.applyUpdate`) writes each struct as a row: client
id, clock, origin, parent key, content — repeating the client id and key names
(`"x"`, `"version"`) on every record. **V2** (`Y.encodeStateAsUpdateV2` /
`Y.applyUpdateV2`) writes the same structs column by column (all client ids,
then all clocks, then all keys…) and run-length/delta-encodes each column, so
thousands of near-identical history records collapse. The formats are not
interchangeable: V1 bytes fed to `applyUpdateV2`, or V2 bytes fed to
`applyUpdate`, throw or corrupt. y-protocols sync (`serverSync.ts`, the client
provider) speaks V1 and is **not** changed by this finding.

### Observed

`flushDirtyDocs` encodes with `Y.encodeStateAsUpdate` (src/do/RoomDO.ts:1816)
and `getRoomDoc` decodes with `Y.applyUpdate` (src/do/RoomDO.ts:1418). Nothing
records which format a stored snapshot is in. The simulation above measures
V2 at 4.5–9× smaller and 1.5–2× faster to encode on history-heavy boards.

### Impact

Smaller snapshots mean fewer chunk rows per flush (a 3.7 MB V1 board is four
chunks; its 820 KB V2 encoding is one), less flush-time CPU on the object's
thread, and more headroom under the DO storage cap. No stale-peer hazard: the
document's items, client ids and clocks are unchanged.

### Design

**Format marker — a separate key.** Add `snapshotFormatKey(roomId)` →
`ydoc-format:<roomId>` in `src/lib/whiteboard/snapshotChunks.ts`, holding `1`
or `2`. Absent means V1 (every existing room). Do **not** encode the format in
the chunk-count value: current code treats a non-number there as "no
snapshot", which would silently seed from a possibly stale row and overwrite
the snapshot on the next flush. Do not prefix a byte onto chunk 0 either: that
makes the joined bytes something older builds apply as a corrupt update.

**Writer.** `writeSnapshot` puts `ydoc-format`, `ydoc-meta` and the chunks in
the **same** `storage.put(entries)` call (a multi-key put is atomic), and
always writes the format value explicitly. The original design kept a
`SNAPSHOT_WRITE_FORMAT` constant with a test override so phase 1 could write
`1` first; as implemented, the toggle was removed and the writer produces
**V2 only** (`SNAPSHOT_STORED_FORMAT = 2`). The atomic explicit write keeps
the property that matters: whatever a build writes, it names, so the reader
never guesses.

**Reader.** `readSnapshot` returns `{ bytes, format }`. A pure helper
`applyStoredSnapshot(doc, bytes, format)` (in `snapshotChunks.ts` or a new
`snapshotFormat.ts`, unit-tested) dispatches: missing or `1` →
`Y.applyUpdate`; `2` → `Y.applyUpdateV2`. The legacy `ydoc:<roomId>` key is
always V1.

**Unknown format or undecodable bytes — fail closed, do not overwrite.** A
format value this build does not know (for example a future format after a
rollback), or a decode that throws, must not fall through to the row-seed path
the way a missing chunk does today: the next flush would then overwrite a
snapshot this build simply cannot read. Log
`logBoardSnapshot({ outcome: 'format_unknown' | 'decode_failed' })` and make
`getRoomDoc` refuse to cache a writable document for that room (throw, so the
socket/HTTP path returns its existing internal-error response). This is a
deliberate difference from `chunks_missing`, whose bytes are already known to
be unrecoverable. If the owner prefers the room to open from the row instead,
that must still never flush over the unread snapshot — decide before phase 1.

**Unchanged on purpose.**
- Sync step 1/2, `stageSyncUpdate`, and the incremental broadcast at
  src/do/RoomDO.ts:2675 stay V1.
- `computeRoomStats().snapshotBytes` stays V1: it is the wire size a joiner
  receives and the history signal S1 reads. Add a separate
  `storedSnapshotBytes` if the stats route should show the stored size.
- `snapshotBudgetState` keeps measuring the bytes actually written (now V2);
  add `format` to its log line so the numbers remain interpretable.

**Also update.** `deleteBoardState` must delete `ydoc-format:<roomId>` with the
other keys (src/do/RoomDO.ts:1657-1664). `SERVER_SIDE_BOARD_PLAN.md`'s storage
table still names the pre-chunking `ydoc:<roomId>` key; update it to chunks +
meta + format in the phase-2 slice. Worker tests read stored snapshots
directly — `roomDOSync.workers.test.ts` joins chunks itself, and eleven
`src/do/*.workers.test.ts` files call `Y.applyUpdate` or
`Y.encodeStateAsUpdate`. Any of those that decode or plant *stored* bytes must
go through the shared format-aware helper in phase 1, or they will fail (or
silently test V1 only) when phase 2 flips the writer. Wire-frame uses stay V1.

**Migration.** None needed. Every flush rewrites the whole snapshot, so a V1
room becomes V2 the first time it changes after phase 2. Idle rooms stay V1
and keep loading. PITR restores (`SECURITY_BACKUP_RESTORE.md`) restore the
format key together with the chunks it describes, since they share one atomic
put.

### Rollout — as built

1. **Phase 1 (S7a) — done.** Format key, dispatching reader, fail-closed
   handling, delete-path cleanup, explicit V1 writer.
2. **Phase 2 (S7b) — done.** The writer produces V2; the toggle was removed
   rather than flipped (see the status note above), so there is no format
   switch left in the code.

Rollback rule, recorded in `DEPLOY.md`: once phase 2 has run, never roll back
to a build older than phase 1 — such a build would feed V2 bytes to
`Y.applyUpdate`. Any build from S7a onward reads both formats and is safe.

### First reds

Phase 1, in `src/do/roomRehydrate.workers.test.ts` (real object, real
storage):

1. **Opens a V2 room.** Write chunks holding `Y.encodeStateAsUpdateV2` of a
   board plus `ydoc-format = 2` directly into storage; open the room; assert
   `getElementsFromArray` returns exactly that board. Red today.
2. **Unknown format does not overwrite.** Store a snapshot with
   `ydoc-format = 3`; open the room and drive a flush; assert the stored chunks
   and format key are byte-identical afterwards and `format_unknown` was
   logged.
3. **Writer always writes the format.** After any flush, `ydoc-format` exists
   and equals the configured format, including `1`.
4. **Legacy pin.** A V1 room with no format key, and a legacy `ydoc:` room,
   still open unchanged (likely green already; keep as a regression pin).
5. In `src/do/roomDelete.workers.test.ts`: deleting a room removes
   `ydoc-format:<roomId>`.

Phase 2, as built in `src/do/roomRehydrate.workers.test.ts` (the storage
contract lives at the writer, and the helpers there are the honest way to
drive it):

6. **Round trip across eviction.** With the writer at V2, build a
   history-heavy board (forty unflushed rounds of moves over ten elements),
   flush, evict the object, and assert identical elements; assert the stored
   bytes are below the V1 encoding of the same document.
7. **V2-only writer.** A flush records `ydoc-format = 2`, and the stored
   bytes decode under `applyStoredSnapshot` with that format. The designed
   "rollback between phases" red depended on the format toggle; with the
   toggle removed that test is replaced by the rollback floor in `DEPLOY.md`
   (never below S7a), since every S7a-or-later build reads both formats.

Mutation evidence: removing the `2` branch from the reader turns (1) and (6)
red; dropping the format key from the atomic put turns (3) and (7) red;
letting unknown formats fall through to the seed path turns (2) red. For
phase 2 as built: silently reverting the writer to V1 while still recording
format `2` turns (6) and (7) red (measured: four failures in the writer
suite), which is the guard mutation for the V2-only contract.

### Acceptance

- All five phase-1 reds green; full Worker suite and board sync E2E specs run
  (the change is reachable over WebSocket and HTTP).
- Phase 2 production logs show `format: 2` flushes with smaller byte counts and
  no `format_unknown` / `decode_failed` outcomes.

## Finding S1 — history accumulates with no compaction; old rooms load slow

**Observed.** Nothing in the tree ever compacts a room document. Every
overwritten value (a move, a resize, each stroke publish) leaves a deleted item
in the document's item store, and `Y.encodeStateAsUpdate` encodes those records
forever. `pruneTombstonedElements` removes Excalidraw-deleted elements from the
array, but that is itself a CRDT delete and leaves its own records. The code
already names the symptom: "it is a document much larger than its row that
identifies a room carrying history rather than board"
(src/lib/whiteboard/handlers/room.ts:473). The security work in `d60eca1`
measured a 2000-entry hostile frame leaving 47,072 bytes of records after
pruning; the staging path now keeps that flood out. The simulation above shows
ordinary traffic produces the same effect at scale: snapshots 3–8× the live
board, and room-open decode 7–20× slower than for the compacted document.

**Confirm on real rooms before building.** Run the room stats route on several
real long-lived rooms and record `snapshotBytes` against `rowBytes`. The
chunking comment's production room passed 4 MiB; whether that was history or
content is unknown. The simulation's history-free snapshot sits at roughly
0.7–1.4× its row JSON, so use the real ratios to set the trigger below rather
than the placeholder numbers.

**Impact.** Three costs scale with history, not with board size:

- Room open: `getRoomDoc` applies the full snapshot, and sync step 2 ships the
  full V1 document to every peer — load latency and joiner download grow with
  lessons' worth of dead history. S7 does not change either.
- The `document much larger than its row` state is exactly what makes an old
  room slow to open and slow to hand to a late joiner.
- Flush encode cost grows with it (S2), though S7 cuts it by a third to a half.

**Fix sketch — structural compaction at the empty-room boundary.** The
security work already built the tool: `buildCleanDoc` (sceneGuard.ts) rebuilds
a document's surviving state structurally — fresh item store, zero history.
Compaction is: rebuild the current document with it, persist the fresh
snapshot immediately, and drop the room from `this.docs` so the next
`getRoomDoc` loads the compacted snapshot and re-attaches the `update`
listener. Do not swap the cached doc in place: the dirty-tracking listener and
handler closures hold the old instance.

- **Timing (optimisation, not safety).** Run only when the room has had no
  sockets for at least `POLL_GIVE_UP_MS` (5 minutes,
  src/lib/whiteboard/pollBackoff.ts:56), so rebuilds do not run during short
  gaps in a lesson.
- **Only when it pays.** Placeholder: V1 snapshot ≥ 2 MB **and** ≥ 3× the live
  content estimate; replace both with the measured numbers. `computeRoomStats`
  (src/lib/whiteboard/roomStats.ts) already measures document-versus-row bytes;
  the trigger reuses that shape. Measure the V1 size for the trigger even after
  S7, since V1 is what joiners receive.
- **Scheduling.** An empty room's alarm currently re-arms only every
  `RETENTION_CHECK_INTERVAL_MS` (24 hours, src/do/RoomDO.ts:444) once nothing
  is dirty, so last-socket-close must schedule an alarm for the compaction gate
  or compaction waits up to a day. After eviction the doc is not in memory; the
  alarm path loads it through `getRoomDoc`.
- **`buildCleanDoc` was written for staging frames.** It drops the `call` map
  and unknown roots. Confirm with a test that nothing the room document
  legitimately holds is lost when it is applied to the authoritative doc.

**The 5-minute gate does not make compaction safe.** The first draft said a
peer disconnected that long "has already been shown the connection-lost notice
whose only remedy is a reload". The client does not behave that way:

- `WhiteboardProvider` (src/lib/whiteboard/yWebsocketProvider.ts) extends
  y-websocket's `WebsocketProvider`, which keeps its `Y.Doc` and retries the
  socket indefinitely with backoff.
- `useCollaboration.ts:840-842` states the design: "A reconnection is the one
  thing that undoes giving up… a session that comes back does not need the
  reload the notice offers."

So a laptop lid closed for twenty minutes across a compaction reconnects on its
own with the pre-compaction document. It sends sync step 1; the server answers
with step 2 **and its own step 1** (src/lib/whiteboard/serverSync.ts:49-54);
the client replies with a step 2 carrying every item whose client ids the
compacted document no longer has — the entire old history. `stageSyncUpdate`
rebuilds a frame only when the sanitizer changed something, so this frame is
applied as-is. The server document then holds every element twice (the old
items and the compacted copies) plus all the old history. That state is
persisted and broadcast to every peer. It is not a user-healed client edge: it
is durable server-side duplication that also undoes the compaction.
`uniqueElementsById` masks it visually; moderation and update-by-id would hit
duplicates. The existing `pruneTombstonedElements` comment
(src/do/RoomDO.ts:1798-1814) describes the same class of risk for a connected
peer.

**Required guard — detect a stale peer, do not rely on elapsed time.** One of:

- **Retired state vector.** At compaction, store the pre-compaction state
  vector (client id → clock; small) beside the snapshot. When a socket's sync
  step 1 names any retired client id, do not apply that socket's step 2;
  instead send a control message that makes the client discard its `Y.Doc` and
  resync from the server. New client ids from legitimate offline edits after
  compaction are not retired and pass normally.
- **Document generation.** A generation number persisted with the snapshot and
  carried in the handshake, refusing older generations the same way. This is
  the "generation" item already listed under SYNC-01 in
  `PROJECT_IMPROVEMENT_TASKS.md`; coordinate rather than build it twice.

The guard must ship **before or with** compaction, never after. Persist its
state in the same atomic put as the compacted snapshot (the S7 writer is the
place).

**First reds.** In `src/do/roomCompaction.workers.test.ts`:

1. Seed a real document via a socket with heavy update traffic (move one
   element through many positions, delete others), close the socket, age past
   the gate, run the alarm, and assert the persisted snapshot shrank to roughly
   the live size while `getElementsFromArray` still returns exactly the
   surviving elements.
2. Pin the gate: with a socket connected, or inside the 5-minute window,
   compaction must not run.
3. **Stale reconnect:** keep a client document from before compaction, compact,
   reconnect that client and replay its sync handshake; assert the server's
   element count, element ids, and snapshot size are unchanged and the client
   was told to resync. This is the guard's mutation target: neutering the
   retired-vector (or generation) check must turn it red.

**Risks stated plainly.** Without the guard above, compaction can duplicate a
board durably for everyone; with it, the remaining edge is a stale client
losing edits it made while offline across a compaction, which should be
surfaced to that user rather than dropped silently. Rebuild cost is one
structural copy of the live board, on the alarm, in an empty room.

## Finding S2 — full-snapshot rewrite every 3 s while drawing

**Observed.** Each flush re-encodes and rewrites the complete snapshot, plus
one `storage.list` in `deleteSnapshotChunks` even when the chunk count did not
change. A 4 MB board drawn on continuously for a 30-minute lesson is ~600
flushes × 4 MB ≈ **2.4 GB of snapshot bytes rewritten per room-lesson**
(estimate), independent of how much actually changed in each 3-second window.

**This is mostly CPU, not the storage bill.** `RoomDO` is a SQLite-backed
Durable Object (`new_sqlite_classes` in the wrangler migrations), which bills
rows written rather than bytes. A flush of a 4 MB board is on the order of ten
row writes (four chunks, the chunk-count key, the projection marker put and
delete, the legacy-key delete, and the two `rooms` updates) — roughly 6,000
rows for a continuously drawn 30-minute lesson, which is negligible. The costs
that matter:

- **CPU on the object's single thread:** a full encode (35–70 ms V1 in the
  simulation for 1.7–3.7 MB boards) and a full projection `JSON.stringify`
  every 3 seconds, during which socket frames wait.
- **Per-flush work that is not storage at all:** see S5 and S6.

**Fix, in order.**

1. **S7** — cuts encode time by a third to a half and cuts chunk rows; independent of history.
2. **S5 and S6** — independent of board size.
3. **S1** — encode cost is proportional to snapshot size.
4. **Skip the `storage.list` when the chunk count is unchanged**: the flush
   already knows the previous chunk count it wrote; a list is needed only when
   the new count is smaller. Micro — it removes a read, not a write. Do it
   whenever `writeSnapshot` is next touched (S7a is a natural moment).
5. **Delta-log storage** — append per-flush updates and compact on close — is
   **not now**: it changes the recovery path, the chunk format, and every
   restore test, and S7 plus S1 capture most of its benefit. It belongs with
   the large-projection migration parked under STORE-01 in
   `PROJECT_IMPROVEMENT_TASKS.md`. Chunk-level diffing is not a shortcut: Yjs
   groups structs by client, so an append by one client shifts the bytes of
   every later chunk.

Deliberately **not** proposed: lengthening `FLUSH_INTERVAL_MS`. The 3-second
window is the crash-loss bound for a lesson's work; trading it for storage
cost is an owner decision, not an optimisation. Compressing snapshots (gzip
reaches 951 KB on board A) is also not proposed: V2 gets further without
spending CPU on compression.

## Finding S3 — SQL projection is proportional to live board size only

The `elements` row is rewritten with the live board's JSON on each flush and
served whole by `GET /room`. That is bounded by the element cap, not by
history, and the row is also the seed path for a missing snapshot
(src/do/RoomDO.ts `getRoomDoc`). No storage action; recorded so the S1/S2 work
is not misdirected at it. Its per-flush `JSON.stringify` is part of the CPU
cost in S2, and STORE-01a owns its oversized-row behaviour.

## Finding S4 — client-side caches are opt-in and bounded

`usePersistence` writes the debounced full board JSON to `localStorage` only
for rooms that opted in, and `cleanupStaleRooms` expires rooms after 24 hours
(src/lib/whiteboard/persistence.ts). The shape library is stored per room
under its own key, out of the shared document and the room row, by design
(src/lib/whiteboard/handlers/room.ts:466-474). No action.

## Finding S5 — a cross-object call to IdentityDO on every flush

**Observed.** After each successful snapshot write, `flushDirtyDocs` calls
`touchOwnerRoomActivity` (src/do/RoomDO.ts), which reads the owner from
`room_members` and makes a `fetch` to the global IdentityDO to move the
owner's "last used" stamp. While a board is being drawn on, that is one
subrequest plus one IdentityDO write every 3 seconds per active room — about
600 per room-lesson — all funnelled into a single global object. The comment
calls it "bounded by this flush"; that bound is correct but far tighter than
the room list needs, since "last used" is displayed at list granularity.

**Impact.** Latency added to every flush on the room's thread, subrequest
volume, and write load concentrated on the one IdentityDO that every room
shares. This scales with the number of concurrent lessons, not board size.

**Fix.** Throttle per room: touch on the first flush after a room opens, then
at most once per minute (or a similar list-granularity interval), and always on
the last-socket-close flush so the final stamp is accurate. Keep it best-effort
as today. An in-memory `Map<roomId, lastTouchAt>` is enough: after eviction the
next flush touches again, which is the conservative direction.

**First red.** In the RoomDO worker tests: drive several flushes inside one
throttle window and assert IdentityDO received one touch; advance past the
window and assert a second; close the last socket and assert the final touch.
Neutering the throttle must turn the first assertion red.

## Finding S6 — per-flush bookkeeping writes that are usually no-ops

**Observed.** Every flush, regardless of what changed:

- `writeSnapshot` deletes `legacySnapshotKey(roomId)`, a key that is gone after
  a room's first post-chunking flush.
- `flushDirtyDocs` puts `ydoc-projection:<room>` and, a few lines later in the
  same flush, deletes it again once the projection lands.
- `deleteSnapshotChunks` lists the chunk prefix (S2 item 4).

**Impact.** Small in rows, but on the hot path on every flush, and the marker
put/delete pair is two writes to protect a window that closes in the same
call.

**Fix.** Delete the legacy key only when the read path actually loaded from it
(remember that per room at load, clear it after the first successful flush).
Keep the projection marker's crash-recovery purpose, but only write it when a
projection is actually left pending (the projection write failed or was
skipped), rather than put-then-delete on the success path. Both change a
recovery path, so each needs a restart test in
`src/do/roomDOSync.workers.test.ts` / `src/do/roomSqlProjection.workers.test.ts`
proving a crash between snapshot and projection still converges.

## Adjacent, not storage

The largest rendering-asset cost — static assets served with
`max-age=0, must-revalidate` so every room open revalidates ~2 MB of chunks
and fonts — is a CDN-caching fix (a `public/_headers` file), tracked
separately from this review. It compounds with S1: a compacted snapshot makes
room open cheaper, and immutable asset caching makes the shell cheaper.

## Execution notes

Order (serialize: every slice below touches `RoomDO.ts`):

1. **S7a** — format key, dispatching reader, fail-closed handling, explicit
   V1 writer, delete-path cleanup; fold in the S2 `storage.list` skip.
2. **S5** — IdentityDO throttle.
3. **S7b** — flip the writer to V2, only once S7a is the production rollback
   target; add the rollback rule to `DEPLOY.md` and update
   `SERVER_SIDE_BOARD_PLAN.md`'s storage table.
4. **S6** — bookkeeping writes, with restart tests.
5. **Measure** real rooms: `snapshotBytes` vs `rowBytes` from the stats route,
   plus the V1/V2 bytes S7b logs. This decides whether S1 is built and sets
   its thresholds.
6. **S1** — the stale-peer guard first (or together), then compaction on a
   scheduled alarm, with the stale-reconnect test as a required red.

One slice per step, TDD per `AGENTS.md`, mutation evidence for every new guard
(S7's fail-closed format check, S5's throttle, S1's gate and stale-peer guard:
neutering each must turn its test red). S7 and S1 change what is stored and
S1 adds a client resync path — run the full Worker suite and the board sync
E2E specs, not just the new files. Coordinate with STORE-01a and SYNC-01 (same
file; SYNC-01 owns generation work) and do not fan out concurrent
ExcalidrawWrapper or RoomDO slices in one checkout.

## Appendix A — history simulation script

Reproduces the tables above. Save outside the repo (for example as
`history-sim.mjs` in a scratch directory) and run with
`node history-sim.mjs` from the repository root, so `yjs` resolves from this
project's `node_modules`. Deterministic seed; numbers vary slightly by
machine.

```js
import { createRequire } from 'module';
import zlib from 'zlib';
const require = createRequire(`${process.cwd()}/package.json`);
const Y = require('yjs');

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const kb = (b) => `${(b / 1024).toFixed(0)}KB`;
const time = (f) => {
  const t = performance.now();
  for (let i = 0; i < 5; i++) f();
  return `${((performance.now() - t) / 5).toFixed(1)}ms`;
};

// Peers that sync every local transaction to each other, like the relay.
function peers(n) {
  const docs = [...Array(n)].map(() => new Y.Doc());
  docs.forEach((d, i) => d.on('update', (u, origin) => {
    if (origin === 'remote') return;
    docs.forEach((e, j) => { if (j !== i) Y.applyUpdate(e, u, 'remote'); });
  }));
  return docs;
}

// Changed keys only, as replaceSharedElements does.
function setChanged(map, obj) {
  for (const [k, v] of Object.entries(obj)) {
    const cur = map.get(k);
    const same = cur instanceof Uint8Array && v instanceof Uint8Array
      ? cur.length === v.length && cur.every((b, i) => b === v[i])
      : cur === v;
    if (!same) map.set(k, v);
  }
}

function base(id, type) {
  return {
    id, type, x: rnd() * 2000 | 0, y: rnd() * 1500 | 0, width: 100, height: 80,
    angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1,
    opacity: 100, groupIds: '[]', frameId: null, roundness: null,
    seed: rnd() * 1e9 | 0, version: 1, versionNonce: rnd() * 1e9 | 0,
    isDeleted: false, boundElements: null, updated: Date.now(), link: null,
    locked: false,
  };
}

// Stand-in for pointCodec output: random, so incompressible (pessimistic).
const points = (n) => {
  const a = new Uint8Array(2 + n * 2);
  a[0] = 1;
  for (let i = 1; i < a.length; i++) a[i] = rnd() * 255 | 0;
  return a;
};

function report(name, doc) {
  const live = doc.getArray('elements').toArray().filter((m) => m.get('isDeleted') !== true);
  const clean = new Y.Doc();
  clean.getArray('elements').push(live.map((m) => {
    const c = new Y.Map();
    for (const [k, v] of m.entries()) c.set(k, v);
    return c;
  }));
  const v1 = Y.encodeStateAsUpdate(doc);
  const v2 = Y.encodeStateAsUpdateV2(doc);
  const c1 = Y.encodeStateAsUpdate(clean);
  const c2 = Y.encodeStateAsUpdateV2(clean);
  const row = Buffer.byteLength(JSON.stringify(live.map((m) => Object.fromEntries(
    [...m.entries()].map(([k, v]) => [k, v instanceof Uint8Array ? Array.from(v) : v]),
  ))));
  console.log(`${name}: live=${live.length} | V1 ${kb(v1.length)} gz ${kb(zlib.gzipSync(v1).length)}`
    + ` | V2 ${kb(v2.length)} | compacted V1 ${kb(c1.length)} V2 ${kb(c2.length)}`
    + ` | row ${kb(row)} | history ${(v1.length / c1.length).toFixed(1)}x`);
  console.log(`  encode V1 ${time(() => Y.encodeStateAsUpdate(doc))}`
    + ` V2 ${time(() => Y.encodeStateAsUpdateV2(doc))}`
    + ` | load V1 ${time(() => Y.applyUpdate(new Y.Doc(), v1))}`
    + ` V2 ${time(() => Y.applyUpdateV2(new Y.Doc(), v2))}`
    + ` compacted V1 ${time(() => Y.applyUpdate(new Y.Doc(), c1))}`);
}

// A: freedraw lesson, teacher and student, stroke publishes every 50 ms.
{
  const [teacher, student] = peers(2);
  for (let k = 0; k < 1500; k++) {
    const d = k % 3 === 0 ? student : teacher;
    const arr = d.getArray('elements');
    const publishes = 10 + (rnd() * 40 | 0); // 0.5-2.5 s of pointer-down
    let el = { ...base(`fd${k}`, 'freedraw'), points: points(1) };
    const m = new Y.Map();
    d.transact(() => { arr.push([m]); setChanged(m, el); });
    for (let p = 1; p <= publishes; p++) {
      el = { ...el, points: points(p * 3), width: 100 + p, height: 80 + p,
        version: el.version + 1, versionNonce: rnd() * 1e9 | 0, updated: el.updated + 50 };
      d.transact(() => setChanged(m, el));
    }
  }
  report('A freedraw 1500 strokes', teacher);
}

// B: 400 shapes dragged 3000 times (10 publishes per drag), then 30% erased.
{
  const [teacher, student] = peers(2);
  const arr = teacher.getArray('elements');
  for (let k = 0; k < 400; k++) {
    const m = new Y.Map();
    teacher.transact(() => { arr.push([m]); setChanged(m, base(`r${k}`, 'rectangle')); });
  }
  for (let drag = 0; drag < 3000; drag++) {
    const d = drag % 2 ? student : teacher;
    const list = d.getArray('elements');
    const m = list.get(rnd() * list.length | 0);
    for (let p = 0; p < 10; p++) {
      d.transact(() => setChanged(m, { x: m.get('x') + 3, y: m.get('y') + 2,
        version: m.get('version') + 1, versionNonce: rnd() * 1e9 | 0,
        updated: m.get('updated') + 50 }));
    }
  }
  report('B 400 shapes, 3000 drags', teacher);
  teacher.transact(() => {
    for (let i = 0; i < arr.length; i++) {
      if (rnd() < 0.3) setChanged(arr.get(i), { isDeleted: true, version: arr.get(i).get('version') + 1 });
    }
  });
  teacher.transact(() => {
    for (let i = arr.length - 1; i >= 0; i--) if (arr.get(i).get('isDeleted') === true) arr.delete(i, 1);
  });
  report('B after erasing 30% + prune', teacher);
}
```
