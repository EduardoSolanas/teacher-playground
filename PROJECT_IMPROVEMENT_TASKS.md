# Project review and implementation queue

Review date: 2026-09-04. Baseline: `037eab5` on the current checkout.

This is a repository-wide review of the application, Worker/DO boundaries, identity, storage, collaboration, A/V, UI, tests, build scripts, deployment workflows, and existing plans. It is not a line-by-line audit of the vendored Excalidraw fork or a production penetration test. Production configuration, live media, and deployed SHA were not verified. Existing untracked `fix.md` was read and preserved.

**Do not implement this entire file in one prompt.** Pick one task ID, read its current code, reproduce the issue, and make one verified change. Findings below distinguish directly observed code gaps from hypotheses needing a reproduction. No application fixes were made in this review.

## Baseline checks

- `npm test`: **114 files, 1,225 tests passed**.
- `npm run typecheck`: **passed** (both configurations).
- `npm run lint`: **passed**.
- Worker and E2E results: recorded in the final validation section below.
- Logs: `%TEMP%/teacher-project-review-20260904/`.

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

## Priority and order

| ID | Priority | Task | Size / owner | Dependency |
|---|---|---|---|---|
| R00 | P1 | Reproduce and resolve the failing Worker baseline | Investigation, then one cheaper-model slice per cause | None |
| R01 | P1 | Make deployment wait for the same revision's required checks | Medium, cheaper implementer after workflow choice | None |
| R02 | P1 | Preserve retryable account-erasure work | Design first, then small implementation slices | Orchestrator design |
| R03 | P1 | Schedule retention cleanup without connected sockets | Medium, cheaper implementer after reproduction | None |
| R04 | P1 | Verify and constrain ownership of shared call state | Reproduction first; security design stays with orchestrator | None |
| R05 | **DONE** | ~~Stop canceled A/V startup after token-body parsing~~ | Done 2026-09-05 | R09 still owed for real-media assertions |
| R06 | P2 | Bound limiter storage and align abuse-window semantics | Two separate medium slices | Orchestrator chooses policy |
| R07 | P2 | Bound aggregate room-file usage | Design first, then small slices | Orchestrator supplies quotas |
| R08 | P1 | Diagnose the six observed E2E failures, one case at a time | Small per failing case | Baseline first |
| R09 | P2 | Make real-media validation an explicit gate | Medium, infrastructure plus test slices | Local LiveKit availability |
| R10 | **DONE** | ~~Complete clear-dialog keyboard behavior~~ | Done 2026-09-05 | None |
| R11 | **DONE** | ~~Add an accessible label to the name field~~ | Done 2026-09-05 | None |
| R12 | **DONE** | ~~Handle unavailable offline storage gracefully~~ | Done 2026-09-05 (partial coverage) | None |
| R13 | **DONE** | ~~Refresh cached provider callbacks~~ | Done 2026-09-05 | None |
| R14 | **DONE** | ~~Tighten provider event types~~ | Done 2026-09-05 | None |
| R15 | **DONE** | ~~Preserve valid zero values in legacy element conversion~~ | Done 2026-09-05 | None |
| R16 | **DONE** | ~~Correct architecture and hostname documentation~~ | Done 2026-09-05 | None |
| R17 | P2 | Reconcile security release evidence | Orchestrator / operations | Relevant code tasks and staging access |

Begin with R00 to establish a trustworthy baseline, with R16 as quick context cleanup, then R01. Reproduce R02–R05 before allowing broader cleanup. R10/R11 are good initial tasks for evaluating a cheaper model. Do not give it a whole-file RoomDO or RoomClient refactor.

**Status 2026-09-05 (second batch).** R05, R12, R13 and R14 are also done.
Unit baseline is now 117 files / 1,252 tests, typecheck and lint clean. Note
that commit `f810dc7`, made by a concurrent session, swept up the then-uncommitted
R05 and R14 implementation work alongside its own R00/R08 changes — the code is
correct and present, but those two tasks are not attributable to a single commit.

Still outstanding across both batches: **R01, R02, R03, R04, R06, R07, R09, R17**,
plus R00/R08 finishing, plus the E2E pass owed by R10/R11.

**Status 2026-09-05 (first batch).** R10, R11, R15 and R16 are implemented and committed; see
the completion notes on each card. Unit baseline moved from 114 files / 1,225
tests to 116 files / 1,237 tests, all passing, with typecheck and lint clean.
E2E was **not** run for this batch — another session was concurrently editing
`tests/e2e/multi-peer.spec.ts`, `tests/e2e/whiteboard.spec.ts` and
`ExcalidrawWrapper.tsx` for R00/R08, so an E2E run could not have been
attributed to either batch. R10 and R11 are user-visible and still owe the E2E
pass that `AGENTS.md` requires; run it once the R00/R08 work settles.

## Task cards

### R00 — Establish why the Worker baseline fails

**Observed execution:** the full Worker run at the reviewed checkout produced 374 passing and 3 failing tests across 16 files. All failures were in `src/do/roomDO.workers.test.ts`:

- `signaling message rate limit > closes with 1008 when a granted owner exceeds the abuse ceiling in consecutive windows`: `socket was not closed`.
- `storing the room view > does not wipe the board when only the view is written`: `RangeError: Maximum call stack size exceeded`.
- `storing the room view > leaves the stored view alone when only the board is written`: the same RangeError during session bootstrap.

The log also points into `@cloudflare/vitest-pool-workers/dist/worker/lib/cloudflare/test-internal.mjs:320`. These are observed failures, not established application root causes. This run overlapped an E2E build attempt; establish a sequential clean baseline before attributing failures to code.

**Scope:** first run `npm run build`, then `npm run test:workers -- src/do/roomDO.workers.test.ts`, then the full Worker suite with no other build/test processes in that worktree. Preserve failure output. Inspect test mutation/restoration, resource cleanup, and the abuse-window timing separately. If it reproduces, keep the existing red and delegate only its bounded cause. Do not patch node_modules, loosen abuse assertions, or upgrade the test runtime speculatively.

**Done:** a documented cause with a focused failing-before/passing-after result and a passing full suite, or an explicit environment/reproduction blocker. A focused rerun passing does not erase the failed full baseline.

**Review follow-up:** after E2E stopped, `npm run test:workers -- src/do/roomDO.workers.test.ts -t 'signaling message rate limit|storing the room view'` passed **8 tests**, with **156 intentionally unselected**. No code changed between runs. The complete failing file/full-suite interaction still needs investigation; the filter passing does not establish a clean full baseline.

### R01 — Deployment must depend on successful checks for its exact SHA

**Observed:** `.github/workflows/deploy-cloudflare.yml` starts on `push: main` independently of `.github/workflows/ci.yml`. It runs typecheck/unit/build/Worker checks, but E2E is commented out and there is no dependency on CI E2E, lint, or dependency-audit outcomes. A successful deployment job is therefore not evidence that all required CI jobs passed. Branch protection and environment rules were not inspected.

**Scope:** the two workflow files and `src/deployment/deploymentPolicy.test.ts`. Orchestrator chooses a minimal same-workflow prerequisite or exact-SHA CI completion gate. Do not deploy a newer branch head after validating an older SHA.

**First red:** a policy test rejects a deploy path that can reach Wrangler without required successful checks for the deployed revision. Add negative cases for failed checks and mismatched SHA; use real workflow content, not a fake workflow fixture that only mirrors the desired implementation.

**Done:** a failed required gate blocks deploy, the deployment records its SHA, and a controlled workflow run confirms ordering. Do not restore the old commented `continue-on-error` E2E step. Record any GitHub configuration verification that remains external.

### R02 — Account erasure needs durable progress before identity cleanup

**Observed:** `src/worker.ts:551-613` calls IdentityDO account deletion first, then forwards room erasures without checking each response's `ok`. `src/lib/identity/sessionStore.ts` → `eraseOwnAccount` deletes `account_rooms` and disables the account before downstream room/R2 cleanup. A malformed IdentityDO response also becomes an empty room list. Code has no durable cleanup job here. The happy-path Worker tests do not establish recovery after a partial downstream failure.

**Risk to reproduce:** a room returns an error, or R2 cleanup fails after identity erasure; cleanup targets and the user's ability to retry can be lost. Separately establish whether membership in rooms owned by others is included: the fan-out currently starts from `listOwnedRooms`.

**Scope:** `src/worker.ts`, `src/do/IdentityDO.ts`, identity/session store, and existing account-erasure Worker tests. **Stronger model must decide the minimal persisted cleanup/progress protocol.** Do not let a cheaper model invent a distributed transaction or undo session revocation to make retries work.

**First deliverable:** reproduce one failed downstream cleanup with real workerd objects and durable state, and document returned HTTP status plus what cleanup information survives. Design the failure induction without replacing fetch/DO methods with doubles. If no faithful failure mechanism is available, report that test constraint before implementation.

**Slices after design:** persist cleanup targets; perform/check one cleanup operation; retain/retry pending work; verify final success only after required cleanup. Each is a separate red/green cycle. Include account isolation, restart, idempotency, and negative authorization tests. Never claim legal compliance from these tests alone.

### R03 — Retention must continue after the last connection disappears

**Observed:** `src/do/RoomDO.ts:1590-1641` deletes the consumed alarm, sweeps once, then returns when no sockets remain, unless dirty-document retries scheduled another alarm. `roomSchema.ts` defines a 90-day room TTL and 365-day tombstone TTL. Existing idle-purge coverage in `src/do/roomDelete.workers.test.ts:468` manually ages the row and invokes `alarm()`; it does not prove that a future alarm is scheduled for a clean disconnected room.

**Scope:** RoomDO alarm scheduling, room lifecycle constants, `roomDelete.workers.test.ts`. Do not change retention durations.

**First red:** create a real room, close its last socket, flush pending board state, run the scheduled alarm, then assert a future retention deadline remains scheduled while retained data requires cleanup. Exercise a room created without a signaling connection too.

**Done:** cleanup runs without another visitor; board chunks and applicable R2 files are removed, tombstones retain their intended lifespan, and clean empty objects do not spin frequent alarms. Test scheduling separately from execution. Review failure retry behavior for R2 deletion without combining an unrelated lifecycle rewrite.

### R04 — Shared call state needs a verified author and lifecycle

**Observed:** `src/app/whiteboard/[roomId]/RoomClient.tsx:274-309` uses persisted `yDoc.getMap('call').active` and makes non-host peers follow it whenever a host is present. Normal unmount clears it and `hasHost` gates joining. However, `serverSync.ts` applies admitted writers' Yjs updates generally; the call flag itself carries no verified host identity. This is a code-level trust concern, not a confirmed browser exploit from this review.

**First deliverable:** through real sockets, test whether an admitted non-owner can change that map and cause another admitted peer to enter a call while the owner is present. Also close/crash the host browser without graceful cleanup and reopen the room; test whether stale call intent returns. Assert actual join/media behavior, not merely the map value.

**Scope:** RoomClient call-state effect, server sync/control-message boundary, real collaboration/A/V E2E. The orchestrator must choose verified host signaling and decide whether peers explicitly accept each call; a cheaper model must not silently redesign consent or authorization. Browser permissions still apply; do not describe this as bypassing browser permission prompts.

**Done after design:** non-owners cannot impersonate a host's start/end event, crashes do not resurrect previous calls, and legitimate host start/end works. Mutation-test the chosen ownership guard. Keep unrelated board edits working.

**Design settled 2026-09-05 (orchestrator + owner). Not yet implemented.**

*Product decision, from the owner:* peers **auto-join, with no explicit accept
step**. A host starts a call and everyone in the room joins, including someone
who arrives later. That works only because `call.active` is durable in the
Y.Doc: `shouldPeerEnterCall` is `callActive && hasHost && avAllowed`, and the
effect calls `syncCall()` on mount as well as on observe, so a late joiner syncs
the doc, reads the flag and enters.

*Correction to an earlier suggestion in this session:* do **not** gate the call
map the way `follow` is gated at `RoomDO.ts:1869`. `follow` is a transient
control message — relayed to whoever is connected, then gone. Making call start
transient and owner-only would stop late joiners auto-connecting, which is the
behaviour the owner wants to keep. Read and write must be split instead.

*The gap, precisely.* Two control messages travel the same socket and are
treated differently. `follow` is authorization-gated (`isOwnerRole(role)`, i.e.
`role === 'owner'`). Call state rides as an ordinary Yjs sync frame, so the only
check it meets is `canWriteBoard(role)` — `role === 'owner' || role === 'editor'`.
**Any admitted editor can therefore start a call for the whole room.** Supporting
evidence: `handleStartCall` does not check `isLocalHost` while `handleEndCall`
does, so the intent was host-only and the enforcement was never written.

*Design to implement:*

1. Keep `call.active` durable. Late joiners must read it.
2. Restrict **writes** to that key to `isOwnerRole`, enforced server-side in
   RoomDO. Board edits stay open to editors. This is harder than gating `follow`
   because it means inspecting a Yjs update for *which key changed* rather than
   accepting or rejecting a whole frame — size this as a medium slice, not small.
3. Stamp the flag with the setting host's identity and a timestamp, and have
   peers ignore it when that host is no longer present. Chosen over clearing the
   flag when the last owner socket closes, because a host reloading mid-lesson
   is normal and must not drop the room's call.

*Still required before implementation:* the reproduction this card already
specifies — an admitted non-owner writes the map through real sockets, asserting
actual join/media behaviour rather than the map value, plus the host-crash
resurrection case. Security implementation stays with the orchestrator; a
cheaper model must not silently redesign this.

### R05 — Recheck cancellation after asynchronous token parsing

**Observed:** `src/hooks/useAvSession.ts:115` checks cancellation after fetch, then awaits `response.json()` at line 133 and constructs/publishes a provider without another cancellation check. Disabling or changing rooms while the body is arriving can start an obsolete session. The 403 body path has the same stale-state window. Current tests patch fetch and provider methods, contrary to the real-object rule.

**Scope:** useAvSession and its real-service browser tests. No general hook rewrite.

**First red:** serve a real token response whose body completes after the hook is disabled/unmounted or switches rooms; assert the old startup never establishes media and never replaces new-room state. Use a controllable real HTTP server, not route fulfillment or mocked fetch. Start with one cancellation path.

**Done:** cancellation is checked after asynchronous boundaries before side effects; abandoned owned sessions are torn down. Test a successful ordinary join as well. Do not log tokens or server URLs with credentials.

**DONE 2026-09-05.** `useAvSession` now re-checks `cancelled` after
`await response.json()` on both the success path and the 403 path, before any
`setState` and before the provider is constructed. The pre-existing check after
`session.join` is unchanged.

Two of this card's requirements were **not** met, and neither is an effort
problem:

- *"Use a controllable real HTTP server, not route fulfillment or mocked fetch."*
  Not possible at unit level, and this was measured rather than assumed:
  `ajaxFetch` passes the relative `input` to `fetch` (it resolves `target` only
  for its origin check), and Node's fetch rejects a relative URL with
  "Failed to parse URL" before any HTTP layer exists. A real `http.Server` is
  reachable from this environment on an **absolute** URL, so the single blocker
  is `ajaxFetch.ts:16`. nock and msw do not help: there is no request to
  intercept. **Follow-up worth filing:** make `ajaxFetch` fetch the `target` it
  already computed — the origin it validates and the origin it requests can
  currently differ — after which this test can use a real server with no new
  dependency.
- *"Current tests patch fetch and provider methods, contrary to the real-object
  rule."* Half fixed. The two tests covering the actual bug use a real
  `Response` over a real `ReadableStream` and never construct a provider. The
  two that need a provider still patch `LiveKitProvider.prototype.connect` /
  `disconnect`, because a real `connect()` opens a real socket to the media
  server. That is **R09's** dependency, exactly as this card's dependency column
  predicted.

### R06 — Bound limiter memory; separately clarify abuse windows

**Observed:** `src/lib/http/rateLimit.ts:31-59` retains a Map entry for every key ever seen; only the currently requested key's timestamps are filtered. Signaling also uses `countRejected`, retaining each attempt in the active window. RoomDO combines that sliding count with `Math.floor(Date.now()/windowMs)` to count consecutive calendar-window breaches (`RoomDO.ts:1787-1812`). A single burst crossing a calendar boundary can be counted as sustained across two windows.

**Slice A, first red:** use the real limiter across expired unique keys and establish a bounded-storage acceptance metric chosen by the orchestrator. Add bounded expiry cleanup without evicting active protection in a way that permits bypass. Preserve all existing rate-limit behavior; test normal school-NAT sharing and rejected requests.

**Slice B, first red:** send a real finite burst across a calendar boundary and distinguish it from continued abusive traffic under the agreed policy. Do not raise limits or stop counting rejected frames as an unreviewed shortcut. Keep sync frames lossless and awareness sheddable. Scope: limiter/budget modules, RoomDO, corresponding unit/Worker tests. Mutation-test any changed guard.

### R07 — File limits should bound total usage, not just one object

**Observed:** `src/worker.ts:1048-1101` authorizes a writer and caps each stored file at 25 MiB; this path has no room byte/count reservation or upload-specific rate cap. R2 orphan sweeps help eventual cleanup but do not cap a live room full of referenced files. This is a resource-policy gap, not measured production abuse.

**Design input required:** orchestrator specifies room/account count and byte limits and whether replacements count incrementally. Do not invent billing tiers.

**Scope after design:** file upload authorization, RoomDO metadata/reservations, board-file Worker/E2E tests. First red should exercise two real competing uploads near one selected quota and prove the boundary cannot be exceeded; then separately test failed uploads releasing reservations and deletion freeing quota. Validate declared size, actual size, and interrupted upload behavior. Keep streaming and do not load full uploads into Worker memory. Mutate the quota guard.

### R08 — Turn E2E flake work into measured, isolated tasks

**Observed full-run failures (151 passed, 6 failed):** use these as individual starting slices before searching for hypothetical flakes.

| Spec / line | Case | Actual failed assertion |
|---|---|---|
| `multi-peer.spec.ts:76` | recovers a Yjs update that signaling sheds | At line 164 the probe was relayed (`true`), but the test expected `false`. It sends legacy JSON publish messages to force shedding; reconcile this setup with the current awareness-only shedding contract. Do not reintroduce lossy sync to satisfy the old premise. |
| `whiteboard.spec.ts:538` | page refresh preserves whiteboard state | Local elements were already zero at line 550, before reload/persistence verification. |
| `whiteboard.spec.ts:1224` | a long curve and a line reach a late peer whole | Author's maximum freedraw point count was zero instead of greater than 200, before the late peer joined. |
| `whiteboard.spec.ts:1279` | a very long spiral, ten short strokes and a line reach a late peer whole | Author's maximum freedraw point count was zero instead of greater than 2,000, before late-peer convergence. The failure screenshot shows a blank board. |
| `whiteboard.spec.ts:1404` | rapid tool switching doesn't lose elements | Local element count was zero at line 1436. |
| `whiteboard.spec.ts:1511` | drawing while provider is still connecting still works | Local element count was zero at line 1521, before waiting for provider connection. |

For the five zero-element cases, inspect real-pointer placement, active-tool selection, canvas readiness, and local scene/store synchronization before changing the network protocol. Do not infer that reload or late joining lost data from a failure that occurred before those actions. These may share a cause, but that has not been proven.

**Observed:** `tests/e2e/collaboration.spec.ts` still contains many fixed setup waits; `tests/e2e/cursor-signaling.spec.ts:30-51` sleeps before measuring and describes a former 60-message server cap. Its tighter 60-message client budget may still be intentional; do not simply raise the assertion to 120. Some waits intentionally prove stability and should remain.

**Scope:** one reproduced failure in one spec at a time; reuse `scripts/e2e-flake-baseline.mjs` after inspecting its supported arguments. Existing long/short real-pointer and late-peer tests are valuable and should remain.

**First deliverable:** ten-run baseline at a fixed SHA with retries disabled, exact failing assertions, traces, worker count, and environment. Then select a demonstrated race and await its observable condition with retrying assertions. Keep the sequential guest-draw-then-teacher-draw path and assertions during strokes, not only final state.

**Done:** ten consecutive passes for the repaired spec, full E2E result recorded, no timeout-based sampled-state assertion substituted for polling, no retries or weakened performance bounds presented as a fix. For the diagnostic run enable trace retention on failure: the current `on-first-retry` trace setting will not capture a first-attempt failure when retries are disabled. A green baseline produces evidence, not an invented bug fix.

### R09 — Separate real-media validation from optional-media smoke tests

**Observed:** `tests/e2e/voice-calling.spec.ts:42,79,115` skips on 503; CI supplies no explicit LiveKit test service. `useAvSession.test.tsx` stubs fetch and patches provider connect/disconnect. A green default suite does not establish actual media join, teardown, or moderation. `waitForJoinedCall` currently checks visible controls rather than a joined connection.

**Scope:** one local real-LiveKit test profile, its runner configuration, then one media scenario per slice. Keep the useful unconfigured-state smoke coverage. Do not use production classroom rooms or publish secrets.

**First red:** in the dedicated media profile, missing service configuration is a failure rather than a skip. With a real local service, assert joined state and actual track lifecycle, then hang up and verify tracks stop. Subsequent slices cover rename without reconnect, failed join cleanup, and moderation disconnect. Replace only the fake-based coverage relevant to each slice, not all tests at once.

**Done:** separate reports identify executed and skipped media cases; the mandatory media profile has no silent skips. A visible button alone is not evidence of an active call. Record environment limitations honestly.

### R10 — Make the destructive clear dialog keyboard-accessible

**Observed:** `src/components/whiteboard/ClearBoardModal.tsx` renders generic divs without dialog semantics, accessible title binding, Escape handling, focus containment, or focus restoration. It is used by RoomClient.

**Scope:** this component and a focused UI/E2E test, plus the trigger only if focus restoration needs it. Use existing platform facilities before adding a dependency.

**First red:** open with the keyboard, locate a named dialog, verify focus starts on the safe action, Tab/Shift+Tab cannot reach the board behind it, Escape cancels, and focus returns to the trigger. Implement one behavior per cycle.

**Done:** mouse/backdrop behavior still works; cancel never clears the board; confirm clears exactly once. Test with real browser keyboard input.

**DONE 2026-09-05.** `ClearBoardModal.tsx` now uses the ARIA dialog pattern
(`role="dialog"`, `aria-modal`, `aria-labelledby` bound to the existing `<h3>`),
focus starts on Cancel, Escape cancels, Tab/Shift+Tab wrap between the two
buttons, and focus is restored to the trigger on close. New
`ClearBoardModal.test.tsx`: 8 tests, real `@testing-library/react` rendering and
real keyboard events.

Native `<dialog>`/`showModal()` was rejected deliberately: jsdom 29 in this repo
does not implement it, so the behavior would not have been unit-testable. No new
dependency was added.

Two defects were found *during* review of the first implementation and fixed in
their own red/green cycles:

- The keydown listener was bound to the dialog element rather than `document`.
  Clicking the dialog's explanatory text is not a focusable target, so focus fell
  to the body and the listener never saw the keydown — Escape silently stopped
  working on a destructive confirmation.
- Tab from outside the dialog escaped the trap entirely. Focus that has already
  escaped is now pulled back to Cancel.

Not done: the real-browser E2E pass. See the status note under "Priority and order".

### R11 — Give the join-name input a persistent accessible label

**Observed:** `src/components/whiteboard/UserNamePrompt.tsx:71-80` has only a placeholder and test ID, with no associated label. This is independent of guest PIN or authorization behavior.

**Scope:** UserNamePrompt and its focused test/browser join assertion.

**First red:** find the textbox using its intended accessible name rather than a test ID and submit a valid name. Add a real associated label, preserving current layout and Enter submission. Do not change validation rules or identity storage in this slice.

**DONE 2026-09-05.** The input in `UserNamePrompt.tsx` is wrapped in a `<label>`
carrying a visible "Your name" span, so it has a persistent accessible name
rather than a placeholder that vanishes on first keystroke. Implicit
(wrapping) association was used rather than `htmlFor`/`id` — no generated id to
keep unique. The existing `field-block` and `app-label` classes in
`public/brand.css` were reused, so the layout is unchanged and no CSS was added.

New `UserNamePrompt.test.tsx` finds the field by accessible name
(`getByRole('textbox', { name: /your name/i })`), not by test id, and asserts
the trimmed name reaches `onJoin`. All `data-testid` attributes, validation,
trim, Enter submission, `autoFocus`, identity storage and colour logic are
unchanged.

Not done: the real-browser E2E pass. See the status note under "Priority and order".

### R12 — Offline storage failures must not break room startup

**Observed:** `persistence.ts:58-73` performs unguarded storage writes in an async function; its debounced callback does not catch the returned rejection. `cleanupStaleRooms:173` directly accesses localStorage outside a try/catch, unlike the opt-in reads. `usePersistence` calls cleanup on mount. Most users have caching disabled, so write failures require an opted-in room.

**Scope:** persistence module and real-browser storage tests. First test a document origin where storage is actually unavailable, then separately a browser filled to its real storage quota. Do not monkey-patch localStorage methods to throw.

**Done:** room startup remains usable and cache failure creates no unhandled rejection; no fallback silently persists board content without opt-in. Keep this separate from cross-room debounce redesign. The hook's one-time load flag/global debounce merit a future reproduction only if simultaneous room instances become supported.

**DONE 2026-09-05, with coverage stated honestly.** `saveBoardState` guards its
writes, the debounce no longer drops a rejection on the floor, and
`cleanupStaleRooms` guards storage enumeration so an origin without storage
cannot take room startup down from `usePersistence`'s mount.

The enumeration guard is deliberately narrow rather than a try/catch around the
whole sweep: the clears already guard themselves, and a blanket wrap would hide
a mid-sweep failure and leave the remaining rooms unswept in silence.

**Only the quota path is proven.** It fills jsdom's real 5,000,000-code-unit
store rather than patching `setItem`. A trap worth recording: filling with one
chunk size leaves a chunk-sized gap that the small board-state JSON slips into,
and the first version of this test passed against the *unfixed* code because of
it. It now packs storage with decreasing chunk sizes and fails without the fix.

**Not proven, left as defensive:** the enumeration guard and the debounce
backstop. jsdom cannot make the `localStorage` getter throw without patching it,
which this card forbids. A genuinely storage-less origin is browser-profile
work and belongs with E2E, not here.

Opt-in behaviour is unchanged and asserted: a storage failure must never begin
caching board content for a room that did not opt in.

### R13 — A provider cache hit must not retain obsolete callbacks

**Observed:** `yWebsocketProvider.ts:110-119` returns the cached entry for the same document before registering the newly supplied `onPresence`/`onFollow` callbacks. Existing handlers close over the callbacks from initial creation. Whether current mounting behavior triggers user-visible stale state needs reproduction.

**Scope:** provider factory and its existing collaboration/provider tests.

**First red:** use a real provider/document and real socket server; call the factory again for the same room/document with updated consumers, send a presence/follow frame, and assert delivery follows the explicitly chosen current-consumer contract. Check call sites before choosing replacement versus subscription semantics.

**Done:** intended consumers receive messages once, destroyed consumers do not, document identity safety stays intact, and repeated calls do not create duplicate sockets. If multiple consumers are unsupported, document and enforce that contract rather than introducing a general event bus.

**DONE 2026-09-05.** Handler registration moved into one function called from
both the create path and the cache-hit path.

**Contract chosen: replacement — the latest caller's callbacks win.**
`messageHandlers[type] = ...` was always a single slot rather than a list, and
`collaboration.ts:56` is the only call site, so single-consumer was already the
real contract; it is now explicit instead of accidental. Passing `undefined`
clears the slot rather than leaving a destroyed consumer wired. No event bus and
no subscription list were added, per this card. The doc-identity check is
untouched and its existing tests were not modified.

### R14 — Narrow the remaining provider event/decoder types

**Observed:** a `WhiteboardProvider` interface already exists, so the old `fix.md` request to create one is obsolete. Its event names and callback arguments remain `string`/`any[]`, and message decoders are `any` (`yWebsocketProvider.ts:32-38`).

**Scope:** only this interface and direct consumer annotations. First add compile-time negative cases for misspelled event names/wrong payloads, following the existing type-test conventions. Use actual installed upstream decoder/event types where available. Run typecheck and behavior suites; do not broadly replace Yjs serialization types or add runtime wrappers solely for typing.

**DONE 2026-09-05.** `on` and `off` take a union of the three events the
provider actually emits (`status`, `synced`, `connection-close`) with a payload
type each; `messageHandlers` uses lib0's real `Decoder` and `Encoder` rather
than `any`. Compile-time only — no runtime wrappers.

The first version of these tests **could not fail**: the compile-time checks sat
inside `if (false)`, which left vitest with no runtime test in the file and
failed the suite, and the patch for that was four `expect(true).toBe(true)`
cases. Replaced with two layers — uncalled but typechecked functions whose
`@ts-expect-error` directives become TS2578 errors if the union goes loose, and
a runtime test that reads the interface via the TypeScript compiler API, in the
idiom `ExcalidrawWrapper.types.test.ts` already uses.

Mutation-verified: widening `on` back to `(eventName: string, callback:
(...args: any[]) => void)` fails the runtime assertion and produces three TS2578
errors.

### R15 — Verify lossless legacy element conversion before type cleanup

**Observed:** `yjsDoc.ts:30,44` defaults `strokeWidth` and `borderRadius` with `||`, so zero becomes 2 or 4. `CanvasElement` also defines `underline`, which this conversion does not write. These are direct conversion discrepancies; the primary Excalidraw path uses other serialization logic, so first verify which consumers still call this helper before assigning user-facing severity.

**Scope:** `addElementToArray`, the matching reader, and `yjsDoc.test.ts` (or its existing owning suite). First red: round-trip a real supported rectangle with zero stroke width, then a sticky note with square corners; add underline as a separate behavior if the path supports text. Use real Y.Doc/Y.Map objects. Do not attempt every `any` in the file or change the Excalidraw schema.

**DONE 2026-09-05 — and the severity check the card asked for came back low.**
`addElementToArray` is reachable only through `collaboration.addElement`, which
`useCollaboration.ts` does not expose and `RoomClient` never calls. The live
Excalidraw path goes through `replaceSharedElements`, which uses `cloneForYjs`
and never had this bug. So this was a latent defect in an exported helper, not a
user-facing data-loss bug — do not report it as one.

Fixed anyway, since it is cheap and the helper is public API: every default in
`addElementToArray` now uses `??` instead of `||`, so a default applies only to
a missing field. The default *values* are unchanged — only when they apply.
`underline` (declared on `CanvasElement` but never written by this function) is
now written. Three tests added to `yjsDoc.test.ts` using real `Y.Doc`/`Y.Map`
objects: a rectangle with `strokeWidth: 0`, a sticky note with `borderRadius: 0`,
and text with `underline: true`.

`points`/`encodePoints`, the `rotation` branch, `replaceSharedElements`,
`getElementsFromArray` and the `any` casts were left alone.

### R16 — Make the documentation agree with the code

**Observed:** README says RoomDO has no server Y.Doc and signaling is capped at 60; current `getRoomDoc`/`serverSync.ts` and `signalingBudget.ts` contradict both. The Access comment in `wrangler.toml` names `playground...` as the protected hostname while `TEACHER_HOSTNAME` is `app-playground...` and the former is marketing. Old `fix.md` items duplicate implemented fixes.

**Scope:** README and inaccurate comments in wrangler configuration/provider docs. Preserve the untracked `fix.md`; describe superseded items here instead of modifying someone else's notes. No configuration values or runtime behavior changes.

**Done:** document server authority, the actual signaling policy, the three-host mapping, and correct local commands by tracing current code. Cross-check URLs and examples against configuration. Do not remove periodic resync or other compatibility workarounds merely because an old explanation is wrong. Documentation review is sufficient; do not add brittle prose snapshot tests.

**DONE 2026-09-05.** One finding was worse than this card recorded. The
`wrangler.toml` Access comment did not merely name the wrong hostname — it
contradicted another comment fifteen lines below it in the same file. It told an
operator to put Cloudflare Access in front of `playground.sen-tutor.co.uk`,
which the later comment correctly identifies as the public landing page that no
Access application may cover. Following it would have put a login in front of
the marketing site and left the teacher app unprotected. The comment now names
`app-playground.sen-tutor.co.uk` (the `TEACHER_HOSTNAME` in `[vars]`), and
"Both hostnames" is corrected to three.

README changes:

- The "blind relay … keeps no server-side Y.Doc" paragraph was false. It now
  describes `getRoomDoc` (per-room server Y.Doc, rehydrated from a snapshot or
  seeded from the SQL `elements` row) and `handleSyncFrame`, including why the
  server answers sync step 1 with its own step 1 as well as the diff.
- The periodic resync paragraph was **kept**, with an explicit note not to remove
  it just because the premise above it was wrong — removing it needs a
  convergence test, per this card's instruction.
- Signaling: "capped at 60 … closes the socket with 1008 above that" replaced
  with the real policy — budget 120 (`SIGNALING_MAX_MESSAGES_PER_WINDOW` in
  `requestGuard.ts`, mirrored as `SIGNALING_BUDGET`), awareness frames shed on
  breach, sync frames never shed, 1008 only at the 360 ceiling sustained across
  two consecutive windows. The `cursorPublishDelay` throttling warning is kept
  and the 64 msg/sec anecdote is now marked as history against the old budget.
- Added a three-hostname mapping table (teacher / guest / marketing, with which
  one Access covers and why a wildcard breaks two surfaces) and `npm run test:e2e`
  to Scripts, with the `scripts/run-e2e.mjs` requirement from `AGENTS.md`.

No configuration values or runtime behavior changed. `fix.md` was not modified.
No prose snapshot tests were added.

### R17 — Reconcile release evidence without checking boxes from inference

**Observed:** `security.md` still has open Phase 1/Phase 6 operational gates and future product phases. Some source-level protections now exist (for example `workers_dev = false` and `preview_urls = false`) while checklist completion also requires external verification. The document mixes security release evidence and long-term commercial/product plans.

**Scope:** orchestrator reviews existing evidence and staging configuration; a cheap worker may gather read-only file/commit references. No automatic changes to checkboxes or cloud settings.

**Deliverables:** one row per genuinely open release gate with owner, required evidence, and next bounded action. Check Access host coverage and alternate origins, staging login/authorization matrix, deployment SHA, recovery drill, and penetration-test scope. Keep billing, recording, imports, and new classroom features deferred pending product decisions. Do not start those features merely because they are unchecked.

## Already present: do not recreate these from old notes

- Sync frames are no longer intentionally shed by `decideSignalingAction`; normal budget is 120 and awareness is the shed class.
- Presence 5xx maps to an error/degraded path; RoomDO fetch has a top-level error response boundary.
- useAvSession memoizes its result/actions, stores Room in state, and excludes display-name changes from the connection effect.
- ParticipantTile prefers live subscribed screen-share tracks and uses the LiveKit rendering path.
- Provider interface and numeric invariant tests already exist.
- Long/short real-pointer strokes and late-peer collaboration regressions exist in recent commits.
- Security headers, authorization tests, dependency audits, secret scanning, R2 cleanup paths, and server document persistence are substantial existing protections. Improve specific gaps; do not replace the architecture wholesale.

These are source-confirmed observations, not a claim that every edge case or deployed version is verified.

## Final validation and handoff

| Check | Actual outcome |
|---|---|
| Unit | 114 files / 1,225 tests passed; `unit.log` |
| Typecheck | Passed both configurations |
| Lint | Passed; `lint.log` |
| Full Worker suite | 15 files passed, 1 failed; 374 tests passed, 3 failed; `workers.log` |
| Focused Worker follow-up | 8 passed, 156 unselected; `workers-focused.log`; does not supersede the full-run failure |
| Initial E2E attempt | Build failed with Windows `EBUSY` on `out` while this review's Worker run was active; no E2E assertions ran; `e2e.log` |
| Sequential E2E retry | Build succeeded; all 157 tests ran, 151 passed / 6 failed in 6.3 minutes; `e2e-retry.log` |

The E2E run used the existing local configuration, two workers, and its existing environment. Although no media cases were reported skipped in this run, a separately controlled local media service/track-level verification was not established by this review. Do not infer the proposed dedicated media gate is already satisfied.

Review artifact handoff: only `PROJECT_IMPROVEMENT_TASKS.md` was added; existing `fix.md` was preserved. No application code, security checkbox, deployment, or cloud setting was changed. The document is handed off uncommitted because the full validation baseline is not green. No task above is marked implemented or approved. Logs are under `%TEMP%/teacher-project-review-20260904/`; browser screenshots, videos, and report remain in the usual ignored `test-results/` and `playwright-report/` directories. Test totals are observed locally, not production evidence.
