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
