# Project review and implementation queue

**Next action — user:** supply the affected room ID or URL and roughly when the disconnects happened, ideally including timezone. SYNC-02 is waiting for this input; incident capture and classification cannot advance without it. While waiting, the bounded correctness work that can proceed is SYNC-06a, SYNC-06b, STORE-01a, STORE-05b and SYNC-05-measure. These are separate assignments, not authorization to implement them all together.

Review date: 2026-09-04. Baseline: `037eab5` on the current checkout.

This file is the remaining work queue from that review. Every R-card (R00–R17)
and the finished sync/storage slices (SYNC-01a, STORE-03a, STORE-05a) were
implemented, verified and removed from this queue on 2026-09-13; their
completion notes and evidence live in git history (see the commits that closed
them and `security.md` for the security-relevant gates).

This is a repository-wide review of the application, Worker/DO boundaries, identity, storage, collaboration, A/V, UI, tests, build scripts, deployment workflows, and existing plans. It is not a line-by-line audit of the vendored Excalidraw fork or a production penetration test. Production configuration, live media, and deployed SHA were not verified.

**Do not implement this entire file in one prompt.** Pick one task ID, read its current code, reproduce the issue, and make one verified change. Findings below distinguish directly observed code gaps from hypotheses needing a reproduction.

## Execution rules for a cheaper model

Read `AGENTS.md` before starting. Preserve unrelated work and use an isolated `codex/` worktree for implementation. Build the static export before Worker tests; run Worker and E2E/build steps sequentially on Windows because workerd holds `out` open.

Repository instructions name Haiku and Cursor-specific cheaper models, which are not callable in this Codex session. Resolve that model selection with the orchestrator before delegation; do not silently run agents on the expensive model or pretend an unavailable slug was used. Mechanical documentation tasks need the least capable available model; UI and narrowly specified fixes need a coding model capable of the repository's TDD rules. Security design stays with the stronger orchestrator.

For every implementation:

1. Re-read the scoped files and existing tests. If already fixed, report the evidence instead of rewriting it.
2. Write one failing behavior test, run it, and capture the actual assertion failure. Use real objects/services, no mocks, stubs, or test doubles. An existing fake-based test is not permission to add more.
3. Make the smallest fix, then run the focused test and refactor only if needed.
4. Run `npm test`, `npm run test:workers`, and `npm run typecheck`; browser/HTTP/session/WebSocket work also requires `npm run test:e2e` through the existing runner. Run lint and build when relevant. Do not weaken assertions, add retries, or bypass the issuer runner to obtain green.
5. For a changed guard, kill one targeted mutant, restore it, and confirm green. Record the exact test and mutation. A failed setup is not a killed mutant.
6. Obtain a separate verifier under the repository rules; the orchestrator must inspect the diff and independently verify results. Update the review canvas when required by `AGENTS.md`; only the orchestrator changes `security.md` status.
7. Commit only this completed slice after required gates pass. If blocked, hand off exact changes, logs, and failing commands. Push/deployment is a separate explicitly scoped task.

Suggested prompt:

> Implement task **[ID]** in PROJECT_IMPROVEMENT_TASKS.md only. Use **[available cheaper model slug chosen by orchestrator]**. Files in scope and the required first failing test are in that task. Follow AGENTS.md: strict red/green/refactor, real objects only, full required suites, targeted mutants for guards, separate verification, and one verified commit. Do not change architecture, security status, unrelated files, or production configuration. If the reproduction is green, report why and stop that fix. Return red evidence, diff summary, green command outputs, mutant evidence where applicable, and commit SHA or explicit blocked handoff.

## Focused sync/storage queue — 2026-09-05 review revision

This is the sole assignment/status index for the findings in `SYNC_STORAGE_REVIEW.md`; that file is a technical appendix, not another work queue. The user assigned existing test repairs to another model. No implementation or additional test runs are authorized by this review revision alone. Re-read current code and coordinate file ownership before dispatching any later implementation.

**First investigation, alone: SYNC-02.** Capture one deployed-build teacher/peer incident timeline before attributing disconnects or prioritizing protocol/performance changes. Record close category, true document-sync state, reconnect duration, document/row sizes, and last successful persistence. Prefer existing diagnostics before adding instrumentation. A room URL and approximate incident time remain missing. Other correctness slices below do not depend on proving they caused that incident.

| Slice | State / decision | Production scope | First regression or measurement file and acceptance |
|---|---|---|---|
| SYNC-02 | Waiting for user: affected room ID/URL and approximate incident time, ideally with timezone. Deployment verified; incident capture/classification remains pending. | Existing provider status, close logs, room stats; checked deployment evidence in appendix | Existing `tests/e2e/latency.spec.ts` for diagnostic capture if extended; `src/lib/whiteboard/roomStats.test.ts` and `src/hooks/useCollaboration.test.tsx` for any added reporting contract. Deliver matched real incident timelines and build identity; a passing local test is not the deliverable. |
| SYNC-06a | Bounded correctness fix, pending | `scenePublish.ts`, `ExcalidrawWrapper.tsx` candidate selection | `src/lib/whiteboard/scenePublish.test.ts`, `src/lib/whiteboard/yjsDoc.test.ts`, then `tests/e2e/guest-join.spec.ts`: final same-version point changes reach the shared document and peer, without publishing the whole board. |
| SYNC-06b | Separate from 06a; pending | Publish success/baseline advancement in `ExcalidrawWrapper.tsx` | `src/lib/whiteboard/scenePublish.test.ts` for the factored success contract and `tests/e2e/guest-join.spec.ts` for delivery. A failed publish must retain a retryable baseline. Establish a faithful real-object failure mechanism before implementation; do not invent a fake Yjs write. |
| STORE-01a | Stale HTTP reads and permanently unsuccessful projection retries; pending | `RoomDO.ts` projection and HTTP scene readers | `src/do/roomSqlProjection.workers.test.ts`: actual oversized scene data must not silently return an older board as current or repeatedly attempt an unchanged, impossible single-row write. Preserve the canonical document and recovery path; suppressing retries alone is not a storage fix. Agree the smallest coherent reader/projection behavior before implementation. |
| STORE-05b | Later separate library-save slice | Library response handling and pending-save lifecycle | `tests/e2e/room-library.spec.ts`, `src/lib/whiteboard/roomLibrary.test.ts`: rejected/oversized save is visible and recoverable. Separate remaining behaviors into red/green cycles. (Leaving during the save debounce no longer discards a pending edit: `ExcalidrawWrapper` flushes it on unmount and on `pagehide` via a keepalive request, proved by `tests/e2e/room-library.spec.ts` "keeps a shape saved moments before the teacher leaves the room" and the unmount/pagehide component tests in `ExcalidrawWrapper.test.tsx`.) |
| SYNC-05-measure | Measure before choosing optimization priority | Existing publish/observer path; no optimization in this slice | `tests/e2e/latency.spec.ts` or an explicitly separate diagnostic harness: real short strokes at increasing board sizes; report commit/main-thread duration, remote ink latency, device, browser, points, images and sample distribution. Compare to a stated frame budget. A synthetic helper-only time or one universal element threshold is insufficient. |

**Next decisions, after evidence:** re-rank SYNC-01's protocol/state work (generation, watermark and durable receipts), SYNC-03/04/05/07/08, the large-projection migration part of STORE-01, STORE-02 and STORE-04. This does not gate SYNC-01a's truthful wording. Known single-row storage limits remain real even if they do not explain a particular disconnect. For STORE-02, use `src/do/roomDOSync.workers.test.ts` for checkpoint/restart behavior and `src/do/roomSqlProjection.workers.test.ts` for projection recovery.

**STORE-01 expiry note:** pan/zoom persists viewport through the room PATCH and refreshes `updated_at`, as do settings changes. Expiry exposure therefore also requires no such refresh for 90 days while projection fails. This conditional edge case does not justify a first-priority activity-lease slice.

**Not now:** STORE-06 (account libraries), STORE-07 (lessons/pages/per-page documents), STORE-08 (version history). These are product/architecture options, not implementation assignments. Decide scale, ownership and retention before adding them to this queue.

**Execution ownership:** do not fan out the ExcalidrawWrapper slices into one checkout; SYNC-06 and STORE-05 overlap that file. Serialize them or use isolated worktrees with deliberate integration. STORE-01a overlaps RoomDO work and must coordinate with R03/R06. Do not assert that these are five-line or afternoon fixes before the real-object regression and existing change ownership are understood. Preserve all current completion notes above; this addition marks nothing implemented or approved.

## Storage optimisation queue — 2026-09-14

Assignment and status index for `STORAGE_OPTIMISATIONS.md`, which is the evidence appendix. S7a, S7b (`46ea993`, V2 is the only written format), S5 and S6 part 1 are done; see that file's status block for commits and verifier verdicts.

| Slice | State / decision | Gate before starting |
|---|---|---|
| S6b | Parked. Skip the success-path projection marker only once the snapshot and row writes are explicitly atomic (`ctx.storage.transactionSync`). | A restart test that observes the difference; the first attempt (`7b4c8bd`) was reverted because nothing could. |
| STORE-MEASURE | Pending, needs production access. Record `snapshotBytes` vs `rowBytes` from the room stats route for several long-lived rooms, plus the V1/V2 bytes S7b logs. | None. |
| S1 | Not started. Stale-peer guard (coordinate with SYNC-01 generation work) before or with empty-room compaction. | STORE-MEASURE sets whether to build it and its thresholds. |

## Already present: do not recreate these from old notes

- Sync frames are no longer intentionally shed by `decideSignalingAction`; normal budget is 120 and awareness is the shed class.
- Presence 5xx maps to an error/degraded path; RoomDO fetch has a top-level error response boundary.
- useAvSession memoizes its result/actions, stores Room in state, and excludes display-name changes from the connection effect.
- ParticipantTile prefers live subscribed screen-share tracks and uses the LiveKit rendering path.
- Provider interface and numeric invariant tests already exist.
- Long/short real-pointer strokes and late-peer collaboration regressions exist in recent commits.
- Security headers, authorization tests, dependency audits, secret scanning, R2 cleanup paths, and server document persistence are substantial existing protections. Improve specific gaps; do not replace the architecture wholesale.

These are source-confirmed observations, not a claim that every edge case or deployed version is verified.

## Security findings and performance queue - 2026-09-16 (TypeSafe-assisted review)

Provenance: candidates were retrieved by code inspection, then judged by the
TypeSafe System One model (`jev-1.13.0`, agent skill `typesafe-ai`, key in the
`TYPESAFE_API_KEY` user environment variable) for exploitability/severity
(C-series) or impact/effort/worth-now (S-series), and then independently
verified against the actual code by the orchestrator. TypeSafe output is
decision support, never evidence. Two deliberate negative controls (SEC-C3,
SEC-C4) were flagged as candidates and verified clean; they are kept to show
the pipeline discriminates. Per the file's rules: one ID, one verified change.

| ID | Area | Finding | Evidence | Recommended action | Status | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-C1 | Rate limiting | `POST /api/whiteboard/room/:id/documents` accepts 25 MiB binary uploads with **no rate limiter**, unlike scene-write/presence/room-create. Owner-only and quota-capped (250 MiB/room), but request volume and CPU are unthrottled. TypeSafe: exploitable 0.83, severity 2.8/4. Orchestrator: confirmed. | dispatch `src/worker.ts:3831` calls `documentsUploadRoute` with no limiter; limiter patterns at `src/worker.ts:261-322` | Add a documents-upload limiter mirroring the scene-write pattern. **Done (verified)**: `DOCUMENTS_UPLOAD_RATE_MAX = 10`/minute per account in `src/lib/worker/rateLimits.ts`, production+strict limiters applied in `documentsUploadRoute`; red test `throttles document uploads after the configured burst with 429 and Retry-After` observed failing (201-burst, no 429) then green; targeted mutant (strict limiter `max + 5`) killed by that test. | Done (verified) | S |
| SEC-C2 | Upload robustness | Content-Length is validated, then the **whole body is materialized** via `request.arrayBuffer()` before the real byte-cap check; a lying header can buffer oversized input into the 128 MB isolate until the runtime aborts. Nothing persists before the cap. TypeSafe: severity 3.0; orchestrator rates it hardening (1), availability blip only. | `src/worker.ts:2098-2104` | Enforce the cap while reading. **Done (verified)**: `readBoundedBytes(request, max)` in `requestGuard.ts` streams and stops pulling at the cap, cancels the stream, returns 413; `documentsUploadRoute` uses it instead of `arrayBuffer()`. Red test `caps a lying endless body with 413 instead of buffering it forever` hung to the 20s timeout before the fix, passes in ~25 ms after; Stryker on `requestGuard.ts`: zero survivors on the new lines (an exact-cap boundary test killed two survivors there). | Done (verified) | S |
| SEC-C3 | Negative control (clean) | Parameterized-SQL `${table}` interpolation � the table name iterates the hard-coded `['room_presence','waiting_peers']` array, never user input. TypeSafe: exploitable 0.10. | `src/lib/whiteboard/membership.ts:427,442` | None. Recorded as checked evidence. | Closed (clean) | � |
| SEC-C4 | Negative control (clean) | Open redirect via `/auth/access/logout?redirect=` � `safeRedirectPath` refuses absolute/protocol-relative/backslash/traversal targets; tested including `https://evil.example/steal`. TypeSafe: exploitable 0.13. | `src/lib/access/accessLogoutUrl.ts` + tests | None. Recorded as checked evidence. | Closed (clean) | � |
| PERF-S1 | Size / load | Dynamically import the LiveKit SDK + A/V UI so the ~1.8 MB chunk loads only when a call is requested, not on every room open. TypeSafe: impact 2.4/4, effort 1.4/4, worth-now 0.69. Orchestrator: confirmed best value-per-effort. | `RoomClient.tsx` static imports; `.next` chunk listing | Red/green dynamic import + class-contract test; AGENTS.md UX gate on room-open at 390x844 | Open | M |
| PERF-S2 | Size / load | Split the 2.9 MB Excalidraw fork chunk (per-tool dynamic imports, deferred non-core pieces). TypeSafe: impact 2.7/4, effort 2.4/4, worth-now 0.61. | `.next` chunk listing | Fold into the next pinned fork release batch � pairs with embedded-documents milestone 5 fork work | Open | L |
| PERF-S3 | Connectivity (rejected) | y-webrtc P2P board sync � **rejected by design**: board updates must keep flowing through the RoomDO, where authorization, persistence, snapshots and moderation live. TypeSafe concurred: impact 0.8/4, effort 3.7/4, worth-now 0.14. | spec/EMBEDDED_DOCUMENTS_SPEC.md �2 seam rationale | None � non-goal. Do not revisit without a security-design review | Closed (rejected) | � |
| PERF-S4 | Connectivity | LiveKit ICE/TURN reachability audit for restrictive school/cellular networks; extend call-panel diagnostics only if gaps are found. LiveKit Cloud provides managed TURN; the per-participant connection-quality badge already ships. TypeSafe: impact 2.7/4, effort overstated by the model (audit is the real work). | `UX_IMPROVEMENTS.md` connection-quality row; `ywebrtcProvider.ts` | Run the audit on a restrictive network; file findings as new IDs if any | Open | S |
| PERF-S5 | Latency | Preconnect/preload hints for the signaling websocket and LiveKit edge domains on the room page. TypeSafe: impact 1.4/4, effort 0.4/4, worth-now 0.65. | `ywebrtcProvider.ts` signaling path; room page head | Add the hints with a small structural test | Open | S |

Suggested order: PERF-S5 + PERF-S1 in one session, SEC-C1 + SEC-C2 as the next
security patch, PERF-S4's audit alongside, PERF-S2 batched with the next fork
release.

## General improvements - 2026-09-16 (TypeSafe-assisted sweep, second pass)

Same provenance rule as the section above: code inspection retrieves the
facts, TypeSafe (`jev-1.13.0`) scores impact/effort/worth-now, the orchestrator
verifies against the code before an ID is recorded. Facts checked this pass:
no service worker / web-app manifest exists anywhere in `src/` or `public/`;
CI already caches npm and Playwright browsers; SERVER_SIDE_BOARD_PLAN.md is a
shipped-state record; backup policy is the scheduled R2 export described in
SECURITY_BACKUP_RESTORE.md (BAK-01, done).

| ID | Area | Finding | Evidence | Recommended action | Status | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| BAK-01 | Durability | **Automated DO SQLite backup shipped and rehearsed (was: no automated backup existed).** Daily 03:00 UTC cron runs `runBackupCycle` (Worker `scheduled` → `src/lib/backup/backupCycle.ts`): IdentityDO registry (`backup_registry`) lists due targets (24h per-DO cadence, 90-day activity window reusing `ROOM_IDLE_TTL_MS`, limit 50), each due RoomDO exports its SQLite rows (`rooms` + `ROOM_SCOPED_TABLES`) via the internal `/room/backup/export` route, the dump lands in R2 `BOARD_FILES` at `backups/{doClass}/{doId}/{ISO timestamp}.json`, and completion is recorded via `/backup/mark-done`. Per-target failures are logged and skipped; `BACKUPS_ENABLED` is a fail-open kill switch. Restore is lossless (`serializeBackup`/`restoreBackup` in `src/lib/backup/backup.ts`); the rehearsal in `src/backup.workers.test.ts` replays a real R2 dump into a second RoomDO and asserts row parity for every backed-up table. Evidence: 49 unit tests (`src/lib/backup/backup.test.ts`, `src/lib/identity/backupRegistry.test.ts`), 7 cycle tests + 8 registry-route tests in the workers suite; Stryker 100% on `identityStore.ts:1119-1254` (68 mutants) and 99% on `backup.ts` (the single full-file-run survivor is a test-selection artifact — killed 3/3 when the line is mutated in isolation, and killed by manual application); targeted mutants killed for the due-window, mark-done, and public-route-refusal guards. RoomDO self-registers activity through `touchOwnerRoomActivity`; IdentityDO-class export is a registry-ready follow-up (cycle logs and skips it). Production wiring note: `[env.prod.triggers]` now carries both crons. | `src/lib/backup/`, `src/do/IdentityDO.ts` `/backup/*` routes, `src/do/RoomDO.ts` export route, `wrangler.toml` triggers, SECURITY_BACKUP_RESTORE.md | — | Done (verified) | M |
| OPS-01 | Observability | Internal errors go to DO console logs only (`logInternalRoomError`); a solo operator without a shell open sees nothing. TypeSafe: impact 2.1/4, effort 1.9/4, worth-now 0.76. | `src/lib/whiteboard/roomDb.ts` error paths; `logAuthEvent` is audit-only | Bounded error ring/table in RoomDO + IdentityDO surfaced as a recent-errors view on /admin (the page already exists) | Open | M |
| OFF-01 | Offline / mobile | **Offline shell shipped in the conservative scope (was: no service worker, manifest, or offline capability; a dropped school wifi took the whole board away mid-lesson).** `public/sw.js` (plain JS, no build step) caches only `/_next/static/` (content-hashed, immutable) cache-first into `static-v1`, serves navigations network-first with an inline self-contained fallback page on network failure only, and intercepts nothing else — API, `/signaling`, documents, board data and cross-origin CDN assets are network-only by omission, so board writes stay online-only with the existing sync-degraded banner. HTML is never cached; 4xx/5xx pass through untouched; versioned caches + `skipWaiting`-on-activate + old-cache cleanup. `public/manifest.webmanifest` (standalone, brand-paper `#faf7f0`, reuses `/logo.svg`). Registered production-only from the root layout via `ServiceWorkerRegistration` (guarded try/catch, boolean contract). Enabling guards in `src/lib/worker/requestGuard.ts`: GET/HEAD `/sw.js` + `/manifest.webmanifest` on teacher/guest hosts (fail-closed list would have 404'd both) and `worker-src 'self'` in the HTML CSP (the nonce'd + 'strict-dynamic' script-src otherwise refuses the nonce-less worker script per the worker-src → child-src → script-src fallback chain). Design note: `spec/OFFLINE_SHELL_DESIGN.md` (staleness hazards, inline-fallback rationale, kill-switch procedure, installability caveat: the wordmark SVG may not satisfy install-icon requirements — dedicated square icon is the follow-up). Evidence: red→green cycles with 17 new unit tests (`serviceWorkerContract.test.ts` pins the sw.js/manifest contract incl. "no `/api` literal, single lazy `cache.put` behind the ok guard"; `ServiceWorkerRegistration.test.tsx` pins the prod-only decision + guarded registration), 2 allowlist + 1 CSP tests in `requestGuard.test.ts` (171 scoped tests green); targeted mutants killed: allowlist branch, `worker-src 'self'`, production flag (each red on the intended assertion, reverted); scoped vitest + both tsconfigs green (typecheck errors present only in parallel implementers' in-flight `identityStore.test.ts`/`roomErrorRing.test.ts`, untouched by this task); `node scripts/run-e2e.mjs security-headers` green twice on the built Worker (4/4), whose wrangler access log shows `GET /sw.js 200 OK` three times — a CSP-refused fetch never reaches the server, so those 200s prove end-to-end that the registration is attempted, admitted by the CSP and served by the route allowlist; the run also caught a real production bug: passing `process.env` as a value survives to the browser as the empty process shim (registration silently never fired), fixed by reading `process.env.NODE_ENV` as a member expression so the build inlines the literal. TypeSafe: impact 2.7/4, effort 2.3/4, worth-now 0.57 — the model deferred it behind BAK-01/OPS-01 on effort/risk (service-worker cache staleness is a real foot-gun), and the orchestrator agrees. | `public/sw.js`, `public/manifest.webmanifest`, `src/components/ServiceWorkerRegistration.tsx` (+ tests, incl. `src/components/serviceWorkerContract.test.ts`), `src/app/layout.tsx`, `src/lib/worker/requestGuard.ts`, `spec/OFFLINE_SHELL_DESIGN.md` | Install prompt UI + a square maskable icon when install matters; OPS-01's error ring could surface registration failures later | Done (verified) | M |
| ADM-01 | Admin usability | /admin caps at the newest 200 accounts (43k+ in dev) with no pagination or display-name search. TypeSafe: impact 1.5/4, effort 1.6/4, worth-now 0.59. | `listAccountsForAdmin` cap; AdminUsersPanel | Cursor pagination + name search when production account volume makes the cap bite | Deferred | S |

Updated suggested order for the whole queue: SEC-C1 + SEC-C2 security patch,
then BAK-01, then OPS-01, then PERF-S5 + PERF-S1, then OFF-01/ADM-01 as
capacity allows; PERF-S2 stays batched with the next fork release.
