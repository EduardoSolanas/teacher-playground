# Agent instructions

This file is mandatory for every implementation and verification pass in this
repository. Do not skip tests to save time.

## Commands

| Command | What it covers |
| --- | --- |
| `npm test` | Vitest unit tests (`src/**/*.test.ts`, jsdom) |
| `npm run test:workers` | Real workerd / Durable Object tests (`*.workers.test.ts`) |
| `npm run typecheck` | Both `tsconfig.json` and `tsconfig.worker.json` |
| `npm run test:e2e` | Playwright against a local Worker + Access issuer |

Run unit, workers, and typecheck for every behavior change. Run e2e whenever
the change can be reached from the browser, an HTTP route, a cookie/session,
or a WebSocket. Do not claim a `security.md` task complete without the e2e
that task names.

Never invent a Playwright config that skips `scripts/run-e2e.mjs`. That script
allocates ports and the local Access issuer; `playwright.config.ts` will throw
without `E2E_PORT` / `E2E_ACCESS_ISSUER` / `E2E_ACCESS_TOKEN`.

## Strict TDD

Red → green → refactor. No production code before a failing test.

1. **Red.** Write or extend a test that describes the next behavior. Run it.
   It must fail for the right reason (assertion or missing symbol), not because
   of a syntax error in the test.
2. **Green.** Write the smallest change that makes that test pass. Do not
   implement extra branches, routes, or UI in the same step.
3. **Refactor.** Only after green. Keep tests green.

Rules:

- One behavior per red/green cycle.
- If you already wrote implementation first, delete or revert it, write the
  failing test, then re-introduce the code. Do not “add tests after.”
- Bug fixes start with a test that reproduces the bug.
- Security and authorization changes need a negative test (wrong role, missing
  session, forged `peerId`, mixed settings on the scene route, etc.) in red
  before the guard exists.
- Prefer `src/do/*.workers.test.ts` for Durable Object / Worker behavior and
  `tests/e2e/*.spec.ts` for the real browser path. Unit tests are for pure
  modules (`membership.ts`, `requestGuard.ts`, schemas).

## E2E

After green unit/worker tests, run `npm run test:e2e` for user-visible or
HTTP/session work. If a run is too slow for every micro-cycle, still run it
before handing a task to a verifier and before checking a `security.md` box.

Relevant specs live in `tests/e2e/` (`room-authorization.spec.ts`,
`access-session.spec.ts`, `waiting-room.spec.ts`, collaboration specs). Add or
extend a spec in the red step when the behavior is “a teacher/student can … in
the browser.”

A verifier that did not see e2e output must not `APPROVE` a Phase 2 gate item
that names an E2E flow.

Never assert on state sampled once after `page.waitForTimeout(...)`. Playwright's
`expect(locator)` assertions retry, but a value pulled out of `page.evaluate`
does not, so a fixed sleep turns into a flake the moment CI is slower than the
dev machine. Poll instead — `expect.poll`, or the `waitForSync` helper in
`whiteboard.spec.ts`. Keep a short sleep only to prove something *stays* true
(that a cleared board is still clear), not to wait for it to become true.

Peer ids change when presence re-mints them, so a peer id captured before
admission may not identify that peer afterwards. Re-resolve the row rather than
reusing an id across an admission or suspend boundary.

## Mutation testing

This repo treats mutation testing as proof that a test would fail if the guard
were removed. Automated Stryker is optional; **targeted mutants are required**
for authorization, origin/CSRF, session, and request-boundary checks.

For each new or changed guard:

1. Leave the tests as they are (green).
2. Temporarily invert, delete, or weaken **one** check (one `if`, one
   `searchParams.set` overwrite, one role comparison).
3. Re-run the tests that should protect that check (`npm test` and/or
   `npm run test:workers`).
4. **The suite must fail.** If it still passes, the tests are too weak: add a
   test that fails under that mutant, restore the mutant, go back to TDD red.
5. Revert the mutant. Confirm green again.
6. Record in the task summary which mutant was killed (file, line, what you
   changed, which test failed). `security.md` evidence should say
   “mutation-tested” only when this was done.

Do not mutation-test formatting, TypeScript types, or test-only helpers.
Mutate one guard at a time so the failing test is attributable.

If you add `@stryker-mutator` later, keep mutating `src/lib/**/*.ts` that have
unit tests; do not point Stryker at `*.workers.test.ts` (those need workerd).

## Commits

Commit at clean checkpoints, not at the end of a long session. A checkpoint is
clean when all of the following hold:

- The current red/green/refactor slice is finished — one coherent behavior,
  not a half-implemented guard.
- `npm test`, `npm run test:workers`, and `npm run typecheck` are green, plus
  `npm run test:e2e` when the change is browser/HTTP/session-reachable.
- Required mutants for new guards were killed and reverted.
- `git status` shows only files this task touched: no scratch output, no
  `[dbg]` logging, no `.data/`, no temp specs.

Then commit immediately. Do not stack a second task's changes on top of an
uncommitted first task — multiple sessions work in this repository, and large
uncommitted churn blocks merges, moves other sessions' baselines, and has
already forced landing work from a separate worktree. One task, one verified
commit.

Also commit (or explicitly hand off) before: switching tasks, starting a long
e2e/verifier pass on unrelated code, or ending a session. Never end a session
with a green suite and an uncommitted tree.

Before pushing, fetch first: `origin/main` may have moved (other sessions and
worktrees land work too). Rebase or merge locally, re-run the affected suites
if the incoming changes touch your files, then push.

## Canvas

After an implementer finishes or a verifier returns `APPROVE` / `REJECT` /
`APPROVE-AS-BLOCKED`, update
`C:/Users/eduar/.cursor/projects/d-new-projects-teacher-playground/canvases/security-remediation-review.canvas.tsx`
so phase tables, in-flight rows, and SEC status match `security.md` and the
latest verdicts. Do not leave the canvas describing the previous phase.

## Delegation

**Always spawn Task/subagents on a cheaper model.** Do not pass `inherit` and
do not run implementers or verifiers on the orchestrating session's model.
In this Cursor workspace the cheap slugs are `composer-2.5-fast` (mechanical
edits, checkbox evidence, git-status-only passes) and
`cursor-grok-4.6-medium` (implementation slices and independent verifiers).
Pick the cheapest that can follow TDD; default implementers and verifiers to
`cursor-grok-4.6-medium` unless the slice is purely mechanical.

The orchestrating session stays on the stronger model and does what cheap
models are bad at:

- Write the task prompt with the failing test named, the files in scope, the
  **model slug to use**, and the AGENTS.md rules restated (TDD, no mocks,
  mutation step) — subagents do not inherit this file automatically.
- Verify every deliverable yourself: re-run the suites, read the diff, and
  attempt one mutant on any new guard. Cheap-model output has previously
  fabricated verification results, installed broken tooling, and deleted an
  entire source tree when asked to remove one directory — treat "it says it
  passed" as unverified until you ran it.
- Keep architecture, security decisions, conflict resolution, and anything
  touching `security.md` checkboxes in the orchestrating session.

One subagent per task slice; do not fan out overlapping edits to the same
files in parallel.

## Verifiers

After an implementation task, a separate read-only verifier must re-run the
same commands and attempt at least one mutant on the new guards. Spawn that
verifier on a cheap slug (`cursor-grok-4.6-medium`, not `inherit`). Verdict is
`APPROVE`, `REJECT`, or `APPROVE-AS-BLOCKED`. Do not check `security.md` `[x]`
until `APPROVE`. The orchestrator still re-runs or spot-checks; a cheap
verifier is not a substitute for that.
