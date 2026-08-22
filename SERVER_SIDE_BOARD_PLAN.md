# The room object holds the board

This started as a plan. Most of it has shipped, so it is now a record of what
the system does, what is deliberately still open, and what the next implementer
should do about it. Read the whole thing before touching `RoomDO`; several of
the odd-looking decisions here are load-bearing and are explained nowhere else.

**Shipped:** `befdfc5`, `2bb52c5`, `4e3c41d`. **Open:** tasks 1, 3, 5, 6 below.

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
2. `RoomDO.webSocketMessage` (`src/do/RoomDO.ts:1079`) **relays the bytes to the
   other sockets first**, unchanged from before this work.
3. It then applies the frame to the room's `Y.Doc` via `handleSyncFrame`
   (`src/lib/whiteboard/serverSync.ts:23`) and answers the sender.
4. Applying it marks the room dirty. Nothing is written yet.
5. A flush writes `ydoc:<roomId>`, then projects the elements into the row.

### When a flush runs

- **while drawing** — `flushIfDue` (`src/do/RoomDO.ts:707`), at most once every
  `FLUSH_INTERVAL_MS` (3s). See task 3: this is a throttle, not an idle debounce.
- **on the alarm** — `alarm()` (`src/do/RoomDO.ts:959`), before its early return.
- **on the last socket closing** — `webSocketClose` (`src/do/RoomDO.ts:1241`).

### Reading it back

A joining peer gets the board over sync. On a cold frame `getRoomDoc`
(`src/do/RoomDO.ts:655`) loads the snapshot; if there is none — a room from
before this work — it seeds the document from `rooms.elements` and marks it
dirty. Seeding happens **on read**, so no migration can miss a room.

`GET /api/whiteboard/room/:id` still serves from the row, which is why the flush
projects into it.

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

## 4. Corrections to the earlier record

- **The storage ceiling is 2 MB, not 128 KiB.** `wrangler.toml:71` puts `RoomDO`
  in `new_sqlite_classes`; SQLite-backed objects cap key and value together at
  2 MB with 10 GB per object. 128 KiB is the legacy key-value backend.
  (https://developers.cloudflare.com/durable-objects/platform/limits/)
- **The 3s resync interval is not only a baseline workaround.**
  `decideSignalingAction` **sheds frames** under load (`e67db67`), so resync is
  also the only repair for a dropped update short of a reconnect. The original
  "what gets deleted" list is wrong about this. See task 6.
- **`flushIfDue` is a throttle, not an idle debounce.** `befdfc5`'s commit
  message calls it an "on idle" beat. It is not. See task 3.
- **The viewport was never persisted before this work**, despite a column that
  looked like it was: nothing wrote it after a pan and nothing applied it to the
  canvas. `2bb52c5` wired both ends.

## 5. Remaining work

Ordered by consequence. Red → green → refactor, one at a time, real workerd, no
mocks. Do not commit red tests. `.playwright-mcp/` and `gemini_improvements.md`
are the user's — never stage them.

### Task 1 — deletion must delete the board (do this first)

**Why.** `deleteRoomScopedData` (`src/lib/whiteboard/roomSchema.ts:203`) deletes
SQL rows only. Nothing removes `ydoc:<roomId>`, the cached `Y.Doc` in
`RoomDO.docs`, or its entry in `RoomDO.dirtyRooms`. A deleted board is still
stored, and a later close or alarm flush can write it back out. Owner erasure
and the idle-TTL purge use the same incomplete path. This is a data-protection
defect — see `SECURITY_DATA_PROTECTION.md`.

**What.** `handleRoomDelete`, `handleRoomAccountErasure` and
`purgeExpiredRoomsAndTombstones` must all drop the board state, and it is three
things that go together: the stored value, `docs.delete(roomId)`,
`dirtyRooms.delete(roomId)`. The SQL helpers are pure functions over a
`RoomDatabase` with no access to `ctx.storage` or those maps, so the cleanup
belongs on `RoomDO` — a private method the routes call after a successful
delete, and a call from `alarm()` for the rooms the purge tombstoned. Have the
purge report which ids it tombstoned rather than guessing.

Keep the tombstone (invariant 6).

**Tests** (workers). Write a non-empty board through a socket, then for each of
delete / owner erasure / idle purge prove: SQL room rows gone,
`ctx.storage.get('ydoc:<roomId>')` is `undefined`, and a following
`webSocketClose` or `runDurableObjectAlarm` does not bring it back. That last
assertion is the one that catches the cached-document half.

### Task 3 — make the durability bound real

**Why.** One edit followed by silence stays dirty until the 30s alarm or socket
close, because `flushIfDue` only runs when another frame arrives.

**What.** When a room becomes dirty, ensure the object's single alarm is set no
later than `lastFlushAt + FLUSH_INTERVAL_MS`, taking the earlier of that and any
pending revocation alarm.

**The trap.** `alarm()` also runs the revocation check, which fetches the
identity object. Firing every 3s while someone draws turns a 30s identity check
into a 3s one, per room. Decouple them: record when the identity check last ran
and skip it inside `alarm()` while its interval has not elapsed. Invariant 5
applies — the existing revocation tests must stay green.

**Also open:** `flushDirtyDocs` clears the dirty bit after the Yjs `put`, then
projects into SQL in a separate `try`. A failed projection is forgotten, so the
read path can stay stale forever. Give it its own retry set, drained next flush.

**Tests** (workers). "Edit once, stay connected, go idle" — the snapshot appears
within the flush interval with no further frame. Plus one proving the identity
check does not run on every early alarm.

### Task 5 — a viewer may read the board, never write it

**Why.** `webSocketMessage` applies `canWriteBoard(role)` before the frame is
parsed, so a granted viewer's sync step 1 is dropped and it never receives the
server baseline. A viewer sees a board only if an editor happens to broadcast
while it is watching.

**What.** Parse the y-protocol subtype first. A viewer's **step 1** is answered
from the server document; its **step 2 / update** is neither applied nor
relayed, as today. Editors unchanged. `handleSyncFrame` wants a read-only mode,
not a second copy of the protocol handling.

This is an authorization boundary. Per `AGENTS.md` the negative test comes
first: a viewer's update reaches neither the document nor another socket. Then
mutation-test the guard — break it, watch a test fail, restore it — and report
which mutant and which test.

### Task 6 — retire the resync interval only if the flows survive without it

`RESYNC_INTERVAL_MS` in `src/lib/whiteboard/yWebsocketProvider.ts` is still 3s
and its comment still says the Worker holds no server-side document, which is
false. But see the correction in section 4: frames are shed under load, so
deleting it removes a recovery path the server document does not replace.

Disable it, run the late-join, reload, disconnect/reconnect and multi-peer e2e
specs, and remove it only if they stay green **and** you can show a shed frame
still recovers. Otherwise keep it, raise the interval now that a real authority
can answer a baseline, and rewrite the comment to say what it is for. Report
which you did and on what evidence.

While in there: `src/components/whiteboard/ExcalidrawWrapper.tsx` still has
comments describing a debounced HTTP whole-board persist. No client uploads a
board any more.

### Then update this document

Move whatever you finish out of section 5 and into sections 2–4, the way tasks 2
and 4 were folded in. A stale record is how the 128 KiB mistake happened.

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

## 7. Out of scope, on purpose

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

## 8. Provenance

An implementation review from another model prompted tasks 1–7; it was appended
to this file on 2026-08-22 and is preserved in git history at `764c660~1`. Its
findings were checked rather than taken on faith: the deletion gap and the
SQLite storage limit were confirmed and are folded into sections 4 and 5, its
account of the resync interval was found incomplete, and its latency section was
scoped out above. Tasks 2 and 4 were completed in `4e3c41d`.
