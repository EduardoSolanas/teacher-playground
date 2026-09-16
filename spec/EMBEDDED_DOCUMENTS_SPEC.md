# Embedded paginated documents specification

Status: proposed and unimplemented. This is a handoff specification for a future implementation. Every limit, route, schema, test, and user experience below is a requirement or proposed default, not a description of current behavior.

## 1. Goal and scope

A room owner can upload a PDF, PPTX, or DOCX and place it on one board as one document object. The object has a stable position and size and shows one page at a time. Previous and next controls change the page without replacing the object or expanding the document into Excalidraw image, text, or shape elements. The original upload is retained privately. Rendered pages are immutable WebP assets stored separately from the collaborative scene.

The MVP must ultimately accept all three formats. Delivery may be phased as PDF, then PPTX, then DOCX, but the feature is not accepted as complete until all three meet the same authorization, rendering, annotation, export, accessibility, and recovery criteria. Legacy `.ppt` and `.doc`, editable Office content, embedded media playback, macros, forms, password-protected files, and cross-room document reuse are out of scope.

Drive and OneDrive import are later phases after the renderer and direct-upload path meet acceptance. Provider import copies a chosen file into this room's private storage and then uses the identical validation, quota, conversion, reference, and erasure pipeline; it is never live editing, live sync, or a durable link to the provider. Explicit “Replace from provider” creates a new immutable version and does not migrate annotations unless the owner confirms a tested page mapping.

Google Drive should use the Picker and the narrow `drive.file` model described by [Google Drive API authorization guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth). Google-native Docs and Slides must be exported to a supported format before import rather than treated as downloadable OOXML files. OneDrive should follow the current [OneDrive file picker guidance](https://learn.microsoft.com/en-us/onedrive/developer/controls/file-pickers/?view=odsp-graph-online); delegated permission and tenant-consent behavior differs across personal, business, and school accounts, so implementation must not claim a Google-equivalent selected-file scope without proving it for each supported account class. The existing security requirement against plaintext provider tokens in the client requires an explicit reviewed contract update before a browser-picker implementation: at most a short-lived owner token held in memory, never persisted or exposed to students, or a server-compatible alternative. Provider imports need their own threat model and authorization tests and do not delay the direct-upload MVP.

Full security requirements are normative in [SECURITY_FEATURE_REQUIREMENTS.md](../SECURITY_FEATURE_REQUIREMENTS.md), under **Embedded paginated documents (PDF, PPTX, DOCX)**. This document defines product and integration behavior and must not weaken that section.

## 2. Existing integration points

Implementation must extend the repository's actual seams rather than create a parallel board:

- `src/components/whiteboard/ExcalidrawWrapper.tsx` owns the pinned editor integration, file hydration, scene reads, and `onChange` publication.
- `src/lib/whiteboard/excalidrawSyncCore.ts`, `excalidrawSync.ts`, and `yjsDoc.ts` serialize and reconcile elements. The current serializer allowlist rejects unknown element types; the new type and its bounded fields must be handled deliberately.
- `src/lib/whiteboard/requestSchemas.ts` validates HTTP scene writes, while `src/lib/whiteboard/sceneGuard.ts` sanitizes the primary Yjs/WebSocket path. Both boundaries must recognize the document element and enforce the same invariants. A UI-only or HTTP-only check is insufficient.
- `src/do/RoomDO.ts` owns room grants, durable Yjs snapshots, SQL projection, board deletion, file quota accounting, and orphan cleanup.
- `src/worker.ts`, `src/lib/whiteboard/boardFileRoutes.ts`, and `src/lib/whiteboard/boardFiles.ts` implement authenticated room file I/O through the private `BOARD_FILES` R2 binding. The existing board-file defaults are 25 MiB per object and 250 MiB per room.
- `src/lib/whiteboard/boardExport.ts`, `boardDownload.ts`, and `saveBlob.ts` are the current board export path.
- `tests/e2e/board-images.spec.ts`, `board-tools.spec.ts`, `excalidraw-sync.spec.ts`, `room-authorization.spec.ts`, and the `src/do/*.workers.test.ts` suites provide the closest real-path coverage.

The app consumes `@teacher-playground/excalidraw` from a pinned release archive in `package.json`; a sibling or local `excalidraw` checkout is not used automatically. Any editor changes must be made in the fork, released as a uniquely versioned immutable archive, pinned in both `package.json` and `package-lock.json`, and verified by `scripts/copy-excalidraw-assets.mjs` and its tests. Application code and the fork release must land as a compatible pair. A floating branch, local path, or unpublished fork change is not an acceptable dependency.

## 3. User and permission model

Only the room owner may upload, place, move, resize, rotate, remove, or replace a document instance, retry or cancel its conversion, change its shared page, or download its original. An authorized room reader may view ready pages. An editor may view and annotate under the room's existing write grant, but cannot mutate document geometry or document metadata. Removing a document is an owner operation even when an editor can erase ordinary elements.

These rules apply on every server write path. A forged scene POST or Yjs update from an editor that creates a document, changes `documentId`, `pageIndex`, geometry, dimensions, rotation, conversion state, or deletion status must be rejected or sanitized before relay and persistence. The server must compare protected fields with its authoritative prior state; merely validating field shapes does not establish ownership. Unauthorized readers must not obtain originals, rendered pages, manifests, conversion status, cache hits, byte ranges, or existence signals.

Shared-page navigation and local browsing are distinct:

- **Shared page** is authoritative room state. Only the owner changes it. Its update is synchronized and persisted, and all viewers following the teacher see it.
- **Local page** is ephemeral per browser. Any authorized viewer may temporarily browse another page without changing shared state. The UI clearly says that the viewer is browsing locally and offers “Return to shared page.” A later shared-page change may show a non-blocking notice but must not silently destroy local work or pretend the viewer followed it.
- Entering teacher-follow mode returns the instance to its shared page. Local page choices are not written to Yjs, SQL, the server manifest, presence, or exports.

## 4. Storage and data model

### 4.1 R2 objects and isolation

Use the existing private `BOARD_FILES` binding. No object is public. Every key is room-scoped; no hash or cache key may expose or reuse content across rooms. Suggested key families are:

- `rooms/{roomId}/documents/{documentId}/original`
- `rooms/{roomId}/documents/{documentId}/pages/{pageIndex}-{renderRevision}.webp`

The exact grammar may change, but route parameters must be validated before key construction and must never be accepted as raw key fragments. Objects are immutable. Replacement creates a new document identity or render revision and changes references atomically; it does not overwrite bytes at an existing identity.

Room-only deduplication is allowed after authorization: identical bytes uploaded twice in the same room may share an immutable asset record and reference count. Content must never be probed, linked, cached, or deduplicated across rooms, because that creates both authorization ambiguity and a cross-room existence oracle.

### 4.2 Server manifest

The authoritative server manifest is stored outside the collaborative scene and contains at least:

- room ID, document ID, original asset identity, normalized original filename, detected media type, byte length, and content digest;
- uploader account ID and creation/update timestamps;
- lifecycle state: `uploading`, `queued`, `converting`, `ready`, `failed`, `cancelled`, `deleting`;
- conversion attempt and render revision, idempotency key, lease/heartbeat data, retry count, safe public error code, and progress totals;
- page count and, for each ready page, immutable WebP asset identity, pixel width/height, byte length, and digest;
- live instance references, deletion/undo grace deadline, and cleanup state.

Internal converter diagnostics stay in restricted logs or job metadata and are never returned verbatim to clients. A manifest becomes `ready` only after every declared page exists and passes output validation. Clients must never assemble a partly ready document by guessing R2 keys.

### 4.3 Collaborative scene reference

Add one explicit custom element type, provisionally `document`, for each placed instance. It is one selectable board object and contains only bounded, non-secret references and display state: element ID, board ID, instance ID, document ID, shared page index, x/y/width/height/angle, version fields, and optional bounded accessible label. It contains no original bytes, page bytes, data URLs, base64, download URLs, conversion diagnostics, page manifest, or per-page image elements.

The element refers to a server manifest but cannot confer access to it. Reads always authorize the current room session. The manifest separately records each live instance reference so cleanup does not depend solely on an eventually projected scene row.

Schema evolution must be versioned. Already shipped clients cannot be assumed to preserve an unknown custom element, so the room handshake must advertise a minimum scene/editor protocol and require an incompatible open client to reload or enter a non-writing state before document elements can be created. The new fork should still preserve bounded opaque future elements where its reconciliation contract permits, but that is forward protection rather than a substitute for the rollout gate. New clients must open scenes written before this feature without migration, treating absent document collections as empty. Server migrations must be additive, restartable, idempotent, and safe during a mixed-version deployment. Rollback must preserve unknown references and stored assets.

### 4.4 Annotations and coordinates

Annotations remain normal collaborative Excalidraw elements, with a bounded document anchor that identifies `instanceId`, `pageIndex`, and an anchor schema version. The document itself remains one object; rendered page content is never decomposed. A document-bound annotation is visible only when its page is displayed for that viewer.

Anchor geometry is stored in normalized unrotated page coordinates, relative to the intrinsic page rectangle, and converted through the document element's current affine transform for display. Page changes do not rewrite annotation geometry. Moving, resizing, or rotating the document therefore carries every bound annotation with it without accumulating rounding error. Replacing a document must not silently transfer annotations unless the owner explicitly confirms a page mapping; the default is a new document identity.

Selection, erasure, copy, grouping, and duplication must not orphan anchors. Deleting an annotation deletes only that annotation. Removing the document hides and schedules all its anchored annotations for the same undo grace period. Restoring the document restores them at the same instance, page, and coordinates.

## 5. Upload and conversion pipeline

The browser uploads the original through an owner-authorized, bounded route. Content type and extension are hints only; the server inspects magic bytes and package structure. OOXML packages must be protected against zip bombs, path traversal, external relationships, macros, active content, oversized expanded content, excessive entries, and malformed XML. Unsupported, encrypted, or corrupt inputs fail with a stable safe error.

Conversion runs in an isolated asynchronous job environment with explicit CPU, memory, wall-time, filesystem, and network limits. Do not assume an ordinary Cloudflare Worker can execute LibreOffice or another native renderer. No converter vendor, library, hosted service, or runtime is selected by this specification. Selection requires a tested spike covering visual fidelity, font substitution, equations, charts, transparency, rotated text, notes/hidden slides, page sizing, malformed inputs, deterministic output, cancellation, cold start, cost, observability, data location, retention, and failure cleanup.

Open XML parsing can inspect PPTX/DOCX structure but does not paginate Word documents and is not evidence of Office rendering fidelity. A placeholder, fake renderer, text extractor presented as pages, or claim of full Office fidelity is prohibited. Acceptance requires fixture-based visual comparison and documented limitations from the chosen converter.

MVP conversion is server-side for **all three formats, including PDF**, and produces validated WebP pages. Each converter output is decoded and re-encoded by a trusted image pipeline before publication, with dimensions and decoded pixel count checked independently of encoded size. The original remains a private attachment and is never served inline as the board surface. PDF.js rendering with a bounded WebP cache is a possible later optimization only after a separate threat-model and sanitization contract proves it cannot bypass the server-side output guarantees; it is not an MVP path.

Job creation is idempotent by `(roomId, documentId, renderRevision)`. Redelivery, timeout, or client retry must resume or safely repeat work without duplicate manifests, quota charges, or references. A worker claims a lease, renews a heartbeat, writes pages under a new revision, validates the complete set, then atomically marks that revision ready. A stale worker cannot publish after its lease or revision is superseded. Retry only classified transient failures, with bounded exponential backoff and jitter; terminal failures require an owner retry that creates a new attempt. Cancellation and room/document deletion fence future writes.

Progress reports state and coarse bounded counts such as pages completed/total; it is pollable or pushed through an authorized room channel and survives reload. The UI distinguishes uploading, queued, converting, ready, retryable failure, terminal unsupported/corrupt failure, offline, and removed states. A failed conversion retains the original only for the documented retry/erasure window and never leaves a selectable blank object indefinitely.

### 5.1 Reuse candidates to spike

Start with maintained frameworks and renderers rather than writing document parsers. These are evaluation candidates, not approved dependencies or fidelity claims:

Every new viewer, converter, upload component, and supporting service introduced for this document pipeline must be open source and self-hostable. The feature must not depend on a proprietary SDK, closed renderer, or mandatory paid conversion SaaS. This constraint does not require replacing the application's existing Cloudflare infrastructure, and it permits the optional Google and Microsoft APIs used only as source-file pickers. Record and review the license of every dependency, transitive runtime component, bundled font, and converter at the exact pinned version before selection.

- For cloud selection, evaluate [Uppy's Google Drive Picker](https://uppy.io/docs/google-drive-picker/) and [OneDrive plugin](https://uppy.io/docs/onedrive/) against direct use of the official pickers. Prefer the narrow Google picker plugin over a broader Drive integration when it meets the flow. Uppy and Companion are [MIT licensed](https://github.com/transloadit/uppy/blob/main/LICENSE). [Uppy Companion](https://uppy.io/docs/companion/) is a Node/Express backend that can stream remote files to an upload endpoint; self-host it rather than requiring a Transloadit hosted plan. It is not an ordinary Worker drop-in and would require separately operated hosting, credentials, isolation, quotas, and retention controls. Audit every plugin's token persistence defaults, including any `localStorage` use, before adoption. Popup support must work under the existing CSP and cross-origin isolation policy; do not weaken those headers globally to make a picker work.
- For PDF, evaluate [PDF.js](https://mozilla.github.io/pdf.js/), which is [Apache-2.0 licensed](https://github.com/mozilla/pdf.js/blob/master/LICENSE), inside the isolated conversion runtime as a reusable renderer feeding the same trusted WebP validation pipeline. This does not authorize client-side PDF rendering for MVP.
- For DOCX, evaluate [docx-preview/docxjs](https://github.com/VolodymyrBaydalka/docxjs), which is [Apache-2.0 licensed](https://github.com/VolodymyrBaydalka/docxjs/blob/master/LICENSE), only against the pagination and fidelity fixture suite. Its browser preview model is not assumed to reproduce Word pagination or support reliable repeated re-pagination, so a successful parse alone cannot select it.
- For PPTX, evaluate [office-kit/pptx](https://github.com/office-kit/pptx) and [pptx-renderer](https://github.com/aiden0z/pptx-renderer) against the real slide fixture suite. Neither candidate is approved until fonts, charts, equations, transforms, cropping, transparency, and failure isolation pass measured thresholds.

The spike records version, license, maintenance activity, runtime fit, input attack surface, deterministic output, visual results, memory/time/cost, and deployment design. Failure of a JavaScript candidate should lead to evaluating a proven self-hostable open-source converter in an isolated runtime, not lowering acceptance, adopting a mandatory conversion SaaS, or building an ad hoc partial parser.

## 6. Proposed initial limits

These are adjustable defaults to be changed only with measured converter, browser-memory, R2-cost, and classroom fixture evidence. They are not final product entitlements.

| Limit | Proposed default | Reason and interaction |
| --- | ---: | --- |
| Original upload | 25 MiB | Matches current `MAX_BOARD_FILE_BYTES`; a distinct route must not silently raise it. |
| Total room file storage | 250 MiB | Matches current `MAX_ROOM_FILE_BYTES_TOTAL`; originals and derived pages count toward the same reservation unless a tested quota design changes it. |
| Pages per document | 200 | Bound manifest, conversion time, UI navigation, and cleanup. |
| Expanded OOXML package | 200 MiB and 10,000 entries | Independent zip-bomb bounds; tune from hostile and real fixtures. |
| Rendered page dimensions | 4,096 px on either side and 12 megapixels decoded | Both limits apply before and after trusted re-encoding. |
| Derived bytes per document | 200 MiB | Reservation must occur before conversion and remain inside the room total. |
| Conversion wall time | 120 seconds per attempt | Timeout is a retryable classification only when the job is idempotent. |
| Conversion concurrency | 1 active job per room, 2 per owner account | Protects interactive room traffic and prevents upload fan-out. |
| Attempts | 3 total | Initial attempt plus two transient retries; owner may explicitly start a new attempt. |
| Browser page cache | 64 MiB decoded globally per board and 32 MiB encoded globally | The budget applies even when several document instances are visible: prioritize selected/in-viewport pages, request or derive reduced-resolution display variants, and show placeholders rather than pinning every full-resolution current page. Previous/next pages and thumbnails may be prefetched only inside the global budgets and are first to be evicted; there is no per-instance multiplication of the cap. |
| Upload/progress polling | At most once per 2 seconds per active document | Back off when hidden, offline, terminal, or ready. |
| Undo cleanup grace | 24 hours | Assets with zero live references remain recoverable for owner undo, then are erased. |

The service must reject before accepting bytes or starting work when a declared or reserved limit is exceeded. Concurrent upload/conversion reservations must be atomic so racing jobs cannot oversubscribe the room. Encoded size, expanded input, decoded pixels, page count, and resulting R2 usage are separate checks.

## 7. Asset reads, caching, and cleanup

Original, page, manifest, progress, HEAD, conditional, and range requests all execute the room authorization check before storage lookup. Range syntax and response sizes are bounded; multiple or overlapping ranges may be rejected. Unauthorized and nonexistent assets should have indistinguishable safe responses where practical. Private responses must not be stored in a public/shared cache. Any application cache key includes the authorization-relevant room identity and asset revision; cached data cannot outlive grant revocation semantics. The R2 bucket has no public development or production URL.

Only immutable ready pages receive long-lived browser caching. Original downloads use a safe attachment filename, `Content-Disposition: attachment`, `nosniff`, and a restrictive content type. Rendered pages use `image/webp`, `nosniff`, and the existing response security headers. Signed URLs, if later introduced, must be short-lived, room-bound, revocable in practice, and must not appear in collaborative state or logs.

Reference accounting covers scene instances, undo records, conversion jobs, and exports in progress. Removing the last instance starts the grace period; it does not immediately erase assets needed for undo. Undo cancels pending cleanup and restores the same references. Redo restarts it. After grace, an idempotent sweep deletes original, every page revision, manifest/job residue, and quota reservation. Room deletion and account erasure bypass normal grace where policy requires, enumerate paginated R2 prefixes, retry partial failure, and leave a durable cleanup marker until complete. Orphan sweeps must fail closed when authoritative references cannot be read and must include document manifests in addition to existing image/library references.

## 8. Interaction, accessibility, and responsive behavior

The selected document has previous/next buttons, `current / total`, a shared/local mode indicator, loading progress, retry where authorized, and an accessible document name. Controls are keyboard reachable in a logical order, have visible focus, expose names and disabled state, and announce page and conversion changes through a polite live region. Arrow shortcuts act only when focus/context makes document navigation unambiguous; they must not steal text editing, canvas panning, or screen-reader navigation. A non-visual user can discover the document, page count, current page, conversion error, and how to return to the shared page. Page images use the document label plus page number as accessible text; extracted document text is not promised by MVP.

Loading the next page uses a stable skeleton inside the same bounds, never resizes the object, and offers retry on network failure. It must not display the previous page underneath annotations for the newly selected page. If a design temporarily retains old pixels, it must label them as the old page and suppress new-page annotations and drawing until the matching page is ready. Rapid navigation cancels obsolete fetch/decode work and cannot show an older response over a newer page. Fullscreen/presentation mode preserves shared/local semantics, annotations, keyboard escape, and focus return. On mobile, controls remain usable without covering the page or browser safe areas, pinch/zoom does not accidentally turn pages, and local browsing status remains visible. Offline users keep already cached pages and see a clear unavailable state for uncached ones.

Visual acceptance covers desktop, the 640–900 px band, and 390×844 phone at minimum, including portrait/landscape pages, maximum page numbers, long filenames, conversion progress, failure/retry, local-browse indication, selection handles, fullscreen, and annotations near page edges. No control may clip, overlap, orphan-wrap, or become too small to operate.

## 9. Undo, redo, copy, and export

Undo is actor-scoped using the existing editor history semantics:

- An owner insertion, geometry change, shared-page change, replacement, removal, and restoration is one coherent undoable operation apiece. Undoing a shared-page change restores the previous shared page for everyone. Local browsing never enters collaborative undo history.
- Annotation creation, edit, move, and deletion use ordinary editor undo but retain their page anchor. Undoing document removal restores its anchored annotations and cancels cleanup within the grace window. After irreversible erasure, a stale undo entry fails visibly rather than creating a broken reference.
- Conversion state transitions and background retries are operational state, not undo steps. Undoing an insertion cancels/fences its job and follows the normal grace/cleanup rules.

Copying within the same room may preserve the semantic document reference and create a new instance/reference after server authorization. Pasting into another room, another origin, or a generic clipboard must not leak private IDs or bytes; it produces a rasterized snapshot of the displayed page with visible annotations, or a safe unsupported notice if rasterization fails. Cut follows copy plus an owner-authorized removal. Editors cannot use copy/cut to duplicate an owner-controlled document instance.

Existing `.excalidraw` export cannot assume another Excalidraw understands the private custom element or can access room assets. For a portable board export, each document instance is flattened to an ordinary image of the **shared page at export time**, with visible annotations rendered in the correct stacking order; no room URL, document ID, manifest, original, hidden page, or credential is embedded. The export reports any page it could not fetch/render instead of silently producing a broken reference. PNG/clipboard export uses the page currently visible to the exporting user and includes visible annotations. The owner receives a separate “Download original” action for the retained source file. A future all-pages lesson archive requires its own versioned format and is outside MVP; this specification does not disguise a single-page `.excalidraw` export as a complete document backup.

PDF export is an additional download format and does not replace `.excalidraw` export. It uses an open-source, self-hostable PDF library and no proprietary SDK or paid rendering service. The first iteration may rasterize output and does not promise selectable text or editable round-trip content, but it must preserve fonts as rendered, aspect ratio, orientation, stacking, and clipping. The result is a standard `application/pdf` attachment with no editor chrome, cursors, private IDs, tokens, room links, or source-document active content. Rendering starts only from authorized scene data, existing validated board image assets, and trusted document WebP page assets; it never re-embeds the PDF or Office original.

The export UI offers three explicit PDF modes:

- **Active board** fits the complete board content bounds, rather than the current viewport, onto one PDF page.
- **Selection** fits the selected board-object bounds onto one PDF page and is disabled when the selection is empty. Selecting a document includes that document's annotations for its selected shared page. Selecting only annotations exports those selected strokes without implicitly adding the underlying document.
- **Document pages** exports all pages or a validated selected range from one document instance, with one intrinsic document page per PDF page. The range UI may explicitly choose the viewer's current local page as a one-page range; otherwise page choices are independent of local browsing. Each page includes only that instance's matching page-bound annotations, transformed and clipped in page-local coordinates. Annotations are composed once in stacking order, never both baked into a page bitmap and drawn again. Other-page strokes and unrelated board content are excluded.

Active-board and selection PDF exports are collaborative snapshots and therefore render every selected document instance at its shared page, even when the exporter is browsing locally. Choosing “current local page” in the document-page range is the only PDF export choice that follows the exporting viewer's local page, and its label must make that distinction explicit.

At export start, capture an immutable snapshot of the scene revision, manifest/render revisions, document page choices or range, and required asset identities. Concurrent drawing, deletion, conversion publication, shared navigation, or local navigation cannot mix revisions within the output. Asset fetches remain authenticated throughout; revocation or any missing, changed, or failed page aborts with a specific error rather than silently omitting content. Process pages sequentially under explicit decoded-pixel, output-resolution, page-count, and memory limits, with progress, cancellation, cleanup, and a recoverable failure state. Existing room export/read authorization applies to PDF export; the separate original-download action remains owner-only.

## 10. Delivery milestones and required red tests

Every implementation slice follows `AGENTS.md`: strict red → green → refactor, one behavior per cycle, real objects only, and no new mocks, stubs, or test doubles. Names below are required intent; the implementer may fit them into existing files while keeping the stated behavior obvious.

1. **Schema and fork compatibility.** Start with failing tests such as `excalidrawSyncCore.test.ts › preserves a bounded document element without serializing manifest data`, `requestSchemas.test.ts › accepts the document type only with bounded reference fields`, `sceneGuard.shared.test.ts › rejects an editor Yjs mutation of owner-only document metadata`, and `ExcalidrawWrapper.types.test.ts › pinned fork exposes the document element contract`. Prove an old/unknown client cannot delete the element before rollout.
2. **Manifest, quota, and upload.** Start with `roomDocumentUpload.workers.test.ts › owner reserves original and derived bytes atomically`, `› editor and reader cannot upload`, `› mismatched magic bytes and hostile OOXML fail before conversion`, and `› racing uploads cannot exceed the 250 MiB room quota`.
3. **Isolated conversion.** Use real malicious and representative fixture files. Workerd tests such as `documentConversion.workers.test.ts › redelivery is idempotent`, `› stale lease cannot publish`, `› publishes only a complete validated WebP revision`, and `› cancellation fences late output` verify the job protocol and publication boundary; they must not pretend to execute a native converter. A separate integration suite in the selected isolated job runtime must invoke the real converter and prove PDF, PPTX, and DOCX page count, geometry, hostile-input handling, and accepted visual-diff thresholds. No fake converter may make either acceptance layer green.
4. **Authorized delivery and cleanup.** Start with `roomDocumentFiles.workers.test.ts › rejects missing, revoked, and wrong-room sessions for manifest original page HEAD conditional and range reads`, `› room deletion erases every revision`, and `› last-reference grace supports undo then erases and releases quota`.
5. **One-object editor and navigation.** Start with `ExcalidrawWrapper.test.tsx › document stays one element across page changes`, `› editor annotations cannot mutate protected metadata`, `useUndoRedo.test.tsx › shared page undo is collaborative while local browse is not`, and real browser specs `embedded-documents.spec.ts › owner shares a page while a student browses locally and returns` and `› annotations remain aligned across page resize rotation and navigation`.
6. **Export and clipboard.** Start with `boardExport.test.ts › flattens the shared page and excludes private document metadata`, `› reports an unavailable page`, `pdfExport.test.ts › board PDF uses content bounds and shared document pages`, `› document-range PDF composes each page annotation exactly once`, `› immutable export snapshot rejects a changed manifest revision`, and `› selection PDF is disabled for an empty selection`. Browser coverage must include same-room copy, forbidden editor duplication, cross-room raster fallback, PNG/clipboard current-view behavior, owner-only original download, and a real PDF download whose page count and order are parsed with a real PDF parser and whose rendered pages pass visual verification. Include cancellation, revocation during fetch, and a missing-page failure that proves no partial success is reported.
7. **Accessibility and responsive finish.** Add browser tests for keyboard/focus/live-region behavior and run the required UX inspection at desktop, 640–900 px, and 390×844. Cover fullscreen, offline, slow conversion, long labels, failures, and maximum page counts.

For every behavior change, run `npm test`, `npm run test:workers`, and `npm run typecheck`. Run `npm run build` before Worker tests in a fresh checkout or whenever build inputs change, because the Worker suite requires `out/index.html` and `out/whiteboard.html`. Run `npm run test:e2e` through `scripts/run-e2e.mjs` for every browser, HTTP, session, file, and WebSocket behavior; do not invoke Playwright through a bypass configuration. Run targeted Stryker for every changed `src/lib/**/*.ts` file and kill all mutants on changed lines. For authorization, origin, session, request-boundary, Worker, and Durable Object guards that Stryker cannot cover, manually weaken one guard at a time, prove the intended real test fails, restore it, and prove green. Record the killed mutant and test. A separate verifier must inspect the exact candidate diff, rerun required commands, and attempt at least one changed guard mutant before returning `APPROVE`.

Any visual change also requires the `AGENTS.md` UX-expert subagent to open the real page through the local Worker using `scripts/run-e2e.mjs`, exercise the affected states, capture every affected breakpoint (at minimum desktop, 640–900 px, and 390×844), and return `PASS`. A reported `FAIL` blocks the checkpoint until fixed and reverified.

## 11. Acceptance gate

The feature is accepted only when PDF, PPTX, and DOCX all pass representative fidelity fixtures; one document remains one scene object; originals and pages stay outside the collaborative scene; owner-only metadata is enforced on HTTP and Yjs paths; authorized readers can view pages without public storage; editor annotations remain page-stable through transform and navigation; local browsing never changes the shared page; conversion is isolated, bounded, retryable, observable, and idempotent; `.excalidraw` and PDF exports meet their separate snapshot, authorization, completeness, and privacy contracts; undo, erasure, clipboard, accessibility, mobile, and fullscreen behavior match this specification; all required suites and mutations pass; the pinned fork release is reproducible; independent verification returns `APPROVE`; and the security requirements referenced in section 1 have their own implementation evidence.
