# Teacher Playground Excalidraw fork

## Status

Teacher Playground owns a **minimal distribution fork** of Excalidraw, not a
rewritten drawing editor.

| | |
|---|---|
| Fork | <https://github.com/EduardoSolanas/excalidraw> |
| Working copy | `excalidraw/` in this checkout (see [Open risks](#open-risks)) |
| Release branch | `teacher-playground/release-v0.18.1` |
| Package identity | `@teacher-playground/excalidraw` |
| Current release | `teacher-playground-v0.18.1-tp.7` |
| Upstream base | `v0.18.1` |

The application consumes the immutable release tarball, pinned in
`package.json` and `package-lock.json`:

```text
https://github.com/EduardoSolanas/excalidraw/releases/download/teacher-playground-v0.18.1-tp.7/package.tgz
```

**The fork is on the current upstream release.** `@excalidraw/excalidraw@0.18.1`
is still `latest` on npm, so being many commits behind upstream `master` is
being behind *unreleased* work — the same position as every other consumer of
0.18.1. This is worth stating because a naive `git rev-list HEAD..upstream/master`
suggests neglect and means nothing of the kind. The gate for a rebase is upstream
cutting 0.19, not a commit count.

The fork owns its R2 bucket (`teacher-playground-excalidraw`), CORS, custom
domain, release objects, and release metadata, published by its own GitHub
Actions workflow using the `prod` environment's `CLOUDFLARE_API_TOKEN` secret
and `CLOUDFLARE_ACCOUNT_ID` variable. The application consumes the immutable
base `https://excalidraw-assets.sen-tutor.co.uk/releases/0.18.1-tp.7/dist/prod/`.
Versioned objects carry one-year immutable cache headers.

## What the fork actually contains

Measured against its upstream merge base, the fork is **221 files changed and
roughly 2,950 deletions against 13 insertions**. Almost all of it is removal:

- **Slimming.** Chinese locales and the Xiaolai CJK font family are deleted, so
  the shipped bundle is smaller than upstream's.
- **Font loading.** `fonts/Fonts.ts`, `fonts/FontMetadata.ts` and `constants.ts`
  are adjusted for self-hosting (see [Asset loading](#asset-loading)).
- **Packaging.** Package identity, release assembly, CI/CD, Cloudflare IaC.
- **One security backport.** `fix: backport mermaid xss fix to 0.18.1`, carried
  rather than waiting for an upstream release.

Beyond that there are **three single-line source edits** — in `App.tsx`,
`TTDDialog/common.ts` and a `welcome-screen` stylesheet — plus the additive
increment and tool-change API described below.

That is the fork's defining property and the thing to protect: it changes
essentially no editor behaviour, so nothing custom can rot, and adopting a
future upstream release is close to conflict-free. Every proposal below is
weighed against the cost of giving that up.

## What the application already gets from the public API

An earlier version of this document argued for a fork on the grounds that
several things "could not be said" through the component's API. Reading the
installed type definitions refuted most of it. These are done, and the wrapper
is smaller for each:

1. **`reconcileElements`** replaced a hand-rolled merge.
2. **`captureUpdate: CaptureUpdateAction.NEVER`** keeps remote scenes out of
   local history.
3. **`updateScene({ collaborators })`** renders peer cursors natively; the
   custom cursor DOM overlay and its viewport maths are gone.
4. **`onPointerUpdate`** supplies local cursor position.
5. **`onScrollChange`** supplies the viewport for persistence.
6. **Teacher guide** is built on native follow state; the transport stays in
   the application (`ExcalidrawWrapper` and `RoomDO`), not in the fork.
7. **The boundary is typed**, no longer `any`.

Scoped Yjs undo stays deliberately: it gives local-origin grouping for our
shared document, which Excalidraw's history does not model.

> **Correction retained from the first draft.** That draft claimed Excalidraw
> "renders collaborator cursors internally but does not let us supply them".
> That was wrong — `updateScene({ collaborators })` had always been the
> supported path, and the type is rich (pointer, button, username, colour,
> selection, laser tool, idle state).

## What was genuinely not exposed before tp.7

Three gaps were identified in the pre-tp.7 public API, and tp.7 closes all three
additively. Only two of them earned their keep in the application: the tool
events replaced a singleton that could hold one listener, and the origin tag is
correct labelling. The increment feed was adopted and then removed -- §A records
why, and `EXCALIDRAW_INCREMENTS_TASK.md` is closed rather than pending.

### A. The change feed exists, tp.7 exposes it, and we do not use it

`packages/excalidraw/store.ts` defines `class Store` with a public
`onStoreIncrementEmitter`, firing a `StoreIncrementEvent` that carries
`elementsChange: ElementsChange` and `appStateChange: AppStateChange`.
`ElementsChange` (`packages/excalidraw/change.ts`) holds three maps — `added`,
`removed`, `updated`, each `id → Delta<ElementPartial>`. Excalidraw computes it
for undo/history. Release tp.7 exposes it as
`ExcalidrawImperativeAPI.onIncrement`, additively, leaving `onChange` unchanged.

**The application adopted it and then removed it again. That was the right
outcome, and the reasoning is worth keeping.**

The case for adopting it was that `onChange` hands over the whole scene on every
pointer sample, so the application rebuilds a delta the editor already has —
`diffScene`, a per-sample version map, a 50ms throttle, a deferred React hop
(which *is* the drawing-lag fix), and, later, a second de-duplication mechanism
for board images. Removing that cost was the entire point.

> **Correction (2026-08-29).** That premise was wrong, and this document
> asserted it before it was tested.
>
> A real-browser test held a multi-point pointer gesture and observed **zero
> increment callbacks before `pointerup`**. Increments fire on *commit*. The
> expensive path — whole scene, roughly twenty times a second, pointer down — is
> precisely where they do not fire.
>
> `IStore.filterUncomittedElements` was the tell, and it was written down as the
> one risk to resolve first. The plan was then built on top of the risk instead
> of resolving it.

That left a hybrid: increments publishing committed changes, `onChange` still
carrying the live stroke. It worked, it was tested, and it bought one avoided
scene diff per commit — on a path that runs once per stroke, not twenty times a
second. Against that: two publish paths through the code that makes drawing
work, plus a comparison mode and two feature flags to keep them honest.

**Decision: the increment adoption was removed** (`incrementSync.ts`, the flags,
the comparison mode, and the remote-republish scaffolding that existed only to
compensate for remote updates emitting no increment). The complexity was not
proportionate to a benefit nobody had measured.

What survives, and why:

- **`onToolChange` stays**, unconditionally. It replaced `ToolEvents.ts`, a
  module-level singleton with one handler slot and no unsubscribe. That was a
  real improvement independent of increments.
- **`source` on `updateScene` stays**, because labelling a remote scene update
  as remote is correct regardless of who listens.
- **`onIncrement` stays in the fork.** It is additive, costs nothing unused, and
  is still worth offering upstream on the narrower grounds: useful for committed
  changes, machinery already present, interface already `@experimental`.

Fixing the per-sample cost needs **mid-stroke deltas**, which upstream does not
expose in any form. That is a materially larger ask than exporting an existing
emitter and should be a fresh proposal with its own evidence, not a resumption
of this one.

### B. Origin tagging on notification — shipped in tp.7

A scene pushed in with `updateScene` comes back out through `onChange` as
though the user drew it, so the echo must be filtered. Release tp.7 carries the
commit source through the increment event and the application tags remote scene
updates with `source: 'remote'`. The old `onChange` baseline remains until the
full comparison gate proves it can be removed.

This is the same idea as Yjs transaction origins, which the application already
depends on (`transaction.origin === 'local'`). It pairs naturally with A.

### C. Tool state is set but never reported — shipped in tp.7

`setActiveTool` exists; release tp.7 adds `onToolChange` with unsubscribe support
for imperative, UI, and keyboard changes. The old module-level singleton
`src/components/whiteboard/ToolEvents.ts` was deleted.

An `onToolChange` subscription mirroring `onChange` lets the custom
`ToolSidebar` and `PaletteBar` *follow* the editor's state instead of trying to
own it.

### Shipped increment API (tp.7)

Release `teacher-playground-v0.18.1-tp.7` exposes the existing store change feed
through the imperative API without changing the editor's `onChange` behavior:

- `onIncrement` reports added, removed, and updated element maps, plus the
  optional `source` tag threaded from `updateScene`.
- `onToolChange` reports active-tool changes from UI actions, keyboard shortcuts,
  and imperative `setActiveTool` calls, with unsubscribe support.
- `StoreIncrementEvent` is exported as a public type.

The release was validated by GitHub Actions run `33213074035`; its GitHub Release
asset is `9,448,795` bytes with SHA-256
`040ca864f1eb67ddfb4d4bf4ce95cdbe09ee9f7e6b545306ab233ab4111d33f66`.

### Asset loading

Not hypothetical: self-hosting Excalidraw's fonts does not work as documented,
and the repository carries a build-time patch of upstream's shipped JavaScript.

Fonts resolve to two candidates — one under `window.EXCALIDRAW_ASSET_PATH`, one
under a hardcoded `ASSETS_FALLBACK_URL` pointing at esm.sh. What broke, in
order:

1. **Nothing set the asset path early enough.** ES module imports evaluate
   before the importing module's body, so assigning `EXCALIDRAW_ASSET_PATH` at
   the top of a component file ran *after* Excalidraw read it. `excalidrawAssetPath.ts`
   exists solely to be imported first — import order is the mechanism, which is
   why that import must stay at the top.
2. **A vendored copy went stale.** Asset filenames are content-hashed per
   release, so `public/excalidraw-assets` still held the 0.17 layout after the
   0.18 upgrade. Fixed by copying at build time (`prebuild`), never committing.
3. **Self-hosting still did not work.** With the variable set and fonts copied —
   the documented recipe — every font was still fetched from esm.sh
   ([excalidraw#8228](https://github.com/excalidraw/excalidraw/issues/8228), open).
   Against `font-src 'self' data: blob:` that meant ~220 blocked requests per
   room, typefaces that never rendered, and every pupil's browser reaching a
   third-party CDN to draw on a whiteboard.

`scripts/lib/excalidrawFontFallback.mjs` rewrites the hardcoded CDN base to
`${globalThis.location.origin}/` at build time. It is idempotent (`isPatched`),
and a zero-replacement result on an unpatched file **fails the build** — a
silent no-op would put every font back on the CDN, invisibly until someone
opened a console.

Distribution now assembles production assets via
`scripts/copy-excalidraw-assets.mjs`, published under the immutable versioned
R2 prefix and selected through `excalidrawAssetPath.ts`; local and E2E builds
deliberately retain the `/` fallback.

### Test handle

E2E reaches the scene API through `window.__debugExcalidrawApi` behind a build
flag. This has a real cost: in a production-shaped build the handle is absent,
so driving the board requires synthesising pointer events, which fight
Excalidraw's rAF throttling and pointer capture and produce strokes with one or
two points. A supported way to obtain the API in a test build would delete a
fixture we maintain.

## The change worth making

Items **A**, **B** and **C** are additive, non-breaking, and small — because the
machinery already exists. The implementation brief is
[`EXCALIDRAW_INCREMENTS_TASK.md`](EXCALIDRAW_INCREMENTS_TASK.md).

Sequence: raise A and B upstream first. The fork's value is that it changes
almost nothing, and that is worth preserving; carry the patches meanwhile the
same way the mermaid XSS backport is carried.

**Gate before adopting.** `ElementsChange` is built for *history*, and a history
delta is not automatically a collaboration delta — `IStore.filterUncomittedElements`
exists precisely because in-progress ephemeral state is excluded from commits.
Prototype against the existing sync E2E before deleting any current machinery.
If increments prove to miss mid-stroke state, the design becomes "increments for
committed changes, `onChange` for the live stroke" — still a large win, but a
different one.

## If the fork ever becomes an overhaul

Everything above optimises for the smallest possible delta, which is right for
carrying patches and wrong for an overhaul. If the reason to fork becomes "we
want an editor shaped around a classroom", the question is not what the API
cannot reach — it is what we will take ownership of, and what we never will.

### What an overhaul buys that the API cannot

- **Per-role editability.** `locked` is a property of the *element*, not the
  *viewer*. A worksheet the teacher can edit and a child cannot is not
  expressible — locking it locks it for everyone. The single most
  classroom-shaped thing upstream lacks.
- **Authorship as a rule, not a label.** `customData` can carry an author id
  today, but nothing enforces it. "A child may move only their own work" lives
  in interaction handlers with no hook into them.
- **Refusal.** Upstream assumes the local scene is truth: a mutation happens,
  then publishes. There is no "ask before you commit" seam, so a misbehaving
  client has already drawn before the server sees it. Server-side validation can
  undo, never prevent.
- **A CRDT-native document.** `version` / `versionNonce` / `index` exist because
  upstream reconciles by version. Ours is a Yjs document, so we convert between
  models constantly; `pointCodec.ts`, the tombstone rules and the publish/apply
  layer all descend from that seam. A fork whose scene store *is* the Yjs
  document deletes the seam rather than smoothing it.
- **Deleting attack surface.** Library sharing, external links, third-party
  image handling, export paths — anything that phones out. `UIOptions` hides
  them; a fork removes them. The `SECURITY_*` shelf would be shorter.

### What an overhaul forces us to own

The canvas renderer, text editing and wrapping, arrow binding and geometry,
image and file handling, export, accessibility, and the long tail of
shape-editing bugs. These are the hard, well-tested parts of Excalidraw and they
carry no classroom value. Owning them is pure cost, paid forever, in exchange
for the five bullets above.

### The shape worth forking

**Fork the document and permission layer. Do not fork the editor.**

Own: the scene store (make it the Yjs document), the interaction gate (may this
pointer move this element, given this role and this author), and the
collaboration surface. Leave upstream owning rendering, text editing, geometry,
binding, images, export.

Write that boundary down before changing a line, because every later decision
either respects it or turns this into a project that maintains a drawing editor.

### Sequencing, and the gate

1. **Name the outcomes** as things a teacher can do: a worksheet children cannot
   move, each child confined to their own area, "everyone look at my screen",
   "only your own work is yours to erase", freeze the board.
2. **Spike each against the current API.** Frames exist (`frameId`), locking
   exists, follow exists (`onUserFollow`) and the guide flow is built on it,
   authorship can live in `customData`. Reachable outcomes are not fork
   arguments.
3. **Fork only on what survives.** One survivor means build above the API and
   accept the awkwardness. Per-role editability *plus* refusal *plus* the CRDT
   document justifies the fork, and the boundary above is the plan.
4. **Decide the maintenance policy on day one.** An overhaul creates a deep
   delta, so plan to stop rebasing: fork at the pinned tag, log every
   divergence, cherry-pick only security and geometry fixes. Pretending the fork
   will track upstream is how forks die half-merged.

## Maintenance policy

The minimal fork is justified by ownership of packaging and distribution, not by
duplicating editor internals. The wrapper keeps using public APIs. Fork changes
stay limited to package identity, release assembly, CI/CD, security backports,
and a written divergence log — unless a separately tested classroom requirement
cannot be expressed through the public API.

For every release:

1. Start from the pinned upstream tag; record the upstream commit.
2. Bump `packages/excalidraw/package.json` to `x.y.z-tp.n`.
3. Run release assembly tests, typecheck, lint/format, package build.
4. Push the release branch; require its validation workflow to pass.
5. Create the annotated `teacher-playground-v<version>` tag. The tag workflow
   builds the bundle, checksums, GitHub Release, and R2 upload.
6. Consume an immutable version URL. Never install from `latest.json`; never
   build production from an untagged fork branch.

## Open risks

- **The working copy is not pinned.** `excalidraw/` is excluded through
  `.git/info/exclude`, which is **machine-local** — not `.gitignore`, not a
  submodule. Nothing in this repository or its CI ties the checkout to the
  published tarball; today they agree by convention alone. A submodule pin, or a
  CI assertion that the installed package version equals the fork tag, would
  make the relationship real.
- **Subpath exports are types-only.** `exports["./*"]` in the published package
  provides a `types` condition with no runtime entry. Type-only imports
  (`/types`, `/element/types`) are correct and safe; a value import from a
  subpath would fail to resolve at build time. A constraint to know, not a
  latent runtime bug.
