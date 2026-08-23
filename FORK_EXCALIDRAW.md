# Excalidraw: what to change, and what not to fork

`@excalidraw/excalidraw` is embedded as a black box and driven from
`src/components/whiteboard/ExcalidrawWrapper.tsx` (696 lines, most of which
exists to work around what we believed the component would not let us say).

Reading the installed type definitions changed the conclusion of the first
version of this document. **Most of what we hand-rolled is already in the public
API of the version we depend on.** The fork case is much smaller than it looked;
what remains is a list of things to delete.

> **Correction.** The first version of this file claimed Excalidraw "renders
> collaborator cursors internally but does not let us supply them". That is
> wrong: `updateScene({ collaborators })` has been the supported path all along,
> and the type is rich — pointer, button, username, colour, selection, laser
> tool, idle state. The item below replaces that one.

## How updates get in and out

Everything here is in `@excalidraw/excalidraw@0.18.1`, verified against
`dist/types/excalidraw/types.d.ts` in `node_modules`.

| Direction | API | Do we use it |
| --- | --- | --- |
| Scene changed | `onChange(elements, appState, files)` | yes — whole scene, per pointer sample |
| Pointer moved | `onPointerUpdate({ pointer: {x, y, tool}, button, pointersMap })` | **no** |
| Pointer down / up | `excalidrawAPI.onPointerDown` / `onPointerUp` | **no** — we infer it |
| Pan / zoom | `onScrollChange(scrollX, scrollY, zoom)`, also on the API | **no** — we derive it from `onChange` |
| Someone followed you | `onUserFollow(payload)` | **no** — feature we do not have |
| Push a scene in | `updateScene({ elements, appState, collaborators, captureUpdate })` | partly — never with `collaborators` or `captureUpdate` |
| Merge remote with local | `reconcileElements(local, remote, appState)` (exported) | **no** — hand-rolled |
| Keep an update out of undo | `CaptureUpdateAction.NEVER` (exported) | **no** |

The four "no"s in the middle are the answer to "how do we get updates from
drawing, cursor, etc.": upstream already publishes them, in scene coordinates,
with button state. We are reconstructing all of it from the whole-scene callback.

## Fix without forking, by payoff

### 1. Use `reconcileElements` instead of our own merge

**What hurts.** Applying a peer's edit means deciding what to keep: we track
`seenRemoteIds`, `lastPublishedIds`, a per-id `version` map, and a set of
"unpublished local" ids to avoid clobbering a stroke in progress
(`ExcalidrawWrapper.tsx:170-200`). This is a reimplementation of the merge
Excalidraw's own collaborative app uses — and it is exported.

**What to do.** `reconcileElements(localElements, remoteElements, appState)`
returns the merged scene, version-aware, including the ordering rules we do not
implement at all.

**Deletes.** Most of the bookkeeping above, and the class of bug where a local
stroke in flight loses to a remote frame.

### 2. Apply remote scenes with `captureUpdate: CaptureUpdateAction.NEVER`

**What hurts.** Undo is scene-wide, so in a shared room it reaches into other
people's work. We answered that by not using it: `scopedUndo.ts` drives a
`Y.UndoManager` filtered to our own origin, with a 300ms capture window.

**What to do.** `CaptureUpdateAction.NEVER` is documented for exactly this —
"use for updates which should never be recorded, such as remote updates or scene
initialization". Local edits stay `IMMEDIATELY` and remain undoable; remote ones
never enter the local stack.

**Deletes.** Possibly `scopedUndo.ts` entirely. Test it before removing: our
version also groups a stroke into one undo step, and the built-in one must be
shown to do the same.

### 3. Hand cursors to `updateScene({ collaborators })`

**What hurts.** `RemoteCursorOverlay` positions DOM nodes above the canvas in
viewport pixels, so Excalidraw's scroll and zoom must be published back out on
every pan to place them (`ExcalidrawWrapper.tsx:560-575`) — React state churning
on a gesture, which the comment there records once starved the receiving peer.

**What to do.** Build a `Map<SocketId, Collaborator>` from our presence data and
pass it to `updateScene`. The type carries `pointer`, `button`, `username`,
`color`, `selectedElementIds`, `userState` (idle), and the laser tool.

**Deletes.** The overlay component, the pan-driven React state, and the
viewport-to-pixel maths in `cursorViewport.ts` that exists to serve it.

**Bonus.** Selection highlighting and idle state come free; today we have
neither.

### 4. Take cursors from `onPointerUpdate`

**What hurts.** We derive the local pointer ourselves and infer whether the
pointer is down (`isPointerDownRef`) to decide when to defer the React hop.

**What to do.** `onPointerUpdate` gives `{ pointer: { x, y, tool }, button }` in
scene coordinates — the units the shared document wants — and says whether the
button is down. `excalidrawAPI.onPointerDown` / `onPointerUp` are there too.

**Deletes.** Our pointer plumbing and the inference, and it removes a coordinate
conversion rather than adding one.

### 5. Take the viewport from `onScrollChange`

**What hurts.** `publishViewport` runs on every `onChange` and compares five
fields against the last value to decide whether a pan actually happened
(`ExcalidrawWrapper.tsx:540-560`).

**What to do.** `onScrollChange(scrollX, scrollY, zoom)` fires when the viewport
changes and only then. It is the natural feed for the stored host view
(`viewportPersist.ts`).

**Deletes.** The dedupe, and the coupling between drawing and viewport reporting.

### 6. `onUserFollow` — a feature we do not have

Not a cleanup: upstream supports follow-mode, where one participant's viewport
follows another's. In a classroom that is "everyone look at what I am looking
at", which we currently cannot offer at all. Cheap to evaluate now that the
stored host view already exists.

## What genuinely is not in the API

These are the only real fork candidates left.

### A. A change feed instead of whole-scene `onChange`

`onChange` hands over the entire scene on every pointer sample, and no delta or
store-increment API is exported. We rebuild the delta per sample — a serialize
pass and a version map — and had to defer the React hop mid-stroke to undo the
cost, which is where the reported drawing lag came from
(`ExcalidrawWrapper.tsx:440-470`). `reconcileElements` (item 1) fixes the merge
direction, not this one.

Worth raising upstream: every collaborative embedder pays this.

### B. Origin tagging on `onChange`

A scene we push in comes back out through `onChange` as though the user drew it,
so the echo has to be filtered. `captureUpdate` controls *history*, not
*notification*. An origin carried through the callback — the same idea Yjs
transaction origins use — would remove the filtering entirely.

### C. A serialization hook for points

Freehand points are the bulk of a board's bytes; `pointCodec.ts` packs them, and
every reader must know `points` can arrive as a `Uint8Array`, a JSON string, or a
plain array — a rule learned when the canvas was handed bytes it could not draw
and peers' strokes silently stopped appearing. A per-element serialization hook
would contain that; changing the element shape upstream would not be worth it.

### D. Packaging and test handle

Assets and locales are vendored into `public/` and copied by
`scripts/copy-excalidraw-assets.mjs` (which now skips the 13MB CJK font), with
`excalidrawAssetPath.ts` pointing the runtime at them; and E2E reaches the API
through `window.__debugExcalidrawApi` behind a build flag. Both are annoyances,
neither is worth a fork.

## Recommendation

**Do not fork.** Items 1–5 are deletions available today against the pinned
version, and they remove the parts of the wrapper most likely to hide a bug: the
hand-rolled merge, the echo bookkeeping, the overlay, the pointer inference.

Order: **1 and 2 first** (correctness — merge and undo), then **3–5** (deletion
and latency), then evaluate **6** as a product question. Raise **A** and **B**
upstream with the wrapper as the worked example; if both are refused and the
latency numbers justify it, a fork whose entire delta is A and B is defensible.
Nothing else on this page is.

## Before any of this

Two prerequisites, in order:

1. The board's authority model has open corrective work
   (`SERVER_SIDE_BOARD_PLAN.md`, section 5). Do not rewire the client under it.
2. The client latency workstream is unmeasured. Items 3–5 claim to remove React
   churn from the drawing path; without a p50/p95 baseline those are predictions.

Each item is a red/green cycle of its own with the suites in `AGENTS.md`, and
each should delete more than it adds. If one does not, it does not belong here.
