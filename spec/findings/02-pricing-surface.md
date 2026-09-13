# 02 — Pricing & Marketing Surface

Researcher: investigator #2. Scope: current marketing pages, host/path security
contract, server-side plan limits, SEC-015 pricing constraints, test/capture
coverage, and a proposed rebuilt page. Read-only task: no production code,
tests, or configs were modified. `git` was not used (not installed).

## Current surface

### Files and links

- Five marketing files exist: `public/index.html`, `public/pricing.html`,
  `public/terms.html`, `public/privacy.html`, and the shared
  `public/brand.css` (`public/brand.css:2-4` documents that the same sheet is
  imported by the Next app through `src/app/globals.css:15`
  (`@import "../../public/brand.css"`), which `src/app/layout.tsx:2` imports).
- Every page carries the same shell: `.topline`, `.wrap`, `.nav` with
  `aria-label="Primary"` (Pricing + `.signin`→`/whiteboard`), then a footer
  `.foot` with `aria-label="Footer"` (Pricing/Terms/Privacy):
  `public/index.html:11-15,100-103`, `public/pricing.html:11-15,48-51`,
  `public/terms.html:11-15,98-101`, `public/privacy.html:11-15,111-114`.
- Marketing links are relative and host-agnostic (`/whiteboard`,
  `/pricing`, `/terms`, `/privacy`); the Worker redirects `/whiteboard*` from
  the marketing host to the teacher host (`src/worker.ts:922-938`,
  `src/worker.marketing.workers.test.ts:14-26`).

### Pricing markup (`public/pricing.html`)

- `.price-head` → `.eyebrow` ("Pricing"), `<h1>Plain pricing for tutors</h1>`,
  sub-paragraph (`public/pricing.html:17-21`).
- `.tiers` holds two `.tier` cards (`public/pricing.html:22-43`). The paid card
  is `.tier.pro` with a `.corner` ribbon ("Full student list",
  `public/pricing.html:32-34`).
- Each tier: `<h2>` name, `.price` line, `.tag` summary, real `<ul>` feature
  list, `.btn`/`.btn.alt` CTA (`public/pricing.html:22-43`).
- `.pnote` carries the archive-on-downgrade promise verbatim:
  "rooms over the Free limit are archived and readable, and come back exactly as
  they were when you upgrade again" (`public/pricing.html:44-46`).
- Free copy currently matches server truth: 1 student room, 2 people per room,
  boards kept 90 days (`public/pricing.html:26-29`). Tutor Pro is unpriced:
  "Monthly or annual — pricing coming soon" (`public/pricing.html:34`), 20
  rooms / 10 people / 90 days (`public/pricing.html:37-40`).
- The landing hero and closing sell the same promise: "Free for your first
  student. Students always join free." (`public/index.html:24-28`), closing
  "Your first student is free" (`public/index.html:93-98`).
- Terms already state "Students never pay and are never shown billing"
  (`public/terms.html:79-83`); Privacy lists the 90-day idle-room deletion
  (`public/privacy.html:80`).

### CSS class vocabulary (`public/brand.css`)

Shared: `.wrap` (`:67`), `.narrow` (`:68`), `.topline` (`:72`), `.nav`
(`:73-89`), `.brand`/`.mark` (`:74-76`), `.btn` / `.btn.alt` (`:93-97`),
`.aside-link` (`:99-100`), `.smallprint` (`:101`), `.eyebrow` (`:107`),
`.hero` (`:105-115`), `.cta-row` (`:116`), `.sheet`/`.paper`/`.tape`
(`:120-125`), `section.chapter` (`:129`), `.ch-head`/`.ch-num` (`:130-131`),
`h2` (`:132-133`), `.ch-sub` (`:134`), `.ledger`/`.row` (`:136-141`),
`.steps`/`.exercise` (`:143-147`), `.note-block` (`:150-158`),
`.closing` (`:162-166`), `.foot` (`:170-174`), legal `.prose`/`.draft`/
`.updated` (`:198-210`).

Pricing-only: `.price-head` (`:178-180`), `.tiers` (1-col, 2-col ≥820px,
`:181-182`), `.tier` (`:183-184`), `.tier.pro` (`:185`), `.tier .corner`
(`:186-188`), `.tier h2` (`:189`), `.tier .price` (`:190`), `.tier .tag`
(`:191`), `.tier ul`/`li`/`li b` (`:192-194`), `.tier .btn` (`:195`),
`.pnote` (`:196`). There is currently **no** comparison-table or FAQ class;
a rebuilt page needs new selectors added here.

Design tokens are all in `:root` (`public/brand.css:49-54`); `--mut` was
darkened for contrast (`public/brand.css:50`, test `src/deployment/brandCss.test.ts:65-70`).

### A11y fixes already applied (UX-A23, UX-A20)

- Heading order: tiers use `<h2>` (`public/pricing.html:23,32`), so no
  `h1→h3` skip; both navs labeled (`public/index.html:14,102`); feature lists
  are `<ul>` (`public/pricing.html:25-30`); decorative glyphs are
  `aria-hidden="true"` (`public/pricing.html:26-29`, `public/index.html:71-74,88-90`).
  Evidence/status: `UX_IMPROVEMENTS.md:165`.
- UX-A20's verified reduced-motion block lives in `src/app/globals.css:294`
  and is asserted only for that file (`src/deployment/brandCss.test.ts:128-136`).
  `public/brand.css` has **no** `prefers-reduced-motion` rule (grep), though it
  does declare `html{scroll-behavior:smooth}` (`:59`) and the shared spinner
  animation (`:370-374`). Any new marketing animation needs its own block.

## Host/path security contract

### The four places a page path must be registered

1. `isRouteAllowedOnHost` teacher-only exact list — `src/lib/worker/requestGuard.ts:80-94`
   (currently `/`, `/pricing`, `/terms`, `/privacy`, `/brand.css`,
   `/whiteboard`, `/auth/session*`, `/auth/account*`, `/api/whiteboard/rooms`).
2. Marketing-host exact allowlist, GET/HEAD only —
   `src/lib/worker/requestGuard.ts:98-113` (same four pages + favicon,
   `/logo.svg`, `/_next/`, `/fonts/`, `/data/`, `/brand.css`).
3. `MARKETING_PAGES = ['/', '/pricing', '/terms', '/privacy']` —
   `src/lib/worker/requestGuard.ts:352`; drives both `isPublicPath` (`:362`)
   and the `indexable` flag (`src/worker.ts:944,982`).
4. The static HTML file itself, e.g. `public/<slug>.html` (served by
   `env.ASSETS.fetch`, `src/worker.ts:942,980`; assets dir `out/` —
   `wrangler.toml:48-59`).

No `src/worker.ts` edit is needed: it consumes the helpers
(`src/worker.ts:928,939,944,966,978,982`).

### How serving works

- Marketing host: served before Access, no session/DO work, arbitrary assets
  from the allowlist, 404 (`hostNotFound`, `src/worker.ts:869-871`) for
  anything else including wrong method (`src/worker.ts:922-947`).
- Teacher host: public path + GET/HEAD is served before the Access gate
  (`src/worker.ts:969-985`); non-public or non-GET falls through to Access
  (a POST to `/` is 401 — `src/do/roomDO.workers.test.ts:1398-1401`).
- `isPublicPath` is exact-match; `/_next/` is deliberately **not** public
  (`src/lib/worker/requestGuard.ts:360-388`). `/brand.css` is the one
  stylesheet exemption (`:364-370`).
- `withSecurityHeaders` sets the baseline (nosniff, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy` incl. `payment=()`,
  `Cache-Control: no-store`) and sets `X-Robots-Tag: noindex` on HTML unless
  `indexable: true` (`src/lib/worker/requestGuard.ts:484-524`, esp. `:504`).
  `withNonceHtmlSecurityHeaders` also strips ETag/Last-Modified because the
  nonce is baked into the body (`src/lib/worker/requestGuard.ts:542-570`).

### Failure modes for a wrong path/host combination

- In the teacher list but not the marketing list → 404 on `MARKETING_HOSTNAME`
  (`src/worker.ts:939-941`).
- In the marketing list but not the teacher list → 404 on the app host
  (`src/worker.ts:966`), so root-page links and `appUrl` e2e break.
- Missing from `MARKETING_PAGES` → `isPublicPath` false → Access gate (401 in
  production) **and** `X-Robots-Tag: noindex` even where reachable
  (`src/worker.ts:976-985` + `requestGuard.ts:504`).
- Non-GET/HEAD or suffixed/traversal path → denied
  (`requestGuard.ts:75,113`; marketing tests `requestGuard.test.ts:843-858`;
  public-is-read-only worker test `roomDO.workers.test.ts:1398-1401`).

### Tests that lock the contract

- `requestGuard.test.ts:85-96` asserts teacher/guest behavior for
  `/pricing`, `/terms`, `/privacy`; `:292-297` unknown kind denies;
  `:829-834` **asserts exact array equality** of `MARKETING_PAGES`, so adding
  any page fails that test until updated; `:856-858` rejects suffixes.
- `src/do/roomDO.workers.test.ts:1356-1402` is the teacher-host SEC-015
  describe: `/` 200 with no credential (`:1359-1363`), `/pricing` 200 and
  **no** `X-Robots-Tag` (`:1365-1369`), `/brand.css` 200 (`:1371-1381`),
  `/api/brand.css` 404 (`:1383-1386`), app/API still 401 (`:1388-1396`).
  `BASE` is `https://example.com`, i.e. the teacher host (`:1357`).
- `src/worker.marketing.workers.test.ts:14-61` covers only the marketing-host
  `/whiteboard*` redirects. **There is no marketing-host test that pages
  themselves are served**, and `isRouteAllowedOnHost` unit tests never pass
  `'marketing'` (teacher/guest/unknown only, `requestGuard.test.ts:64-303`) —
  a coverage gap the rebuilt page should close.

## Plan limits and the UX-L1 mismatch

- Code truth: `FREE_MAX_ROOMS = 1` (`src/lib/plan/limits.ts:7`),
  `FREE_MAX_USERS = 2` incl. host (`:8-9`), 402 + "Plan limit reached"
  (`:13-14`), `canAddOwnedRoom` (`:16-19`), `maxUsersAllowedOnFreePlan`
  (`:21-23`); the doc comment says "Every account is free… Do not accept a
  client-declared plan" (`:1-5`). Tests: `src/lib/plan/limits.test.ts:12-40`.
- Server enforcement: room cap in `src/do/IdentityDO.ts:551-557`; participant
  cap in room settings/handler (`src/lib/whiteboard/handlers/room.ts:247-248,340-341`).
  Client mirrors only: `TeacherRoomsPanel.tsx:19-25,80`,
  `PresencePanel.tsx:7`, `useCollaboration.ts:40`.
- Retention truth: `ROOM_IDLE_TTL_MS = 90 days` (`src/lib/whiteboard/roomSchema.ts:4`),
  room table default `max_users 2` (`:13`; legacy migration default 3 at `:24`).
- UX-L1 recorded the original mismatch ("2 student rooms / 3 people / 7 days"
  vs code) and its resolution "Copy aligned to server truth (verified); owner
  may instead change the limits — flagged for decision"
  (`UX_IMPROVEMENTS.md:45,84`). The current page/code agree on 1 room / 2
  people / 90 days.
- SEC-015's proposed tier table still says Free = 2 distinct students,
  2 active rooms, 3 participants, 7-day retention, and Tutor Pro = 20 students/
  20 rooms/10 participants/90 days (`security.md:979-986`). That table is
  **not** implemented: `limits.ts` has no paid constants and grep shows no
  distinct-student metering, no `PLAN_CATALOG`, no entitlement table. Pro's
  "20 rooms / 10 people" on the live page is a forward claim.
- Two options for the rebuilt copy (owner decision):
  1. Keep code truth now: Free = 1 room, host+1 student, 90-day retention;
     label Pro limits/prices "planned" until the catalog lands and a test
     locks each advertised number to a constant.
  2. Change limits first (owner amends `security.md:946-990`): raise Free and
     add a paid catalog, then copy `pricing.html` from the new constants. This
     needs red tests in `limits.test.ts` plus worker tests for each new cap.

## Constraints (SEC-015)

From `security.md:946-1073` (public sales surface is `:1039-1073`; checks
`:869-935`; acceptance `:937-944,1068-1073`):

- Reachable without Access, but only via the path/host allowlist; nothing
  under `/api/`, `/auth/`, `/whiteboard/`, `/signaling` may ever be inside it
  (`security.md:1043-1047`).
- Indexable exactly for the named marketing routes, never by content-type or
  wildcard (`:1048-1050`); app HTML stays `noindex` (`requestGuard.ts:504`).
- Funnel is landing → pricing → sign in (Access) → **server-created** Stripe
  Checkout (`:1051-1055`). Public pages contain no card fields, **no
  amount/price parameters on any link**, and no logic that grants anything.
- Public pages keep the security-header baseline and a strict CSP
  (`:1056-1059`). Note `payment=()` in `Permissions-Policy` (`requestGuard.ts:498`),
  so embedded payment UI is not an option; hosted checkout/portal only
  (`:1029-1037`).
- Email capture, if added, is minimal, erasable, and never shown to students;
  prefer cookieless/self-hosted analytics, no third-party trackers
  (`:1060-1063`).
- Terms + privacy are prerequisites for charging (`:1064-1066`); legal pages
  already exist (`security.md:1496-1505`).
- Plan catalog is a static versioned `plan_id -> limits` map in code, never a
  database/price client input (`:992-996`); never accept plan/price/amount
  from the client (`:872-875`, Phase 7 `:1484-1485`).
- Only tutors are billable; students never see billing
  (`:895-897,963-967`).
- Downgrade never destroys data: excess rooms archive (readable, not writable,
  not joinable); retention follows the Free schedule; over-quota returns the
  distinct non-leaking over-plan status (`:1021-1027`). Live copy already
  matches (`public/pricing.html:44-46`).
- Free metering "by distinct students, not rooms" is a recorded requirement
  (`:904-921`) but unimplemented; current code meters rooms
  (`limits.ts:7,16-19`). Copy claiming a number of *students* is not backed by
  code today.
- **Owner decision conflict:** the model was fixed on 2026-08-18 as private
  1:1/small-group tutors, "not a school product: no seat pools, no rosters, no
  district billing, no admin consoles", with "No School tier"
  (`security.md:953-961,988-990`) and Phase 7 explicitly removes seat counting
  from the data model (`:1472-1479`). The spec goal here includes
  "personal/corporate accounts" (`spec/STATE.md:5-7`), so a corporate/team
  tier requires an explicit owner amendment of that decision before it is
  advertised.

## Proposed page structure

Single page at `/pricing` (avoids adding a path to the firewall lists; a
separate `/corporate` page is possible but costs the four registrations and
tests in "Files to change"). Static HTML only, no client JS needed.

1. **Header**: keep `.price-head`, `.eyebrow`, `<h1>`; sub-line keeps
   "Students always join free — only tutors ever pay" (`public/pricing.html:20`).
2. **Personal tiers** (two cards in `.tiers`):
   - **Free (personal)** — `$0, forever`; server truth: 1 student room,
     host + 1 student, voice & video, 90-day retention
     (`limits.ts:7-9`, `roomSchema.ts:4`). CTA "Start tutoring free" → `/whiteboard`.
   - **Tutor Pro (personal paid)** — `.tier.pro` + `.corner`; feature list
     reflects only what the plan catalog will enforce; price is committed
     static text once the owner signs off, otherwise "pricing coming soon"
     as today. CTA "Sign in to upgrade" → `/whiteboard` (no price/amount in
     the URL — SEC-015 `security.md:1052-1055`).
3. **Corporate/Team tier** — only if the owner amends the 2026-08-18 "no seat
   model" decision (see Risks). As proposed: per-seat price, "Contact us" /
   invoice path, no self-serve card capture on this page. The contact path
   must not be a `mailto:` with plan/price parameters; if email capture is
   added it must satisfy `security.md:1060-1063`. Assumption: invoicing is
   manual/owner-led; no server behavior exists yet.
4. **Comparison table** — static `<table>` with `<caption>`, `<th scope="col">`
   tier names and `<th scope="row">` feature rows (rooms, students per room,
   retention, A/V, billing method, support). Needs new `.compare*` classes in
   `public/brand.css`; no existing table styles exist there.
5. **FAQ** — native `<details><summary>` blocks (no JS, CSP-safe):
   - *Billing*: hosted Stripe Checkout/Customer Portal, no card fields in the
     app (`security.md:1029-1037,869-871`).
   - *Cancel*: webhook-driven `canceled`, access bounded by authorization
     epoch (`security.md:1011-1019,886-889`).
   - *Downgrade*: archive, never delete — reuse/replace `.pnote`
     (`public/pricing.html:44-46`, `security.md:1021-1027`).
   - *Referral*: **cannot ship copy yet** — no referral code exists
     (`spec/STATE.md:31`) and SEC-015 has no referral item. Publish the FAQ
     entry only when usage-counting exists, or explicitly mark it "coming
     soon". Needs its own security review (abuse, self-referral).
6. **Footer/CTA** unchanged, plus the existing Pricing/Terms/Privacy links
   (`public/index.html:100-103`).

Static vs server data:

- All copy, tier names, feature bullets, table, FAQ, and any displayed price
  are **static HTML**. There is no sanctioned dynamic price fetch: `/api/*`
  is Access-protected and not in `isPublicPath` (`requestGuard.ts:360-388`),
  the marketing CSP is `connect-src 'self'` (`worker.ts:945,983` +
  `requestGuard.ts:512`), and SEC-015 forbids client-supplied amounts
  (`security.md:872-875,1052-1055`).
- Server data needed only after sign-in: server-selected Stripe price by plan
  id and the Checkout redirect (`security.md:1484-1485,1031-1037`). That is
  Phase 7 work, not this page.
- If prices must vary by currency/tax, do not fetch them client-side; either
  render per-region static pages or state a single static price. Mark as open.

## Files to change

Page/CSS:

- `public/pricing.html` — rebuild markup per the outline (head/description
  `public/pricing.html:6-7`).
- `public/brand.css` — new comparison/FAQ selectors inside `@layer base`
  (pattern `public/brand.css:176-196`); add a `prefers-reduced-motion` block
  if anything animates (currently absent; UX-A20 block only in
  `src/app/globals.css:294`).
- `public/index.html` — copy/CTA only if tier names or the "Free for your
  first student" promise change (`public/index.html:24-28,93-98`).

Security routing (only if a new path such as `/corporate` is added):

- `src/lib/worker/requestGuard.ts:80-94` (teacher list), `:99-111` (marketing
  list), `:352` (`MARKETING_PAGES`).
- `src/worker.ts` needs no edit.

Tests:

- `src/lib/worker/requestGuard.test.ts` — update the exact-array assertion
  (`:829-834`) and add teacher/marketing/guest cases for any new path.
- `src/do/roomDO.workers.test.ts` — extend the SEC-015 describe (`:1356-1402`)
  for a new page (200 no credential, `X-Robots-Tag` null, POST 401).
- `src/worker.marketing.workers.test.ts` — add the first marketing-host page
  serving test for the rebuilt page.
- `tests/e2e/ux-capture.spec.ts` — update the marketing capture
  (`:175-188`; currently only asserts a visible `h1`, so markup changes
  mostly don't break it, but new sections should be captured).
- New `tests/e2e/pricing.spec.ts` (optional) — real-browser content/header
  assertions; a marketing-host e2e needs a marketing origin, which the harness
  does not provide today (`scripts/run-e2e.mjs:146` sets only
  `E2E_GUEST_ORIGIN`; `tests/e2e/origins.ts:13-17`). Until then, test on the
  teacher host via `appUrl('/pricing')` as `ux-capture.spec.ts:184` does.
- `src/deployment/brandCss.test.ts` — add assertions for any new CSS
  contract (e.g. reduced-motion, table layout).
- `src/lib/plan/limits.ts` + `src/lib/plan/limits.test.ts` — only if the
  owner changes Free limits per UX-L1 option 2.

Not in scope for this task: `security.md`, `spec/STATE.md`, canvas
(orchestrator-owned).

## TDD test plan

Red first, one behavior per cycle; no mocks; run `npm test`,
`npm run test:workers` (build first — `AGENTS.md:29-31`), `npm run typecheck`,
and `npm run test:e2e` for browser-visible work.

1. **Unit — page is public on both hosts.** Extend
   `src/lib/worker/requestGuard.test.ts`: `isPublicPath('/pricing')` stays true,
   `isRouteAllowedOnHost('/pricing','GET','teacher')` true, `'guest'` false,
   and (new) `'marketing'` true while `POST` is false. If a new path is added,
   first change `:833`'s exact array and watch it fail.
   *Mutant*: remove the path from `MARKETING_PAGES` (`requestGuard.ts:352`) →
   `isPublicPath` assertion must fail.
2. **Worker — teacher-host serving.** In `roomDO.workers.test.ts` SEC-015
   describe, assert the rebuilt `/pricing` is 200 without credentials,
   `content-type: text/html`, **`X-Robots-Tag` null**, CSP present, and that
   `/terms`, `/privacy` still serve. *Mutant*: drop `indexable` at
   `src/worker.ts:982` → the `X-Robots-Tag` assertion must fail.
3. **Worker — marketing-host serving.** Add to
   `worker.marketing.workers.test.ts`: `/pricing` (and `/`) return 200 on
   `MARKETING = 'https://www.example.com'` and are not redirected.
   *Mutant*: remove `/pricing` from the marketing allowlist
   (`requestGuard.ts:101`) → test must fail.
4. **Worker — public is read-only.** A `POST /pricing` on the marketing host
   is not 2xx, and `POST /` on the teacher host stays 401 (already covered
   for `/` at `roomDO.workers.test.ts:1398-1401`; extend to the rebuilt page).
5. **Content/security e2e (browser).** New `tests/e2e/pricing.spec.ts`:
   navigate `appUrl('/pricing')`, assert `h1` and each tier/FAQ landmark is
   visible, and evaluate the DOM to assert **no link contains `price=`,
   `amount=`, or `checkout`**, **no `<input>` resembles card fields**, and
   response headers include the baseline CSP while `x-robots-tag` is absent.
   For a marketing-host variant, first add a marketing origin to
   `scripts/run-e2e.mjs` and `tests/e2e/origins.ts`.
6. **Copy ⇄ constant lock (recommended).** A unit test that reads
   `public/pricing.html` (pattern: `src/deployment/brandCss.test.ts:10-12`)
   and asserts every number in the Free tier equals `FREE_MAX_ROOMS`,
   `FREE_MAX_USERS`, and the retention constant, so copy cannot drift from
   code silently — the UX-L1 bug class. *Mutant*: change
   `FREE_MAX_ROOMS` to 2 without touching the page → this test must fail.
7. **Limits (only if option 2 chosen).** Red tests in `limits.test.ts` first;
   then worker tests proving the new cap is enforced server-side
   (`IdentityDO.ts:551-557`, `handlers/room.ts:247-248,340-341`).

## Risks & open questions

- **Corporate tier contradicts a recorded owner decision** ("no seat pools…
  No School tier", `security.md:953-961,988-990`; Phase 7 removes seat
  counting, `:1472-1479`). Needs an explicit owner amendment before any copy
  ships. Assumption: the spec goal (`spec/STATE.md:5-7`) supersedes it only
  after that amendment.
- **Prices are undecided** ("pricing coming soon", `public/pricing.html:34`;
  `spec/STATE.md:28`; sign-off named as the open item at `security.md:1478-1479`).
  A static price can be rendered, but only after sign-off; otherwise keep the
  "coming soon" line.
- **Pro limits are unenforced.** No plan catalog, no entitlements, no
  distinct-student meter (`limits.ts:1-5`; `spec/STATE.md:26-31`). Either
  label Pro features as planned or build the catalog first; the copy-lock
  test (TDD step 6) prevents a repeat of UX-L1.
- **A comparison table can be a truth trap**: every cell shown must map to a
  server-enforced constant or be explicitly labelled planned.
- **Referral FAQ cannot be written truthfully yet** (no referral code,
  `spec/STATE.md:31`); it also has no SEC-015 security review for abuse or
  self-referral.
- **No marketing-host e2e today**: `scripts/run-e2e.mjs:146` and
  `tests/e2e/origins.ts:13-17` have no marketing origin, and
  `auth-security.spec.ts` covers only app-host headers
  (`auth-security.spec.ts:23-59,262-283`) — the "host behavior" tests live in
  the worker suites. Decide whether to add harness support or keep the
  teacher-host route as the e2e path.
- **No `prefers-reduced-motion` in `brand.css`** despite UX-A20's file list;
  new animation needs a block and a `brandCss.test.ts` assertion.
- **Adding a new public path is a firewall change** (`requestGuard.ts:348-352`):
  do it as its own reviewed red/green cycle with the exact-array test updated,
  never as a wildcard or suffix match.
- **Build coupling**: worker tests serve `out/` (`AGENTS.md:29-31`), so the
  page is not testable until `npm run build`; screenshots land in ignored
  `test-results/` (`ux-capture.spec.ts:39`, `.gitignore:32`), so captures are
  evidence, not committed snapshots.
