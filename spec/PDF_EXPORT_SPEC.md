# Download as PDF specification

Status: proposed and unimplemented. Every limit, module, test, and behaviour
below is a requirement for the implementation, not a description of current
behaviour.

## 1. Goal and scope

A lesson leaves the application as a PDF a parent or a student can open. The
teacher chooses **Download as PDF…**, and the board being looked at becomes a
PDF: one page per imported worksheet page, carrying whatever was written on it,
followed by one page for anything drawn outside those pages.

This is the other half of [PDF import](PDF_IMPORT_SPEC.md). The file is built in
the teacher's browser with Excalidraw's own `exportToCanvas` and
[jsPDF](https://github.com/parallax/jsPDF) (MIT, pinned exactly). Nothing new
exists on the server: no route, no table, no job.

Out of scope, each needing its own design note: exporting every board of a room
in one file, selectable text in the output, vector output, a page per student,
and emailing or sharing the file from the app.

## 2. Who, and from where

The room owner only, from **Download as PDF…** in the room title menu, beside
**Save as…**. The same reasoning as Save as: a board is usually a child's work,
and a guest admitted for one lesson should not be able to walk off with a copy.

The action is offline-safe: it reads the scene already in the browser and the
images already hydrated there, and writes a file to disk through the existing
`saveBlob` path.

## 3. What comes out

1. **A page per imported worksheet page.** Import stamps each placed page with
   `customData.pdfPage = { importId, index }` (`customData` survives both sync
   paths: the serializer deep-clones elements, and the HTTP scene schema passes
   unknown keys through). Export groups by `importId`, orders by `index`, and
   makes one PDF page per page element, at that page's board size in points, so
   a Letter worksheet comes out Letter and A4 comes out A4.
2. **Everything written on a page travels with it.** An element is drawn on a
   page when its bounding box intersects that page's rectangle. An annotation
   crossing two pages appears on both, cropped, which is what the teacher sees
   on the board.
3. **One final page for the rest.** Elements touching no worksheet page become a
   last PDF page, fitted to their bounding box with a small margin. A board with
   no imported pages therefore exports as a single fitted page, which is the
   sensible answer for a freehand lesson.
4. **Nothing else.** Cursors, the selection, the roster, and any element deleted
   from the board are not in the file.

Pages are rendered at 2x the board scale, capped so no page exceeds 4000 px on
its longest side, and embedded as JPEG at quality 0.92 — JPEG because every PDF
reader embeds it directly, and because the imported pages are already raster.

The file is named like the Save as copy (`boardFileName`), with the `pdf`
extension: the room name, the board name when it is not the only board, and the
date.

## 4. Failures

| Condition | Behaviour |
| --- | --- |
| The board is empty | "Nothing on this board yet." — the item stays enabled, because whether a board counts as empty is the exporter's judgement, not the menu's |
| A page's image bytes have not arrived yet | Refuse before writing anything: "Some pictures are still loading. Try again in a moment." |
| Rendering or writing fails | "Couldn't build the PDF." — no partial file is written |

A partial PDF is never written: every page is rendered before the file is
handed to `saveBlob`. While it builds, the room shows "Building the PDF…" in
the same notice the failures use; a long lesson takes a few seconds.

## 5. Delivery and required red tests

Follows `AGENTS.md`: strict red → green → refactor, real objects only, targeted
Stryker on changed `src/lib/**`, and the UX-expert visual check for the menu
item at desktop, 640–900 px, and 390×844.

1. **Pure logic** in `src/lib/documents/pdfExport.ts`, unit- and
   mutation-tested: grouping and ordering page elements from `customData`,
   which elements belong to a page rectangle, what is left over, the render
   scale for a page, where a page sits inside an exported canvas (the crop),
   and the file name.
2. **Import stamps pages.** `pdf-import.spec.ts` gains an assertion that placed
   pages carry `customData.pdfPage` with the import id and a 0-based index.
3. **The browser path** in `tests/e2e/pdf-export.spec.ts`: a teacher imports a
   2-page PDF, writes on page 1, draws away from both pages, and downloads. The
   test parses the downloaded file with PDF.js (already a dependency) and
   asserts three pages, the first two at the imported page size in points and in
   order, the third fitted to the stray drawing, and that page 1 differs from
   the page 1 of an export taken before the writing — proving the annotation is
   in the file. A non-owner has no menu item.
