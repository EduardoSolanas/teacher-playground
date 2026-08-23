# Teacher Playground Excalidraw fork

## Current decision and status

Teacher Playground now owns a **minimal distribution fork**, not a rewritten
drawing editor. The fork is kept in `excalidraw/` in the main checkout and at
<https://github.com/EduardoSolanas/excalidraw>. It is pinned to upstream
Excalidraw `v0.18.1`; our release branch is
`teacher-playground/release-v0.18.1`, and our package identity is
`@teacher-playground/excalidraw`.

Release `teacher-playground-v0.18.1-tp.2` is the first version that uses the
same Cloudflare CI contract as Teacher Playground:

- GitHub environment: `prod`
- secret: `CLOUDFLARE_API_TOKEN`
- variable: `CLOUDFLARE_ACCOUNT_ID`
- R2 bucket: `teacher-playground-excalidraw`

The package, browser bundle, manifest, and checksums are produced by the fork's
own GitHub Actions workflow. The tagged `tp.2` run passed validation and created
the [GitHub Release](https://github.com/EduardoSolanas/excalidraw/releases/tag/teacher-playground-v0.18.1-tp.2).
Teacher Playground now pins that immutable asset in `package.json` and
`package-lock.json`:

```text
https://github.com/EduardoSolanas/excalidraw/releases/download/teacher-playground-v0.18.1-tp.2/package.tgz
```

R2 infrastructure is declared under `excalidraw/infra/cloudflare`. The pipeline
will publish immutable `releases/<version>/...` objects and the mutable
`latest/...` pointer after the fork repository's `prod` environment is given
its own copy of `CLOUDFLARE_API_TOKEN`. GitHub secrets are repository-scoped and
write-only, so matching the secret *name* does not copy its value from the
Teacher Playground repository. The `tp.2` R2 step therefore failed at this
credential check; no Cloudflare upload is claimed. After adding the token, the
fork's manual `recover-r2` workflow can rebuild and upload the existing `tp.2`
tag without recreating its GitHub Release.

The application-side simplification is also complete: remote scenes use the
exported reconciliation API and never enter local history; cursors use native
Excalidraw collaborators and pointer events; view persistence uses
`onScrollChange`; the custom cursor DOM overlay and viewport conversion code
have been removed. Scoped Yjs undo remains intentionally because it provides
local-origin grouping for our shared Yjs document.

`@teacher-playground/excalidraw` is embedded as a black box and driven from
`src/components/whiteboard/ExcalidrawWrapper.tsx`. It was 696 lines when this
analysis began, much of it working around what we believed the component would
not let us say.

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

Everything here is in the upstream base of
`@teacher-playground/excalidraw@0.18.1-tp.2`, verified against
`dist/types/excalidraw/types.d.ts` in `node_modules`.

| Direction | API | Do we use it |
| --- | --- | --- |
| Scene changed | `onChange(elements, appState, files)` | yes — whole scene, per pointer sample |
| Pointer moved | `onPointerUpdate({ pointer: {x, y, tool}, button, pointersMap })` | yes |
| Pointer down / up | `excalidrawAPI.onPointerDown` / `onPointerUp` | yes |
| Pan / zoom | `onScrollChange(scrollX, scrollY, zoom)`, also on the API | yes |
| Someone followed you | `onUserFollow(payload)` | **no** — feature we do not have |
| Push a scene in | `updateScene({ elements, appState, collaborators, captureUpdate })` | yes |
| Merge remote with local | `reconcileElements(local, remote, appState)` (exported) | yes |
| Keep an update out of undo | `CaptureUpdateAction.NEVER` (exported) | yes |

The completed rows are the answer to "how do we get updates from drawing,
cursor, etc.": upstream already publishes them in scene coordinates, with
button state. Follow mode is the only unused callback in this table.

## Completed application simplifications, by payoff

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

**Decision.** Keep `scopedUndo.ts`. `CaptureUpdateAction.NEVER` prevents remote
scene application from entering Excalidraw history, while the Yjs undo manager
still scopes undo to this peer's transaction origin and groups the shared
document updates that make up one stroke. A real two-browser test proves Alice
cannot undo Bob's work.

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

## If the fork is an overhaul

Everything above optimises for the smallest possible delta, which is the right
objective for carrying patches and the wrong one for an overhaul. If the reason
to fork is that we want an editor shaped around a classroom, the question is not
"what can we not reach through the API" — it is "what will we take ownership
of, and what will we never take ownership of".

### What an overhaul buys that the API cannot

Checked against `dist/types/excalidraw/element/types.d.ts`:

- **Per-role editability.** `locked: boolean` is a property of the *element*,
  not of the *viewer*. A worksheet the teacher can edit and a child cannot is
  not expressible: locking it locks it for everyone. This is the single most
  classroom-shaped thing upstream does not have.
- **Authorship as a rule, not a label.** `customData` can carry an author id
  today, so we could mark who drew what without forking — but nothing enforces
  it. "A child may move only their own work" lives in the editor's interaction
  handlers, and there is no hook into them.
- **Refusal.** Upstream assumes the local scene is truth: a mutation happens and
  is then published. There is no "ask before you commit this" seam, so a client
  that misbehaves has already drawn before the server sees it. Server-side
  validation after the fact is possible without a fork, but it can only undo,
  never prevent.
- **A CRDT-native document.** `version` / `versionNonce` / `index` exist because
  upstream reconciles by version. Our document is a Yjs document, so we convert
  between the two models on every frame, and `pointCodec.ts`, the tombstone
  rules and the publish/apply layer all descend from that seam. A fork whose
  scene store *is* the Yjs document deletes the seam rather than smoothing it.
- **Deleting attack surface.** Library sharing, external links, third-party
  image handling, export paths, anything that phones out. `UIOptions` hides
  them; a fork removes them. This repo has a shelf of `SECURITY_*` documents
  that would be shorter if the surface were not there.

### What an overhaul forces us to own

The parts nobody wants: the canvas renderer, text editing and wrapping, arrow
binding and geometry, image and file handling, export, accessibility, and the
long tail of shape-editing bugs. These are the hard, boring, well-tested parts of
Excalidraw and they carry no classroom value — owning them is pure cost, paid
forever, in exchange for the five bullets above.

That is the trade to be explicit about. Not "can we fork" — we can — but
"which half do we want to be responsible for".

### The shape worth forking

**Fork the document and permission layer. Do not fork the editor.**

Take ownership of: the scene store (make it the Yjs document), the interaction
gate (may this pointer move this element, given this role and this author), and
the collaboration surface (cursors, selection, follow). Leave upstream owning:
rendering, text editing, geometry, binding, images, export.

That boundary is worth writing down before a single line is changed, because
every future decision either respects it or turns this into a project that
maintains a drawing editor.

### Sequencing, and the gate

1. **Name the outcomes first**, as things a teacher can do: a worksheet children
   cannot move, each child confined to their own area, "everyone look at my
   screen", "only your own work is yours to erase", freeze the board.
2. **Spike each one against the current API.** Frames exist (`frameId`), locking
   exists, follow exists (`onUserFollow`), authorship can live in `customData`.
   Some of that list will turn out to be reachable — those are not fork
   arguments and must be struck off before the decision.
3. **Fork only on what survives.** If the list is one item, build it above the
   API and accept the awkwardness. If it is per-role editability plus refusal
   plus the CRDT document, the fork is justified and the boundary above is the
   plan.
4. **Decide the maintenance policy on day one.** An overhaul creates a deep
   delta, so plan to stop rebasing: fork at the pinned tag, keep a written log of
   every divergence, and cherry-pick only security and geometry fixes. Pretending
   the fork will track upstream is how forks die half-merged.

### Completed before adopting the package fork

Items 1–5 above were completed before switching the package dependency. They
shrank the wrapper and left the fork free of Teacher Playground collaboration
logic. If a future CRDT-native editor fork is separately approved,
`reconcileElements` would be deleted rather than replaced again.

## Adopted maintenance policy

The minimal fork is justified by ownership of packaging and distribution, not
by duplicating editor internals. Teacher Playground keeps using public
Excalidraw APIs in its wrapper. Fork changes should stay limited to package
identity, release assembly, CI/CD, and a small written divergence log unless a
separately tested classroom requirement cannot be expressed through the public
API.

For every release:

1. Start from the pinned upstream tag and record the upstream commit.
2. Bump `packages/excalidraw/package.json` to `x.y.z-tp.n`.
3. Run the release assembly tests, typecheck, lint/format, and package build.
4. Push the release branch and require its validation workflow to pass.
5. Create the annotated `teacher-playground-v<version>` tag. The tag workflow
   creates the bundle, checksums, GitHub Release, and R2 upload.
6. Consume an immutable version URL in Teacher Playground. Never install from
   `latest/` and never build production from an untagged fork branch.

## Prerequisites completed

The earlier gates are no longer open:

1. `RoomDO` owns the durable Yjs document and SQL projection; cursor/presence
   remains ephemeral.
2. Browser latency probes now exercise publish-to-render behavior. After the
   native cursor migration, the focused local two-browser check measured
   host-to-peer cursor p95 at 365 ms and peer-to-host p95 at 16 ms, both below
   the 1,000 ms test budget. These are local regression measurements, not WAN
   capacity claims.

Follow mode remains a separate classroom product decision. It is not part of
the fork distribution work and was not invented for this release.
