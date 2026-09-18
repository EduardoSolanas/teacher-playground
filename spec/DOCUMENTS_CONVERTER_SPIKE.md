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

1. **PDF MVP: candidate A.** One empirical probe decides it (§4). It keeps
   the single-Worker deployment, costs no new infrastructure, and PDF.js is
   the most battle-tested open-source PDF renderer available.
2. **PPTX/DOCX milestones: candidate B**, contingent on Containers pricing
   measured during the PDF milestone; C is the fallback. This keeps the MVP
   unblocked while leaving the Office path open with its own honest cost
   conversation.
3. Either way, the trusted re-encode/validation boundary (§5) stays in Worker
   code the repository owns; no candidate may publish pages that skipped it.

## 4. Empirical probes (the actual spike — pending)

Each probe is a workerd test in this repository (or a scratch harness promoted
to a test) against real fixtures; none may be satisfied by a mock renderer.

- **P1 — pixel path:** `documentsSpike.workers.test.ts › renders a pdf fixture
  page to OffscreenCanvas pixels inside workerd`. Fixture: a 2-page PDF built
  with embedded text and one vector shape. Acceptance: non-blank pixel data
  with the expected aspect ratio; deterministic across two runs.
- **P2 — WebP encode:** `› encodes canvas output to image/webp`. Acceptance:
  bytes decode as WebP (verified by a real decoder in the test), width/height
  match. If workerd lacks WebP encoding, record PNG and the re-encode plan.
- **P3 — DOM shims:** `› renders with the enumerated workerd shim set` —
  document every shim pdf.js needs; the set becomes the conversion job's
  contract.
- **P4 — limits under load:** a 200-page, 20 MiB fixture: wall time, peak
  memory, and CPU against the §6 defaults (120 s, page dimension caps). This
  decides whether PDF.js-in-workerd meets the classroom-fixture bar or the
  wall-time default must change.
- **P5 — hostile input:** encrypted PDF, polyglot PDF/ZIP, and a decompression-
  bomb PDF: clean safe failures, no hang, no memory blowout beyond the
  documented job limits.
- **P6 — Office pricing probe (deferred to the PPTX milestone):** Containers
  cost/cold-start measurement for candidate B.

Probe outcomes update §4–§6 defaults of the spec and this document records the
final decision. Until then: **flag contract implemented; pipeline code frozen.**

## 5. License register (provisional, pinned at probe time)

| Component | License | Notes |
| --- | --- | --- |
| `pdfjs-dist` | Apache-2.0 | Version pinned at probe; transitive deps reviewed then |
| LibreOffice (candidate B) | MPL-2.0 | Only if the Office milestone proceeds |
| Liberation/Carlito fonts (candidate B) | SIL OFL / GPL+exception | Metric-substitution fidelity must be fixture-tested |
