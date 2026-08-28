# Task: expose Excalidraw's store increments and adopt them

**Audience:** an implementing agent or engineer with no prior context on this
repository. Read this whole file before writing code. Background:
[`FORK_EXCALIDRAW.md`](FORK_EXCALIDRAW.md) §"What is genuinely not exposed".

**Two repositories are involved.**

| Repo | Path | Role |
|---|---|---|
| Application | this checkout | consumes the package |
| Fork | `excalidraw/` in this checkout, branch `teacher-playground/release-v0.18.1` | publishes `@teacher-playground/excalidraw` |

---

## 1. Why

`<Excalidraw>` notifies embedders with `onChange(elements, appState, files)` —
the **entire scene, on every pointer sample**, roughly twenty times a second
while drawing. It offers no delta.

Excalidraw nevertheless computes a delta internally, for undo/history:

- `excalidraw/packages/excalidraw/store.ts`
  - `class StoreIncrementEvent` — carries `elementsChange: ElementsChange` and
    `appStateChange: AppStateChange`
  - `interface IStore` — annotated `@experimental`
  - `class Store` — `public readonly onStoreIncrementEmitter: Emitter<[StoreIncrementEvent]>`,
    triggered from `commit()`
- `excalidraw/packages/excalidraw/change.ts`
  - `class ElementsChange` — three maps: `added`, `removed`, `updated`, each
    `Map<string, Delta<ElementPartial>>`

None of it reaches `ExcalidrawImperativeAPI`
(`excalidraw/packages/excalidraw/types.ts`).

So the application rebuilds, per sample, what the editor already has. The
machinery this exists to replace, in **this** repo:

| File | Symbol | Purpose |
|---|---|---|
| `src/lib/whiteboard/scenePublish.ts:37` | `diffScene` | rebuild the delta from a version map |
| `src/lib/whiteboard/scenePublish.ts:71` | `shouldPublish` | decide if the delta is worth sending |
| `src/lib/whiteboard/scenePublish.ts:82` | `elementsToPublish` | choose delta vs whole scene |
| `src/components/whiteboard/ExcalidrawWrapper.tsx:120` | `publishedVersionsRef` | the per-sample version map |
| `src/components/whiteboard/ExcalidrawWrapper.tsx:607` | `STROKE_COMMIT_INTERVAL_MS` | 50 ms throttle + trailing timer |
| `src/components/whiteboard/ExcalidrawWrapper.tsx:209` | `deferredElementsRef` | defer the React hop mid-stroke |
| `src/lib/whiteboard/excalidrawSyncCore.ts:39` | `excalidrawElementsEqual` | echo detection by double `JSON.stringify` |

The deferred React hop is the fix for the **drawing lag** users reported: handing
the whole scene to React on every sample re-rendered the board, and the cost grew
with how much had been drawn.

---

## 2. Scope

### In scope

- **Fork:** expose store increments and a commit `source` on the public API.
- **Fork:** expose tool changes.
- **Application:** consume increments in `ExcalidrawWrapper.tsx`, behind a flag,
  proving equivalence before deleting anything.

### Explicitly NOT in scope

- Do **not** change how the editor renders, edits text, binds arrows, or handles
  geometry.
- Do **not** restructure Excalidraw's scene store, or make it a Yjs document.
  That is a separate, much larger decision — see `FORK_EXCALIDRAW.md` §"If the
  fork ever becomes an overhaul".
- Do **not** delete `scenePublish.ts` or the throttle in the same change that
  introduces increments. Phase 4 covers removal, gated on evidence.
- Do **not** change the Yjs document schema, the transport, or `RoomDO`.
- Do **not** bump the upstream base off `v0.18.1`.

---

## 3. Phase 1 — fork: expose the increment

Work in `excalidraw/`, on a branch off `teacher-playground/release-v0.18.1`.

### 3.1 Public type

Export from the package root so embedders can type the callback. `StoreIncrementEvent`
is currently a non-exported class in `store.ts`; export it, or export a
structural type equivalent to it. Prefer exporting the existing class over
inventing a parallel shape.

### 3.2 API addition

Add to `ExcalidrawImperativeAPI` in `packages/excalidraw/types.ts`:

```ts
/**
 * Subscribe to committed store increments.
 *
 * Fires with the delta Excalidraw already computes for history: which elements
 * were added, removed and updated. Prefer this to `onChange` for collaboration
 * — `onChange` hands over the whole scene on every pointer sample.
 *
 * @experimental mirrors IStore, which is experimental.
 */
onIncrement: (
  callback: (event: StoreIncrementEvent) => void,
) => UnsubscribeCallback;
```

Wire it to `app.store.onStoreIncrementEmitter.on(callback)` in the same place
the existing `onChange` / `onPointerDown` subscriptions are constructed. Follow
whatever unsubscribe convention those already use — do not invent a new one.

### 3.3 Commit source (item B)

`updateScene` already accepts `captureUpdate`. Add an optional `source?: string`
that rides through `Store.commit()` onto the emitted event:

```ts
class StoreIncrementEvent {
  constructor(
    public readonly elementsChange: ElementsChange,
    public readonly appStateChange: AppStateChange,
    public readonly source?: string,
  ) {}
}
```

Default `undefined` for local user edits. This lets an embedder filter its own
echo with `if (event.source === 'remote') return;` instead of maintaining a
version baseline.

**Backwards compatibility is mandatory.** `onChange` must keep behaving exactly
as before. Everything here is additive.

### 3.4 Tool changes (item C)

Add, alongside the others:

```ts
onToolChange: (
  callback: (tool: AppState["activeTool"]) => void,
) => UnsubscribeCallback;
```

Fire it when the active tool changes, whether from a UI click, a keyboard
shortcut, or a `setActiveTool` call.

### 3.5 Fork tests

Follow the fork's own conventions. At minimum:

- An increment fires on a local element add, and `elementsChange.added` contains
  exactly that element id.
- An increment fires on delete and on update, populating `removed` / `updated`.
- `updateScene({ ..., source: 'remote' })` produces an increment whose `source`
  is `'remote'`.
- Unsubscribing stops delivery.
- `onToolChange` fires for both `setActiveTool` and a UI-driven change.
- **`onChange` still fires as before** — a regression test, not an afterthought.

### 3.6 Release

Per `FORK_EXCALIDRAW.md` §"Maintenance policy": bump to `0.18.1-tp.7`, run the
release assembly tests, tag `teacher-playground-v0.18.1-tp.7`, let the workflow
publish. Then update `package.json` and `package-lock.json` in the application
to the new immutable tarball URL.

---

## 4. Phase 2 — application: consume increments behind a flag

Work in this repo. **Do not delete anything yet.**

1. Subscribe to `onIncrement` in `ExcalidrawWrapper.tsx` alongside the existing
   `onChange` path.
2. Behind an env flag (follow `isWhiteboardLatencyProbeEnabled()` in
   `src/lib/whiteboard/latencyProbe.ts` for the established pattern), build the
   publish payload from the increment instead of from `diffScene`.
3. Add a **comparison mode** that runs both and logs a structured warning when
   they disagree, using `src/lib/http/safeError.ts` conventions for redaction.
   This is the evidence for Phase 4 and the single most valuable part of the
   task: it answers the open question in §7 with data instead of argument.

Run the whiteboard E2E under the flag, both on and off:

```bash
npm run test:e2e -- excalidraw-sync
npm run test:e2e -- multi-peer
npm run test:e2e -- collaboration
npm run test:e2e -- board-images
```

---

## 5. Phase 3 — application: adopt origin and tool events

1. Pass `source: 'remote'` from `applyRemoteElements` in
   `ExcalidrawWrapper.tsx`, then filter increments by it. When that holds,
   `adoptVersionBaseline` and `lastSyncedElementsRef` become dead.
2. Replace `src/components/whiteboard/ToolEvents.ts` with `onToolChange`
   subscriptions. That module is a mutable module-level singleton with one
   handler slot and no unsubscribe; it should be deleted, not adapted.

---

## 6. Phase 4 — remove the workarounds (gated)

**Only once Phase 2's comparison mode has run over the full E2E suite with zero
disagreements.** Then remove, each in its own commit with the E2E run as
evidence:

1. `diffScene`, `shouldPublish`, `elementsToPublish` and `scenePublish.ts`
2. `publishedVersionsRef`
3. `excalidrawElementsEqual` echo detection
4. `deferredElementsRef` and the deferred React hop
5. `STROKE_COMMIT_INTERVAL_MS` — **evaluate, do not assume.** Throttling may
   still be wanted for network reasons even when the CPU cost is gone. Measure
   with the latency probe before removing.

Finally, re-check whether board-image upload de-duplication (`filesToUpload` and
the uploaded-id set in `ExcalidrawWrapper.tsx`) can be driven from increments
rather than the whole files map.

---

## 7. The open question — resolve this first

`ElementsChange` is built for **history**. A history delta is not automatically a
**collaboration** delta.

`IStore` declares `filterUncomittedElements`, whose own comment describes
filtering "yet uncomitted elements ... part of in-progress local async actions
(ephemerals)". That strongly suggests increments may **exclude in-progress state
that a peer needs mid-stroke** — precisely the case this repo cares most about,
because a freehand stroke must appear on the other board while it is being drawn.

**Before Phase 4, and ideally before Phase 2 is finished, answer with evidence:**

> Does an increment fire during a stroke in progress, and does it carry enough
> for a remote peer to render the partial stroke?

- **If yes** — proceed as written.
- **If no** — the design becomes: **increments for committed changes, `onChange`
  for the live stroke**. Still a large win (it removes the per-sample delta
  rebuild for everything except the active stroke), but a different shape. Say
  so explicitly and revise this document rather than forcing the original plan.

Do not skip this. Discovering it during Phase 4 means unpicking deletions.

---

## 8. Conventions you must follow

Non-negotiable in this repository:

- **Strict TDD.** Write the failing test, run it, show the failure, then
  implement. Not test-after.
- **No mocks, stubs, or test doubles.** Use real objects. Worker tests use
  `cloudflare:test` with real bindings; unit tests use real `Y.Doc`s and real
  `Awareness` instances. If a test needs a fake to work, the design is wrong.
- **Comments explain *why*, never *what*.** This codebase writes short prose
  paragraphs naming the failure that motivated the code. `// loop over elements`
  is noise; "Spreading into a call passes one argument per byte, so a photograph
  overflows the stack" is the register.
- **Relative CSS units only** — `rem`/`em`/`%`. Never `px`, including in
  Tailwind arbitrary values.
- **Surgical changes.** Match surrounding style. Clean up only what your change
  made unused.
- **Commit directly to `main`.** No feature branches in the application repo.
  **Stage only your own files** — the working tree is edited concurrently.
- **Verify the commit, not just the file.** After committing, run
  `git show <sha> -- <path>` and confirm your change is actually in it. A file
  reverted between edit and `git add` has silently cost this project a shipped
  feature before.

### Verification gate

All of these must pass before you report done, and you must paste the real
output — not a summary:

```bash
npx eslint src/
npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.worker.json
npx vitest run
npm run test:workers
npm run build
```

`npm run test:workers` requires a real `./out`. **Run `npm run build` first.
Never create placeholder files to satisfy that check** — it exists to stop the
worker suite passing against empty assets, and defeating it produces failures
elsewhere that look unrelated.

In the fork, use its own equivalents; do not invent commands.

---

## 9. Definition of done

- [ ] Fork exposes `onIncrement`, increment `source`, and `onToolChange`, all
      additive, with `onChange` behaviour unchanged and regression-tested.
- [ ] Fork released as `tp.7`; application pins the immutable tarball.
- [ ] Application consumes increments behind a flag, with comparison mode.
- [ ] The §7 question answered **with evidence**, and this document updated with
      the answer.
- [ ] Full E2E green with the flag on and off.
- [ ] Workarounds removed only where the comparison mode proved them redundant;
      anything retained has a written reason.
- [ ] `FORK_EXCALIDRAW.md` updated to reflect what shipped.

## 10. If you get stuck

Report what you found rather than working around it. Specifically:

- If increments do not carry mid-stroke state, **stop and report** — do not
  invent a hybrid without saying so.
- If exposing the emitter requires touching editor internals beyond the API
  surface, **stop and report**. The fork's value is that it changes almost
  nothing (three source lines today); a large delta needs a decision, not a
  workaround.
- If a test is hard to write without a mock, that is a signal about the design.
  Report it.

A partial change that is honestly described is worth more here than a complete
one that is not.
