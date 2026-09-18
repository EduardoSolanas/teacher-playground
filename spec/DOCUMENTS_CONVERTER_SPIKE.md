# Embedded documents — converter runtime spike (milestone 0)

Status: **desk analysis complete, empirical probes pending.** Per
[EMBEDDED_DOCUMENTS_SPEC.md](EMBEDDED_DOCUMENTS_SPEC.md) §10 milestone 0, no
pipeline code may land before this spike concludes, and its outcome may reshape
§4–§6 of that specification. This document records the candidate analysis, the
license review, the recommendation, and the exact empirical probes that will
confirm or overturn it.

## 1. What the runtime must do

For the PDF-vertical MVP: receive a validated original (≤ 25 MiB), render every
page (≤ 200) to WebP inside an isolated environment with CPU/memory/wall-time/
filesystem/network limits, write page objects to the room-scoped R2 prefix, and
publish nothing until the complete validated revision exists (§5 of the spec).
PPTX and DOCX later need the same pipeline driven by a real Office-fidelity
converter; the MVP does not ship them.

## 2. Candidates

### A. PDF.js (`pdfjs-dist`, Apache-2.0) inside a Worker, pages to pixels via OffscreenCanvas

- **Fit for PDF:** PDF.js is a complete, maintained PDF renderer. workerd
  exposes `OffscreenCanvas` with a 2D context; the open question is the pixel
  path out — `convertToBlob` support and WebP encoding in workerd must be
  proven, with `image/webp` quality control. If WebP encoding is unavailable
  in workerd, PNG through the same path plus a re-encode step is the fallback
  to probe (the spec's "trusted image pipeline" allows re-encoding).
- **Isolation:** runs inside the existing Worker deployment model — no new
  infrastructure to operate. CPU/wall-time limits come from the Worker limits
  themselves plus the job lease protocol (§5).
- **Boundaries:** pdf.js needs DOM shims in workerd (`DOMMatrix`, `Path2D`,
  `ImageLoader` behaviors); the probe must enumerate the exact shim set.
  Fonts: PDF.js ships standard-font data; embedding-avoidant teaching PDFs
  render acceptably, but the probe must measure fidelity on real fixtures.
- **Does NOT solve PPTX/DOCX.** Those still need candidate B or C when their
  milestone arrives.
- **License:** Apache-2.0; bundled standard fonts under their own permissive
  licenses — record exact versions in the dependency review (§5.1).

### B. Cloudflare Containers running LibreOffice headless (MPL-2.0) or similar

- **Fit:** the only candidate with credible full-fidelity Office rendering for
  the PPTX/DOCX milestones. LibreOffice headless → PDF/images is the
  industry-standard open-source path.
- **Costs:** a second deployment unit (image builds, cold starts, version
  pinning, private networking to R2/queues), operational on-call surface the
  project does not have today. Containers on the free tier may not exist in a
  form this project can afford; pricing must be part of the spike record.
- **License:** LibreOffice MPL-2.0; fonts (Liberation/Carlito/Caladea) are
  permissive but metric-substitution fidelity must be fixture-tested.
- **Verdict:** the presumptive choice for the PPTX/DOCX milestones; overkill
  and cost-heavy for a PDF-only MVP.

### C. Self-hosted sidecar (existing VPS or home server) running the same open-source converters

- **Fit:** same converters as B without Cloudflare Containers pricing; but it
  introduces a machine the operator must patch, back up, and keep reachable
  from Workers over an authenticated channel — a new trusted-computing base
  and a new failure domain for a service whose current deployment is one
  Worker script.
- **Verdict:** acceptable fallback if B's pricing fails the spike; not the
  first choice.

### D. Hosted conversion SaaS (CloudConvert, ConvertAPI, AWS services with proprietary edges)

- **Excluded by §5.1** (must be open source and self-hostable). Recorded here
  only to state the exclusion is deliberate.

## 3. Recommendation

1. **PDF MVP and all formats: candidate B.** The in-worker candidate (A) was
   rejected on P1 evidence (§4). One container image runs the open-source
   converter set: `pdftoppm` (poppler) for PDF, LibreOffice for PPTX/DOCX.
2. **Candidate C** remains the fallback if Containers pricing fails the
   measured cost probe (P6), which is now the only open spike question.
3. Either way, the trusted re-encode/validation boundary (§5) stays in Worker
   code the repository owns; the container never receives storage
   credentials, and no candidate may publish pages that skipped the boundary.

## 4. Empirical probe results

**P1 — pixel path: FAILED. Decisive.** workerd (1.20260811, compat 2024-12-10,
nodejs_compat) exposes **no canvas surface at all**: `OffscreenCanvas`,
`OffscreenCanvasRenderingContext2D`, `ImageData`, and `createImageBitmap` are
all `undefined` (recorded by the committed tripwire
`src/canvasSurface.workers.test.ts`, which fails if a future toolchain ships a
canvas surface and forces this spike to be re-opened). No compatibility flag
enabling one exists in workerd, miniflare, or `@cloudflare/vitest-pool-workers`
(searched). pdf.js v6 therefore cannot rasterize inside a Worker, and a
software rasterizer substitute would be a project of its own.

**P3 — shim set: recorded, moot.** pdf.js v6 uses `Path2D` unconditionally
(20 call sites) and `DOMMatrix` (7 sites: `preMultiplySelf`, `invertSelf`,
`multiplySelf`, `translate`, `scale`, `addPath(path, matrix)`) with no feature
guards; the probe implemented working shims for both, but they cannot matter
without a pixel surface. The shims and probe harness are preserved in the
spike's git history (commit preceding this edit).

**P2/P4/P5: not reachable** — they depend on P1's pixel path. They are
re-scoped below to candidate B's container runtime.

**Verdict: candidate A rejected. Candidate B (isolated container running
open-source converters) is selected as presumptive; candidate C
(self-hosted sidecar) is the fallback if Containers pricing fails P6.**

Candidate B's design shape for the pipeline (to be proven by milestone 2–3
tests): a converter container claims a job lease from an authenticated Worker
API, renders pages locally (`pdftoppm` from poppler for PDF; LibreOffice for
Office formats), and pushes every page through a Worker validation endpoint
that owns the trusted re-encode/bounds checks and the only R2 write path — the
container never receives storage credentials. The Worker-side lease/publish
protocol from §5 is unchanged by which runtime executes the conversion.

## 5. License register (provisional, pinned at image-build time)

| Component | License | Notes |
| --- | --- | --- |
| `poppler-utils` (`pdftoppm`) | GPL-2.0 | Unmodified binary invoked server-side inside the isolated container; not redistributed or linked into the application. Fidelity and license reviewed again at image pin |
| LibreOffice (Office formats) | MPL-2.0 | Only when the PPTX/DOCX milestone proceeds |
| Liberation/Carlito fonts (container) | SIL OFL / GPL+exception | Metric-substitution fidelity must be fixture-tested |
