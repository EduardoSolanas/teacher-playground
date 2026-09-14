# Storage optimisations — board persistence review

Date: 2026-09-14. Baseline: `dd4a2a3`.

Scope: how the room's board state is written, retained, and read back — the
Durable Object's Yjs snapshot pipeline, the SQL projection, and the client
caches beside them. Measured against the current checkout; no production
storage was inspected. Companion reading: `SERVER_SIDE_BOARD_PLAN.md`
(load-bearing for RoomDO), `PROJECT_IMPROVEMENT_TASKS.md` (the live queue —
STORE-01a and SYNC-05-measure overlap parts of this review), and
`security.md` for the shared-type staging this review builds on.

Nothing below is implemented. Each fix is a separate red/green slice under the
`AGENTS.md` rules; do not take this file as authorization to build them all at
once.

## How storage works today (the path the numbers below sit on)

While a board is being drawn on, `RoomDO.flushIfDue` writes at most once every
`FLUSH_INTERVAL_MS = 3_000` (src/do/RoomDO.ts). Each flush calls
`writeSnapshot`, which encodes the **entire** document with
`Y.encodeStateAsUpdate` and rewrites every chunk (`SNAPSHOT_CHUNK_BYTES =
1_000_000`, src/lib/whiteboard/snapshotChunks.ts:24), then
`deleteSnapshotChunks` runs a `storage.list` to remove trailing chunks. The
SQL projection rewrites the `elements` row with the live board's full JSON in
the same beat. On room open, `getRoomDoc` applies the whole snapshot, seeds
from the row when the snapshot is empty, and the first sync step 2 ships the
whole document to every connecting peer.

## Finding S1 — tombstone growth has no compaction; old rooms load slow

**Observed.** Nothing in the tree ever compacts a room document. Every element
update (a move, a resize, a delete) leaves a tombstone in the document's item
store, and `Y.encodeStateAsUpdate` encodes those tombstones as GC records
forever. The code already names the symptom: "it is a document much larger
than its row that identifies a room carrying history rather than board"
(src/lib/whiteboard/handlers/room.ts:473). Concretely, this review measured a
2000-entry hostile frame leaving **47,072 bytes** of tombstone records behind
even after every byte of content was pruned (the security work in `d60eca1`
measured this to design the staging path).

**Impact.** Three costs scale with history, not with board size:

- Room open: `getRoomDoc` applies the full snapshot, and sync step 2 ships it
  to every peer — load latency grows with lessons' worth of dead history.
- The `document much larger than its row` state is exactly what makes an old
  room slow to open and slow to hand to a late joiner.
- It compounds S2 below: every 3-second flush rewrites the inflated snapshot.

**Fix sketch — structural compaction at the empty-room boundary.** The
security work already built the tool: `buildCleanDoc` (sceneGuard.ts) rebuilds
a document's surviving state structurally — fresh item store, zero tombstones.
Compaction is: rebuild the current document with it, swap the cached doc,
persist the fresh snapshot immediately. What makes it safe is *when* it runs:

- Only when the room has had **no sockets for at least
  `POLL_GIVE_UP_MS` (5 minutes, src/lib/whiteboard/pollBackoff.ts:56)**. A
  peer disconnected that long has already been shown the connection-lost
  notice whose only remedy is a reload, so no live peer can hold element
  identities the compacted doc no longer has. Compacting under a connected
  peer would fork element identity: the peer's array keeps old-client items
  the server no longer has, `uniqueElementsById` masks it visually, but
  moderation and update-by-id could then hit a duplicate. That is the one
  trap; the 5-minute gate is what closes it.
- Only when it pays: snapshot size ≥ 2 MB **and** snapshot ≥ 3× the live
  content estimate. `computeRoomStats` (src/lib/whiteboard/roomStats.ts)
  already measures document-versus-row bytes; the trigger reuses that shape.
  Small rooms never pay a rebuild for nothing, and append-only boards (a
  freedraw lesson barely tombstones anything) stay under the ratio.

**First red.** `src/do/roomCompaction.workers.test.ts`: seed a real document
via a socket with heavy update traffic (move one element through many
positions, delete others), close the socket, age past the gate, run the alarm,
and assert the persisted snapshot shrunk to roughly the live size while
`getElementsFromArray` still returns exactly the surviving elements. A second
test pins the gate: with a socket connected, or inside the 5-minute window,
compaction must not run.

**Risks stated plainly.** A peer that suppressed the reload notice and
reconnects stale gets a duplicate-ridden local array that renders correctly
(dedupe by id) but is degraded until reload; the 5-minute gate plus the
existing give-up notice make this a user-healed edge, not a silent corruption.
Rebuild cost is one structural copy of the live board, on the alarm, in an
empty room.

## Finding S2 — full-snapshot rewrite every 3 s while drawing

**Observed.** Each flush re-encodes and rewrites the complete snapshot, plus
one `storage.list` in `deleteSnapshotChunks` even when the chunk count did not
change. A 4 MB board drawn on continuously for a 30-minute lesson is ~600
flushes × 4 MB ≈ **2.4 GB of durable-object storage writes per room-lesson**,
independent of how much actually changed in each 3-second window.

**Impact.** DO storage is the bill and the latency: write bandwidth scales
with document size × drawing time. For history-heavy rooms this multiplies S1.

**Fix sketch, in order of cheapness.**

1. **Compaction is the first mitigation** (S1): write amplification is
   proportional to snapshot size, so bounding snapshot size bounds the flush
   cost for every history-heavy room. No separate work needed.
2. **Skip the `storage.list` when the chunk count is unchanged**: the flush
   already knows the previous chunk count it wrote; a list is needed only when
   the new count is smaller. Micro, but it removes one storage op per flush.
3. **Delta-log storage** — append per-flush updates and compact on close — is
   the real fix for append-heavy boards and is deliberately **not now**: it
   changes the recovery path, the chunk format, and every restore test. It
   belongs with the large-projection migration already parked under STORE-01
   in `PROJECT_IMPROVEMENT_TASKS.md`, not with this review.

Deliberately **not** proposed: lengthening `FLUSH_INTERVAL_MS`. The 3-second
window is the crash-loss bound for a lesson's work; trading it for storage
cost is an owner decision, not an optimisation.

## Finding S3 — SQL projection is proportional to live board size only

The `elements` row is rewritten with the live board's JSON on each flush and
served whole by `GET /room`. That is bounded by the element cap, not by
history, and the row is also the seed path for a missing snapshot
(src/do/RoomDO.ts `getRoomDoc`). No action; recorded so the S1/S2 work is not
misdirected at it.

## Finding S4 — client-side caches are opt-in and bounded

`usePersistence` writes the debounced full board JSON to `localStorage` only
for rooms that opted in, and `cleanupStaleRooms` expires rooms after 24 hours
(src/lib/whiteboard/persistence.ts). The shape library is stored per room
under its own key, out of the shared document and the room row, by design
(src/lib/whiteboard/handlers/room.ts:466-474). No action.

## Adjacent, not storage

The largest rendering-asset cost — static assets served with
`max-age=0, must-revalidate` so every room open revalidates ~2 MB of chunks
and fonts — is a CDN-caching fix (a `public/_headers` file), tracked
separately from this review. It compounds with S1: a compacted snapshot makes
room open cheaper, and immutable asset caching makes the shell cheaper.

## Execution notes

One slice per finding, TDD per `AGENTS.md`, mutation evidence for any new
guard (the compaction gate is a guard: neutering it must turn the gate test
red). S1 changes what the snapshot contains — run the full Worker suite and
the board sync E2E specs, not just the new file. Coordinate with STORE-01a
(same file, `RoomDO.ts`) and do not fan out concurrent ExcalidrawWrapper or
RoomDO slices in one checkout.
