# Forking Excalidraw: what we would change

`@excalidraw/excalidraw` is embedded as a black box and driven from
`src/components/whiteboard/ExcalidrawWrapper.tsx` (696 lines, most of which
exists to work around what the component does not let us say). This document
lists what a fork would change, what each change deletes on our side, and
whether it is worth the cost of owning a fork at all.

Read the last section first if you want the recommendation.

## The rule for what belongs in a fork

A change belongs in the fork only if **it cannot be expressed through the public
API and its absence costs us code we would otherwise not write**. Anything that
is merely a preference — toolbar contents, theme, which tools are enabled — is
already reachable through `UIOptions` and props and must stay out.

Two things are ours regardless and must never move into a fork: the authority
model (the room object holds the document, see `SERVER_SIDE_BOARD_PLAN.md`) and
everything about identity, roles and presence. A fork that starts absorbing
those becomes a second application.

## Changes, by payoff

### 1. A change feed instead of whole-scene `onChange`

**What hurts.** `onChange` fires for every pointer sample and hands over the
entire scene. We rebuild the delta ourselves on every one of them: an id →
`version` map (`publishedVersionsRef`), a serialize pass, an id list for the
previous publish, and an equality check against the last synced scene
(`ExcalidrawWrapper.tsx:440-470`). Handing that whole scene to React per sample
re-rendered the board subtree mid-stroke and was the drawing lag users reported,
so there is now a second mechanism — deferring the React hop while the pointer
is down — to undo the damage of the first.

**What the fork changes.** Emit changed and deleted element ids alongside the
scene, or in place of it: `onElementsChanged({ changed, deleted, appState })`.
Excalidraw already knows precisely what it touched; we are reconstructing it
from the outside, once per sample, at a cost that grows with board size.

**What it deletes here.** The version-baseline bookkeeping, the per-sample
serialize, and most of the deferral machinery — the React hop stays deferred by
choice rather than by necessity.

**Risk.** Low. Additive to the existing callback, easy to keep behind a prop.

### 2. A remote-apply path that does not fight the local one

**What hurts.** Applying a peer's edit means calling `updateScene`, which then
comes back out through `onChange` as though we had drawn it. We suppress the
echo with `excalidrawElementsEqual`, `adoptVersionBaseline`, a set of
`seenRemoteIds` and a list of unpublished local ids
(`ExcalidrawWrapper.tsx:170-200, 275-300`). Separately, a scene written
synchronously in the API callback is discarded — Excalidraw is still
initialising — so the mount path defers by 100ms and hopes
(`ExcalidrawWrapper.tsx:325-345`).

**What the fork changes.** `updateScene(scene, { origin })`, with the origin
carried into whatever `onChange` reports, plus a settled/ready signal so the
first scene write does not have to be a timing guess. This is the same idea Yjs
already uses for transaction origins, and for the same reason.

**What it deletes here.** The echo-suppression bookkeeping and the mount race.
Both are the kind of code that works until someone adds a case.

**Risk.** Low-moderate. Touches the reconciler's entry point.

### 3. Origin-aware history

**What hurts.** Excalidraw's undo is scene-wide, so in a shared room undo
reaches into other people's work. We do not use it: `scopedUndo.ts` drives a
`Y.UndoManager` filtered to our own origin, with a 300ms capture window chosen
to make one stroke one undo step. That means two history models exist, and the
built-in one has to stay unreachable.

**What the fork changes.** Make history origin-aware — undo only what this
client did — or expose the history stack so an embedder can drive it.

**What it deletes here.** `scopedUndo.ts` and its integration, if the fork's
version is good enough. Possibly nothing, if we prefer Yjs semantics; then the
fork change is just "let us turn the built-in one off cleanly".

**Risk.** Moderate, and the one most likely to be wanted upstream: every
collaborative integrator hits it.

### 4. Collaborator cursors on the canvas

**What hurts.** Excalidraw renders collaborator cursors internally but does not
let us supply them, so `RemoteCursorOverlay` draws DOM nodes above the canvas in
viewport pixels. To position them we publish Excalidraw's own scroll/zoom back
out on every pan (`ExcalidrawWrapper.tsx:560-575`), which is React state
churning on a gesture — the comment there records that this once starved the
receiving peer.

**What the fork changes.** Accept a collaborator list and render the cursors in
the canvas layer, where the coordinates already are.

**What it deletes here.** The overlay component and the pan-driven React state.
Note the stored host view still needs scroll and zoom, so the reporting does not
disappear entirely — it stops being per-frame.

**Risk.** Low. The rendering already exists; only the input is missing.

### 5. A serialization hook for points

**What hurts.** Freehand points are the bulk of a board's bytes, and they travel
and are stored as JSON. `pointCodec.ts` exists to pack them, and every reader
has to know that `points` may arrive as a `Uint8Array`, a JSON string, or a
plain array — a lesson learned when the canvas was handed bytes it could not
draw and peers' strokes silently stopped appearing.

**What the fork changes.** Either a typed-array representation for points, or a
per-element serialization hook so an embedder can encode without the rest of the
system needing to know.

**What it deletes here.** Not the codec — that is ours — but the "four possible
shapes" rule that every reader currently has to obey.

**Risk.** High if it changes the element shape; low if it is only a hook. Prefer
the hook.

### 6. Self-contained asset and locale delivery

**What hurts.** Assets and locales are vendored into `public/` and copied by
`scripts/copy-excalidraw-assets.mjs` in `prebuild`, with
`excalidrawAssetPath.ts` pointing the runtime at them. It works, but the vendored
files are in the repo and drift with every upgrade.

**What the fork changes.** A build that resolves assets from a configurable base
path with no copy step.

**What it deletes here.** The copy script, the path shim, and a large vendored
tree.

**Risk.** Low, but this is packaging, not capability — the least valuable item
here despite being the most visible in a diff.

### 7. A supported test handle

**What hurts.** E2E needs the scene API, so we hang it on
`window.__debugExcalidrawApi` and gate it on a build flag
(`ExcalidrawWrapper.tsx:365-370`). It is a global on a production build,
switched off by an environment variable.

**What the fork changes.** A documented way to obtain the API in a test build.

**Risk.** Trivial, and honestly this one is fine as it is.

## What a fork costs

- **Upstream moves.** We are on `^0.18.1`. Every upgrade becomes a merge, and
  the reconciler and history are exactly where upstream churns.
- **It is a build, not a file.** React plus SCSS plus a worker bundle; the
  package we consume today is the output of that.
- **Nobody else reviews it.** Bugs in a fork are ours, in code we did not write.

Against that: items 1 and 2 are worth real latency and real deletion here, and
items 1–4 are things any collaborative embedder wants — which is the argument
for sending them upstream rather than keeping them.

## Recommendation

**Do not fork wholesale.** Take it in three steps, and stop at whichever one
pays:

1. **Patch, don't fork.** Carry items 1 and 2 as a minimal patch set against the
   pinned version (the repo already uses `overrides` for transitive pins, so a
   patch step is not new infrastructure). Measure the drawing path before and
   after; if the deletions do not show up in the latency numbers, stop here.
2. **Send 1–4 upstream.** They are general, and being carried by upstream is
   worth more than being carried by us. A patch set that survives a review is
   also evidence the change is right.
3. **Fork only if 1 or 2 is rejected and the numbers justified it.** If it comes
   to that, fork at the tag we are pinned to, keep the patch set as the entire
   delta, and never let it grow to include anything from "what belongs in a
   fork" above.

Item 6 (assets) can be done at any time and is independent. Item 7 needs
nothing. Item 5 should wait for evidence from a measured board that the codec's
shape rule is actually costing us bugs rather than just looking untidy.

## Before any of this

The board's authority model landed recently and has open corrective work
(`SERVER_SIDE_BOARD_PLAN.md`, section 5). Latency work on the client is listed
there as a separate workstream and has not been measured yet. Items 1 and 2 are
justified by that measurement — do it first, or this document is a list of
plausible guesses rather than a plan.
