# Paged documents specification

Status: proposed and unimplemented. Every limit, module, message, test and
behaviour below is a requirement for the implementation, not a description of
current behaviour. It extends `spec/PDF_IMPORT_SPEC.md` and
`spec/PDF_EXPORT_SPEC.md`; where this document and those disagree, this one
wins for imports made after it ships.

## 1. Goal and scope

An imported PDF behaves as **one document on the board**: its pages sit in the
same place, one page shows at a time, and the room owner turns pages forward
and back for everybody. Everyone who may draw can write on the page that is
showing; what they write belongs to that page, disappears when the page turns,
and comes back when the page returns. Only the owner turns pages, moves the
document or removes it.

In scope: stacked placement at import, page turning, per-page annotations, the
owner's move and remove controls, the page state on the server, and Download as
PDF for stacked documents.

Out of scope, each needing its own note: students paging on their own, handing
a document out to individual students, thumbnails or a page strip, reordering
or inserting pages into an existing document, and a document spanning boards.

### 1.1 Decision record

Three routes were weighed.

- **A custom Excalidraw element type.** Measured against upstream, a new
  element type touches about fourteen files in the fork (type unions, restore,
  renderer, hit testing, bounds, export, collaboration, undo), and every one of
  them conflicts on the next upstream release. The fork's defining property —
  it changes almost no editor behaviour (`FORK_EXCALIDRAW.md`) — would be gone.
- **A column of pages the teacher scrolls between** (what shipped with
  `PDF_IMPORT_SPEC.md`). Needs nothing new, but it is not one object and the
  teacher cannot move it.
- **Chosen: ordinary image pages plus one visibility hook in the fork.** Pages
  stay ordinary image elements, so sync, persistence, undo, export, quotas,
  retention and backup keep working unchanged. The fork gains one optional
  prop that the editor consults before drawing or hit-testing an element
  (§4). Which page is showing is **room state held by the server** (§5), not a
  flag written onto elements, so turning a page is one small owner-only message
  rather than an edit to fifty elements, and nothing about visibility travels
  in the shared scene.

Per-role locking was rejected for the fork: `element.locked` is read in about
fifteen places, and making it differ by viewer would touch all of them. Pages
stay `locked: true` for everyone and the owner moves a document through its own
control (§6.3), which never unlocks anything.

## 2. Existing seams this builds on

- `src/components/whiteboard/ExcalidrawWrapper.tsx` — `insertPages` (stamps
  `customData.pdfPage = { importId, index }`, `locked: true`, one
  `updateScene` with `CaptureUpdateAction.IMMEDIATELY`).
- `src/lib/documents/pdfImport.ts` — `columnLayout`, `MAX_PAGES_PER_IMPORT`
  (50).
- `src/lib/documents/pdfExport.ts` — `worksheetPages`, `pageElements`,
  `leftoverElements`.
- `src/lib/whiteboard/followMessage.ts`, `src/lib/whiteboard/callMessage.ts` and
  their handling in `src/do/RoomDO.ts` (`FOLLOW_MESSAGE_TYPE` 101,
  `CALL_MESSAGE_TYPE` 102): owner-only private y-websocket frames, decoded
  before the Yjs path, dropped for any other role, never relayed as Yjs
  updates. Call state is persisted under `RoomDO.ACTIVE_CALL_KEY` and sent to
  each socket on connect. Page state copies this shape exactly.
- `src/lib/whiteboard/sceneGuard.ts` and the staged sync path in `RoomDO`
  (`stageSyncUpdate`, `buildCleanDoc`) — where §7's page guard lives.
- `src/lib/crypto/randomId.ts` — `randomHexId(8)` makes the 16-hex-character
  `importId`.

## 3. Data model

### 3.1 Page stamp

A page of a stacked document carries:

```ts
customData.pdfPage = {
  importId: string;   // /^[0-9a-f]{16}$/
  index: number;      // integer, 0 <= index < pageCount
  pageCount: number;  // integer, 1 <= pageCount <= MAX_PAGES_PER_IMPORT
  stacked: true;
}
```

All pages of one import share `x`, `y`, `width` and `height`: the first page's
rectangle, centred in the view as today. A page whose PDF size differs from the
first is fitted inside that rectangle, centred, keeping its aspect ratio; the
fit is decided at render time in `pdfImport.ts` (`stackedPageRect`). Pages stay
`locked: true`.

Imports made before this ships carry no `stacked` field. They stay a column,
always fully visible, with no pager, and export exactly as today. Nothing
migrates them.

### 3.2 Annotation stamp

An element drawn on the showing page of a stacked document carries:

```ts
customData.onPage = { importId: string; index: number }
```

The drawing client adds it once, when the element is finished (not while it is
still `appState.newElement` or `editingTextElement`), if the element's bounds
overlap the document's rectangle and the element has no `pdfPage` or `onPage`
stamp yet. The stamp is written through `updateScene` so its version bumps and
it syncs like any other edit, with `CaptureUpdateAction.NEVER` so it adds no
undo step of its own. Elements are never re-stamped: an annotation dragged off
the page keeps its page.

The stamp decides visibility and export only. It is not an access control;
a modified client can omit it, and the result is an annotation that shows on
every page — the same as any drawing beside the document.

### 3.3 Page state

The server holds, per room, a map `importId -> index` of the page showing for
each stacked document. A document with no entry shows page 0. Entries are not
cleaned up when a document is removed; the map is capped (§5).

### 3.4 Visibility rule

Given the scene and the page state, an element is **hidden** exactly when:

- it carries a `stacked` page stamp whose `index` is not the showing index for
  its `importId`; or
- it carries an `onPage` stamp whose `index` is not the showing index for its
  `importId`, **and** that import still has at least one live page in the
  scene. An annotation whose document was removed is never hidden.

Everything else is visible. Deleted elements are irrelevant (Excalidraw already
skips them). The showing index is clamped to `0..pageCount-1` of the
document's live pages before comparing, so a stale or out-of-range entry shows
the nearest real page rather than nothing.

## 4. Fork change (release `teacher-playground-v0.18.1-tp.12`)

One optional prop on `<Excalidraw>`:

```ts
isElementHidden?: (element: ExcalidrawElement) => boolean;
```

When it returns `true` for an element, the editor treats that element as if it
were not on the canvas for **drawing and pointer interaction only**:

| Seam | File | Behaviour |
| --- | --- | --- |
| Static canvas render | `packages/excalidraw/scene/Renderer.ts` `getRenderableElements` | hidden elements are not drawn |
| Hit testing | `packages/excalidraw/components/App.tsx` `getElementsAtPosition` | hidden elements are never hit (click, hover, eraser, double-click, context menu all go through it) |
| Box selection | `packages/excalidraw/scene/selection.ts` `getElementsWithinSelection` | hidden elements are never box-selected |
| Select all | `packages/excalidraw/actions/actionSelectAll.ts` | hidden elements are not selected, so select-all then delete cannot remove another page's annotations |

`scene.getElementsIncludingDeleted()` / `getSceneElements()` stay complete:
hidden elements are still in the scene, still synced, still exported by
`exportToCanvas`, and still saved. The prop never mutates an element.

`getRenderableElements` is memoised. The memo key must change when the prop's
identity changes, so the application re-renders a page turn by passing a new
function. Any other hit-testing path the implementer finds that does not go
through `getElementsAtPosition` (for example the eraser trail or the lasso, if
present in 0.18.1) is covered the same way, listed in the release notes, and
tested.

Fork tests (vitest, in the fork, beside the existing API tests): for each seam
above, a scene with two overlapping rectangles, one hidden — the hidden one is
not rendered (renderable list), not hit at a point inside both, not
box-selected, not selected by select-all; with the prop absent everything
behaves as upstream. A prop identity change re-renders.

`FORK_EXCALIDRAW.md` records the fifth behavioural divergence (tp.12) with this
justification, and the application pins the tp.12 tarball and asset base.
Publishing the release (pushing the tag) is an outward-facing action and needs
the owner's go-ahead.

## 5. Page state on the server

### 5.1 Message

`src/lib/whiteboard/pageMessage.ts`, mirroring `followMessage.ts`:

```ts
export const PAGE_MESSAGE_TYPE = 103;
export type PageMessage = { importId: string; index: number };
```

- Encoded as `writeVarUint(103)` then `writeVarString(JSON.stringify(message))`.
- Valid only when `importId` matches `/^[0-9a-f]{16}$/` and `index` is an
  integer with `0 <= index < MAX_PAGES_PER_IMPORT`, and the object has no other
  keys. Anything else decodes to `null`.

### 5.2 RoomDO

- The frame is recognised beside the follow and call frames, before the
  `canWriteBoard` branch and the Yjs path, and is never applied to the Yjs
  document or relayed as a Yjs update.
- **Owner only.** A frame from any role but the owner (editor, viewer, guest) is
  dropped silently, as the follow frame is. The role comes from the socket
  attachment and the database, never from the frame.
- A valid owner frame sets `pages[importId] = index`, persists the map under a
  new storage key `documents:pages`, and broadcasts the frame to every other
  socket in the room.
- The map holds at most **200** entries. Setting a new key when full drops the
  entry set longest ago (insertion order; re-setting a key moves it to the end).
- On connect, after the call state, the server sends one page frame per stored
  entry to the new socket. Guests receive them like everyone else.
- The key follows the room's existing storage lifecycle: it goes wherever
  `ACTIVE_CALL_KEY` goes on room delete, archive, erasure and restore. If a
  backup path does not carry DO key-value storage, a restored room shows page 0
  of every document — acceptable, and stated in the code comment.

## 6. Client behaviour

### 6.1 Import

New imports use stacked placement (§3.1) and the `stacked` stamp with
`pageCount`. The first page shows (no page frame is sent for a fresh import;
the absent entry means page 0). One undo still removes the whole import.
`columnLayout` stays for nothing new and is deleted if nothing else uses it.

### 6.2 Visibility

`ExcalidrawWrapper` receives the page state (from the page frames) and passes
`isElementHidden` built from `src/lib/documents/pagedDocuments.ts` (§8), with a
new function identity whenever the page state or the set of stacked documents
changes. It stamps annotations as §3.2 describes.

### 6.3 Pager

Each stacked document that is at least partly on screen shows a small pager
anchored under its rectangle's bottom edge, in viewport coordinates computed
from the scene rectangle and `appState` scroll and zoom (Excalidraw's
`sceneCoordsToViewportCoords`), clamped inside the viewport, and hidden while
the document is off screen.

- **Owner:** a move grip, Previous, "Page n of m", Next, and a Remove action.
  Previous is disabled on the first page and Next on the last. Turning a page
  updates the owner's view at once and sends the page frame.
  - **Move:** dragging the grip moves the document. While dragging, the
    document follows the pointer locally; on release, one `updateScene` with
    `CaptureUpdateAction.IMMEDIATELY` moves every page of the import and every
    element stamped `onPage` for that import by the same delta. Pages stay
    locked throughout. One undo reverts the move.
  - **Remove:** deletes every page of the import and every element stamped
    `onPage` for it in one undoable update. No confirmation dialog; undo is the
    recovery.
- **Everyone else:** "Page n of m" only, no controls.

Keyboard: every control is a real button with an accessible name ("Previous
page", "Next page", "Move document", "Remove document") and a visible focus
ring; targets are at least 44×44 px at phone width.

### 6.4 Download as PDF

A stacked document exports one PDF page per page index, in index order. The
contents of page *i* are: the page element itself (identified by element id,
not by rectangle, since all pages share one), every element stamped `onPage`
with index *i* for that import, and every **unstamped** element overlapping
the document's rectangle (those show on every page, so they print on every
page). Elements stamped `onPage` never fall into the leftover page. Column
imports and leftovers export exactly as `PDF_EXPORT_SPEC.md` says.

## 7. Server guard for document pages

Pages are locked in the editor, but locking is an editing convenience. This
milestone makes "only the owner moves or removes a document" true on the
server, on the staged sync path, for every writer whose role is not owner:

- creating an element that carries `customData.pdfPage` is refused;
- changing any property of an existing element that carries
  `customData.pdfPage` (geometry, `locked`, `isDeleted`, `customData`, `fileId`,
  anything) is refused, and the element keeps its previous value;
- adding `customData.pdfPage` to an existing element is refused.

"Refused" means the change never reaches the room's document or any peer, and
the writer's other changes in the same frame still apply. The owner is
unaffected; the whole-room and per-board clear are unaffected. The implementer
reads `stageSyncUpdate` / `buildCleanDoc` first and writes the approach into
this section before code; if the staged path cannot restore a single element's
prior state without discarding the rest of the frame, stop and report rather
than weaken the rule.

As a consequence editors can no longer import a PDF; the entry points are
already owner-only, so no visible behaviour changes.

## 8. Pure modules

`src/lib/documents/pagedDocuments.ts`, unit-tested and mutation-tested:

- `stackedDocuments(elements)` → per `importId`: live page ids by index,
  `pageCount`, the shared rectangle. Ignores deleted pages, column pages and
  malformed stamps (reuse the stamp validation style of `pdfExport.ts`).
- `showingIndex(document, pageState)` → the clamped showing index (§3.4).
- `isHidden(element, documents, pageState)` → §3.4.
- `annotationStampFor(element, documents, pageState)` → the `onPage` stamp to
  add, or `null` (already stamped, a page itself, no overlap, touching edges
  only).
- `moveDelta` / `elementsToMove(elements, importId)` and
  `elementsToRemove(elements, importId)` → the ids §6.3 moves or deletes.
- `nextPage` / `previousPage` → the index after a turn, never outside
  `0..pageCount-1`.

`src/lib/documents/pdfImport.ts` gains `stackedPageRect`. `pdfExport.ts` gains
the stacked-document grouping of §6.4. `src/lib/whiteboard/pageMessage.ts`
(§5.1) is a pure codec with the same tests `followMessage.ts` has.

## 9. Delivery milestones and required red tests

Every slice follows `AGENTS.md`: strict red → green → refactor, real objects
only, targeted Stryker on changed `src/lib/**` files with every mutant on
changed lines killed, manual mutants for every server guard, and a UX-expert
visual check at desktop, 640–900 px and 390×844 for every visual change. One
commit per milestone at a clean checkpoint.

1. **Fork hook (fork repo, tp.12).** §4 and its fork tests. Ends at a local
   release-branch commit with the version bumped; tagging and publishing wait
   for the owner.
2. **Pure modules and codec.** §8 (`pagedDocuments.ts`, `stackedPageRect`,
   `pageMessage.ts`). Unit and mutation tests only.
3. **Page state on the server.** §5.2 in
   `src/do/roomDocumentPages.workers.test.ts`: the owner's frame reaches the
   other sockets and is stored; a new socket receives stored pages on connect;
   **negative:** an editor's, a viewer's and a guest's frame are neither
   broadcast nor stored; a malformed frame is dropped and never reaches the
   Yjs document; the 201st entry drops the oldest; the key is removed with the
   room. Manual mutants: remove the owner check (an editor test must fail);
   remove the cap; skip the connect replay.
4. **Stacked import, visibility and pager (needs tp.12 pinned).** §6.1–6.3.
   `tests/e2e/paged-documents.spec.ts` with the real multi-page fixture: the
   teacher imports and a student sees page 1 of n; the teacher turns forward
   and back and the student follows; the student draws on page 2, the teacher
   turns to page 3 and the stroke is gone for both, then back to page 2 and it
   is there; a student has no page or move controls; a student's click on the
   page selects nothing; the teacher moves the document and the student sees
   pages and annotations moved together; one undo reverts the move; Remove
   deletes pages and their annotations and undo restores them; a late joiner
   sees the page the teacher is on; a board imported before this change still
   shows its column. UX check at the three widths.
5. **Export of stacked documents.** §6.4 in `pdfExport.ts` (unit + mutation) and
   the export e2e: a three-page stacked import with a stroke on page 2 exports
   three pages with the stroke only on the second.
6. **Server guard.** §7 in `src/do/roomDocumentGuard.workers.test.ts`:
   **negative:** an editor's frame that moves, unlocks, deletes, re-stamps or
   creates a page is refused while the same frame's ordinary stroke still
   lands; the owner's identical frame applies. Manual mutants: drop the role
   check; drop each of the three refusal rules one at a time.

Run `npm test`, `npm run test:workers`, `npm run typecheck`, and
`npm run test:e2e` through `scripts/run-e2e.mjs` for milestones 2–6.
