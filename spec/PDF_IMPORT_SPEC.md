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

In scope: PDF files dropped or pasted on the board, a page-range choice only
for very long PDFs, and placement of the pages as locked images on the board
being viewed.

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
  image, and the server applies it to every page upload. Importing a PDF is
  adding images, so no new permission exists; the owner-only entry points are a
  product choice, not the security boundary.
- The `worker-src 'self'` CSP directive in `src/lib/worker/requestGuard.ts` — the
  PDF.js worker is served as a same-origin bundle chunk, so no header changes.

## 3. User flow

There is no menu item, footer button or file picker for PDFs. A PDF comes in
the way a picture does: it is dropped on the board or pasted onto it, and the
board recognises it and takes it in without asking anything it can decide for
itself.

1. The room owner **drops** a `.pdf` file anywhere on the board, or **pastes**
   one (a PDF file copied in the file manager, then Ctrl/Cmd+V on the board).
   While a PDF is dragged over the board, a hint reads "Drop to add this PDF".
   A file counts as a PDF by its type `application/pdf` or, when the browser
   reports no type, by a `.pdf` name; PDF.js then decides whether it really is
   one (§5).
2. Nothing is asked. The file is opened locally and every page is rendered —
   up to `MAX_PAGES_PER_IMPORT`. Only a PDF with more pages than that opens a
   small dialog asking which pages to add, defaulting to the first
   `MAX_PAGES_PER_IMPORT`; that is the one choice the board cannot make.
3. While pages render, a status line at the top of the board reads "Adding
   page n of m…" with a Cancel button. Cancel stops rendering and inserts
   nothing. Nothing else on the board is blocked while it runs.
4. All rendered pages are inserted in **one** scene update, so a single undo
   removes the whole import. The first page is centred on the point where the
   file was dropped (a paste uses the centre of the view), on the board
   currently shown, and the view then fits that page. Placement after the
   first page follows `PAGED_DOCUMENTS_SPEC.md` once that ships, and the column
   with a fixed gap until then. Each page element is `locked: true`.
5. Page bytes upload through the existing file path. Peers see the images arrive
   exactly as they see any other image arrive today, including the existing
   retry behaviour for a failed upload.

Rules at the edges:

- **Several files in one drop.** Each PDF is added in turn, as its own
  document, each one placed beside the last. Anything that is not a PDF in a
  drop that holds a PDF is left out, and the status line says so ("Only the
  PDF was added. Drop pictures on their own."). A drop with no PDF in it is
  Excalidraw's, untouched.
- **Someone who is not the owner** drops or pastes a PDF: nothing is inserted
  and the status line reads "Only the teacher can add a PDF." The server
  refuses page elements from anyone else in any case
  (`PAGED_DOCUMENTS_SPEC.md` §7).
- **A second PDF arrives while one is still rendering:** it waits its turn.
- **Room storage:** before rendering, the room's free space is read from the
  owner-only settings as today; if the rendered pages would not fit, nothing
  is inserted and the status line shows `importTooLargeMessage`.
- **Phones and most tablets** cannot drag files onto a web page, so a teacher
  on one cannot add a PDF in this release. Accepting PDFs in Excalidraw's own
  image tool is the follow-up if that matters.

The drop and paste are caught on the element wrapping the editor in the
**capture** phase, so Excalidraw never sees a PDF (it would otherwise report an
unsupported file); a drop or paste without a PDF passes through untouched.

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

Each page is drawn on white with a slate hairline (`#cbd5e1`, about one page
unit wide, at least 2 px) around its edge, so a white page is visible on the
white board and stacked pages are told apart; the frame is part of the image,
so every peer sees it.

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

1. **Insert PDF (shipped).** Pure logic in `src/lib/documents/pdfImport.ts`:
   page-range parsing and clamping, the raster scale, the column layout, the
   encoder fallback and the failure-to-message mapping; the dependency policy
   minimum for `pdfjs-dist`.
2. **Drop and paste, no menu.** Pure decisions go in
   `src/lib/documents/pdfIntake.ts`, unit- and mutation-tested: which files in
   a drop or paste are PDFs (type, then name), whether the drop holds anything
   else, whether a page range must be asked (more than `MAX_PAGES_PER_IMPORT`
   pages), where each document of a multi-file drop goes, and the status-line
   messages. The footer button, the title-menu item, the hidden file input and
   the old dialog's opening/rendering stages are removed; the range dialog
   remains only for the long-PDF case. `tests/e2e/pdf-import.spec.ts` is
   rewritten around a real drop (a `DataTransfer` carrying the fixture PDF,
   dispatched on the board) and a real paste: the teacher drops the fixture
   and a second participant sees one locked image per page, the first centred
   near the drop point; a single undo removes it; Cancel mid-render inserts
   nothing; a corrupt `.pdf` shows the message and changes nothing; a
   61-page PDF asks for pages and the default adds 50; a student's drop adds
   nothing and shows the message; a drop of only a picture still adds the
   picture as today; the room title menu and footer carry no PDF entry. A
   UX-expert check covers the drag hint and the status line at desktop,
   640–900 px and 390×844.

For every behaviour change run `npm test`, `npm run test:workers`, and
`npm run typecheck`, and `npm run test:e2e` through `scripts/run-e2e.mjs`.
