# PDF import specification

Status: proposed and unimplemented. Every limit, module, test, and behaviour
below is a requirement for the implementation, not a description of current
behaviour.

## 1. Goal and scope

A teacher can put the pages of a PDF on a board and write on them during a
lesson. The PDF is rendered **in the importing browser** with
[PDF.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist`, Apache-2.0), and each
selected page becomes an ordinary Excalidraw image element uploaded through the
existing board-file path. Nothing new exists on the server: no route, no table,
no job, no converter, and no new object family in R2.

In scope: PDF files, a page-range choice, and placement of the pages as a column
of locked images on the board being viewed.

Out of scope for this specification, each needing its own design note before
implementation: PowerPoint and Word (teachers export to PDF first), Google Drive
and OneDrive pickers, one board per page, handing pages out to individual
students, text selection or search inside pages, and keeping or downloading the
original PDF.

### 1.1 Decision record

An earlier design (retired, see git history before the commit that added this
file) converted uploads on the server inside an isolated container and placed a
single custom `document` element with page navigation. It was replaced because:

- workerd has no canvas, so server rendering needed a separately operated
  container runtime, a job lease protocol, and unconfirmed per-page cost;
- a custom element type needed an Excalidraw fork release, its own undo model,
  export rules, and a mixed-version rollout gate;
- page images placed as ordinary elements reuse what the board already does —
  sync, undo, export, follow-the-teacher, quotas, retention, erasure, backup —
  and every later feature built on boards (per-student hand-out) works on them
  without further change.

The cost accepted in exchange: a document is many elements rather than one, the
page text is not selectable, and the original file is not kept.

## 2. Existing seams this builds on

- `src/components/whiteboard/ExcalidrawWrapper.tsx` — the editor, `addFiles`,
  `updateScene`, and the image-file hydration and retry path.
- `src/lib/whiteboard/boardFiles.ts` and `src/lib/whiteboard/boardFileRoutes.ts`
  with the `PUT /api/whiteboard/room/:id/files/:fileId` route in `src/worker.ts`
  — authenticated upload, the `image/png|jpeg|webp|gif` allowlist, 25 MiB per
  file, 250 MiB per room, reserve/settle quota, and the "bytes are ready" signal
  to peers.
- `src/lib/whiteboard/authz.ts` — `canWriteBoard` already decides who may add an
  image. The same role may import a PDF, because importing a PDF is adding
  images; no new permission exists.
- The `worker-src 'self'` CSP directive in `src/lib/worker/requestGuard.ts` — the
  PDF.js worker is served as a same-origin bundle chunk, so no header changes.

## 3. User flow

1. A user who can write to the board chooses **Insert PDF** beside the image
   tool, or (milestone 2) drops a `.pdf` file on the board.
2. The file is opened locally. A dialog shows the file name, the page count, and
   a page range defaulting to all pages when the document has at most
   `MAX_PAGES_PER_IMPORT` pages, otherwise to the first `MAX_PAGES_PER_IMPORT`.
3. On confirm, pages render one at a time with a visible "Rendering page n of m"
   progress line and a Cancel button. Cancel stops rendering and inserts nothing.
4. All rendered pages are inserted in **one** scene update, so a single undo
   removes the whole import. Pages form a vertical column with a fixed gap, in
   page order, on the board currently shown, with the first page centred in the
   current view; the view then fits that page, so the teacher sees a whole page
   at once. Each page element is `locked: true`.
5. Page bytes upload through the existing file path. Peers see the images arrive
   exactly as they see any other image arrive today, including the existing
   retry behaviour for a failed upload.

`locked` prevents accidental dragging while writing on a page. It is an editing
convenience, **not** an access control: any editor can unlock an element, as
with every other element on the board.

## 4. Rendering contract

| Setting | Value | Reason |
| --- | --- | --- |
| Library | `pdfjs-dist`, exact version pinned, `>= 4.2.67` | CVE-2024-4367 (font-driven script execution) is fixed in 4.2.67 |
| Eval | none: pdf.js 6 has no `eval`/`new Function` path and removed `isEvalSupported`; the CSP has no `'unsafe-eval'` | The CVE-2024-4367 class cannot recur through configuration drift |
| Scripting, XFA, forms | off (`enableXfa: false`; no scripting API used) | Active PDF content never runs |
| Text and annotation layers | not rendered | Links and form widgets never become live DOM |
| Worker | same-origin bundle chunk | Satisfies `worker-src 'self'`; keeps parsing off the main thread |
| Standard fonts and CMaps | served from this origin, copied at build; `useSystemFonts: false` | No third-party fetch; CJK PDFs render; a page looks the same whichever machine rendered it |
| Maximum input file | 50 MiB (`MAX_PDF_BYTES`) | Bounds memory on school Chromebooks |
| Pages per import | 50 (`MAX_PAGES_PER_IMPORT`) | Bounds render time and room quota |
| Page raster | longest side 2000 px, never upscaled beyond 3x | Readable when zoomed on a projector; at most 4 million pixels per page follows from the side limit |
| Encoding | WebP at quality 0.85 when `canvas.toBlob` returns `image/webp`, else JPEG at 0.9 | Safari cannot encode WebP; the result type is checked, not assumed |
| File id | SHA-1 hex of the encoded bytes | Content-addressed and within the existing `[A-Za-z0-9_-]{1,64}` id rule |

Rendering is sequential; each canvas is released (`width = height = 0`) after
encoding, and the PDF document is destroyed when the import ends, fails, or is
cancelled.

## 5. Failures

Every failure leaves the board unchanged and shows one plain message:

| Condition | Message |
| --- | --- |
| Not a PDF / corrupt (`InvalidPDFException`) | "This file isn't a PDF we can open." |
| Password protected (`PasswordException`) | "This PDF is password protected. Remove the password and try again." |
| Over `MAX_PDF_BYTES` | "This PDF is larger than 50 MB." |
| A page fails to render | "Page n couldn't be rendered." — nothing is inserted |
| Room file quota would be exceeded | The existing quota message of the image path |

Upload failures after insertion are handled by the existing image retry path and
need no new behaviour.

## 6. Security and data protection

- The PDF never leaves the importing browser. The server receives only raster
  images from a caller already allowed to upload images, through a route whose
  type allowlist, size caps, quotas, and authorization are unchanged. This
  satisfies the teaching-content-import requirement that anything rendered is
  re-encoded: PDF.js rasterises, the canvas encodes, and SVG or PDF bytes are
  never stored or served.
- Page images are board files, so retention, erasure, export, and backup already
  cover them; `SECURITY_DATA_PROTECTION.md` gains no new object family.
- Parsing hostile PDFs happens in the importer's own browser, inside the PDF.js
  worker, with the settings in §4. `src/deployment/dependencySecurityPolicy.test.ts`
  enforces the minimum `pdfjs-dist` version.

## 7. Delivery milestones and required red tests

Every slice follows `AGENTS.md`: strict red → green → refactor, real objects
only, targeted Stryker on changed `src/lib/**` files, and a UX-expert visual
check at desktop, 640–900 px, and 390×844 for every visual change.

1. **Insert PDF.** Pure logic lives in `src/lib/documents/pdfImport.ts` and is
   unit-tested and mutation-tested: page-range parsing and clamping, the raster
   scale for a page size, the column layout for n pages, the encoder fallback
   decision, and the failure-to-message mapping. The dependency policy test
   gains the `pdfjs-dist` minimum. `tests/e2e/pdf-import.spec.ts` uses a real
   multi-page fixture PDF: a teacher inserts it and a second participant sees
   one locked image per page in order; a single undo removes the import; a
   corrupt file shows the message and changes nothing; a viewer has no Insert
   PDF action; cancelling mid-render inserts nothing.
2. **Drop a PDF on the board.** `pdf-import.spec.ts` gains a drop case that
   opens the same dialog; a dropped non-PDF keeps today's behaviour.

For every behaviour change run `npm test`, `npm run test:workers`, and
`npm run typecheck`, and `npm run test:e2e` through `scripts/run-e2e.mjs`.
