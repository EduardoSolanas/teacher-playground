# 05 — Profile, Company & Invite UI

Investigator #5, 2026-09-11. Research only: nothing under `src/`, `tests/`, or
configs was modified and no app suite was run (`git` is unavailable; all
evidence is from source reads).

Scope: where subscription management, a company context, and referral invites
can live in the existing UI without exposing billing or company admin to
students; which components/tests would change and how.

Assumptions (marked A1-A5 where used):

- **A1** "Company" means a group of tutor/teacher accounts (agency, firm,
  co-op), not a school. Investigator 1's proposed model — `companies`,
  `company_members` with roles `owner|admin|member`, `company_seats`,
  `company_entitlements` — is taken as the shape to design UI against
  (`spec/findings/01-accounts-identity.md:213-294`).
- **A2** Referral invites are for tutor accounts only; students and guests
  never receive or redeem one.
- **A3** The app is a static Next export with two pages today
  (`src/app/whiteboard/page.tsx`, `src/app/whiteboard/[roomId]/page.tsx`), so
  any new top-level route is new static-export surface plus Worker route rules.
- **A4** Plan/company state is server-owned and arrives on
  `/auth/session/current`; the client only renders it (SEC-015,
  `security.md:872-875`).
- **A5** "Subscription management" means links out to processor-hosted
  checkout/portal. No card field ever renders in the app (`security.md:869-871`).

## Current UI inventory

### 1. Profile menu (the only account surface)

`src/components/whiteboard/UserProfileMenu.tsx`

- Props: `displayName: string | null`, `onDisplayNameChange`,
  `triggerClassName?`, `showDisplayName?` (`:17-27`). No role, plan, company,
  or host-kind prop exists.
- Trigger: `data-testid="whiteboard-profile-btn"`, `aria-haspopup="menu"`,
  `aria-expanded`, `aria-controls={labelId}` (`:178-202`).
- Open menu (`role="menu"` only while menu items show, `:41-44`, `:208`):
  a "Profile" micro-label (`:214-216`), "Change name"
  (`data-testid="whiteboard-profile-edit-name"`, `:217-228`), "Sign out"
  (`whiteboard-logout-btn`, `:229-239`), "Delete account"
  (`whiteboard-profile-delete`, `:240-252`). There is no link/route to a plan,
  billing, company, or invite surface anywhere in the menu.
- Edit-name form (`:256-294`) calls
  `ajaxFetch('/auth/account/profile', { method: 'PATCH', body: { displayName } })`
  directly inside the component (`:129-134`), then writes
  `localStorage.whiteboard_username` and calls `onDisplayNameChange` (`:139-147`).
- Delete flow is `DELETE /auth/account`, re-confirmed via
  `POST /auth/session/confirm` on 403 (`:155-174`), then `router.replace('/')`.
- Closing/keyboard: outside mousedown and document Escape close it and
  `triggerRef.current?.focus()` restores focus (`:50-74`); arrows/Home/End/Tab
  rove the menu (`:82-112`) and focus enters on open (`:76-80`).
- Note: `aria-controls` always points at `labelId` but the menu element only
  exists while `open` (`:184` vs `:204-210`) — the one `aria-controls`
  reference UX-A29 fixed is still conditional; do not copy this pattern for a
  new disclosure, or fix it while touching the file.

Test: `src/components/whiteboard/UserProfileMenu.test.tsx` (198 lines).

- It mocks `ajaxFetch`, `next/navigation`, and `location`
  (`:5-15`) — the repo's older style. AGENTS.md says existing mocks do not
  authorize new mocks (`AGENTS.md:62-66`).
- Covers: the three entries (`:38-45`), PATCH body (`:47-66`), UX-A5 focus
  roving (`:68-91`), role dropped while a form shows (`:93-103`), UX-B12
  global focus ring (`:105-120`), UX-B6/B14 menu recipe (`:122-134`), UX-B22
  `tracking-wider` (`:136-145`), UX-L17 tooltip (`:147-167`), UX-A18 label
  (`:169-178`), delete flow (`:180-197`).

### 2. Where the menu is mounted

- Rooms page header: `src/app/whiteboard/page.tsx:31-45`,
  `showDisplayName={false}`, compact circular trigger (`:38-43`).
- In-room bar: `src/components/whiteboard/RoomTopNav.tsx:54-62`, next to an
  optional `people` slot (`:25-29`) and a `center` slot (`:19-24`).
- `RoomTopNav` returns `null` on the guest hostname (`:31-37`), so students on
  the configured guest origin see no profile menu at all.
- `RoomClient` renders `RoomTopNav` in every room state — join prompt, waiting,
  loading, and connected (`src/app/whiteboard/[roomId]/RoomClient.tsx:832-837`,
  `:851-856`, `:871-876`, `:900-905`, `:913-927`).

### 3. Session/account data the client already sees

- `GET /auth/session/current` is routed in `src/worker.ts:1011-1013` to
  `sessionCurrent` (`:445-470`), which returns the IdentityDO session
  (`sessionStore.ts:45-54`: `accountId`, `sessionId`, `authorizationEpoch`,
  `idleExpiresAt`, `absoluteExpiresAt`, `createdAt`, `confirmedAt`, `touched`)
  plus `displayName`, with `preferredDisplayName` stripped (`worker.ts:461-468`;
  IdentityDO returns it at `src/do/IdentityDO.ts:388-394`).
- `AccessSessionBootstrap` fetches it only to check `.ok` and discards the body
  (`src/components/AccessSessionBootstrap.tsx:36-42`); it skips entirely on the
  guest host (`:15-18`).
- `page.tsx:15-21` re-fetches it for `displayName`; `RoomClient.tsx:564-600`
  re-fetches it for `displayName` on the teacher host. So there are already
  duplicate reads of the same payload; adding `plan`/`company` to that JSON
  costs no new round trip but is parsed in two more places.
- `ajaxFetch` only adds `X-Requested-With`, same-origin credentials, and
  rejects cross-origin (`src/lib/http/ajaxFetch.ts:8-20`); CSRF is enforced
  server-side by `originGuard` (`src/lib/worker/requestGuard.ts:200-223`).
- Account/profile HTTP contract: `PATCH /auth/account/profile` → Worker
  `accountProfile` (`worker.ts:515-538`) → IdentityDO `isProfileBody:157-163`,
  `setPreferredDisplayName` (`IdentityDO.ts:441-461`); response is exactly
  `{ displayName }`.

### 4. Rooms page, room list, and the company gap

- `TeacherRoomsPanel` is a client shell with an injected request function
  (`request = ajaxFetch`, `src/app/whiteboard/TeacherRoomsPanel.tsx:34-40`),
  loads `GET /api/whiteboard/rooms` through `loadTeacherRooms`
  (`src/lib/whiteboard/teacherRooms.ts:44-54`; Worker route
  `worker.ts:110`, `:655-674`, `:1029-1031`), and renders `TeacherRoomList`.
- The only "plan" UI anywhere in the app is the free-tier copy: the people
  stepper is clamped to `FREE_MAX_USERS` (`TeacherRoomsPanel.tsx:24-25`,
  `:168-169`), plus "Includes you. Free accounts allow one room with one
  student." (`:307-309`) and the 402/room-cap alerts (`:80-81`, `:313-322`),
  all keyed off `src/lib/plan/limits.ts:7-14`.
- There is no company/workspace selector, no seat display, no org label on the
  page or in the room list. The schema also has none: `accounts` is just
  `account_id/state/epoch/provenance` (`src/lib/identity/identityStore.ts:44-57`),
  and no `company*` table exists.
- `RoomTopNav.tsx` has free `center` and `people` slots (`:19-29`, `:46-62`)
  that could carry a company/plan chip without a layout change.

### 5. Invite surfaces that exist today

Student/room invites (a third, distinct thing from the two the spec asks for):

- Room list "Share" copy button per row, copying `guestHostJoinUrl(roomId)`
  (`src/components/whiteboard/TeacherRoomList.tsx:340-356`, `:837-878`), plus
  class PIN controls (`:894-996`).
- In-room owner-only `RoomTitleMenu` "Share join link / class PIN" panel
  (`src/components/whiteboard/RoomTitleMenu.tsx:209-213` hides the whole menu
  for non-owners; share item `:348-364`; panel `:265-345`).
- Guest entry points: `GuestJoinPrompt.tsx` posts `/auth/guest` with
  `{roomId,pin,displayName}` (`:67-71`) and maps 403/404 to a retry-locked
  credential error, everything else to transport (`:72-88`); `WaitingRoom.tsx`
  has only Refresh/Leave (`:81-95`). Neither mentions billing, company, or
  referrals.
- Link construction is `guestHostJoinUrl` (`src/lib/whiteboard/guestJoinUrl.ts:27-61`),
  and `isGuestHostname` is fail-closed (`src/lib/guest/guestHost.ts:5-9`).
- There is **no** shareable non-URL identifier, counter, badge, or status
  region for an invite anywhere; `CopyButton` is the reusable copy primitive
  (`src/components/whiteboard/CopyButton.tsx:15-91`, with a persistent
  `role="status"` region at `:77-84`).

## Proposed entry points

All four are teacher-facing. Recommended placement, one per concern:

| # | Entry | Where it lives | Why there |
| --- | --- | --- | --- |
| 1 | Plan badge + "Subscription" | `UserProfileMenu.tsx` open menu, under a new "Plan" micro-label above "Profile" (`:212-253`) | The menu is the only global account surface; profile/page already receive session data (`page.tsx:38-43`, `RoomTopNav.tsx:56-61`). Follow the `RoomTitleMenu` in-menu panel pattern (`RoomTitleMenu.tsx:51`, `:265-345`) for a read-only summary, and make the actual manage/upgrade action an `<a>` to a server-issued Checkout/Portal URL. Never render price/card inputs (SEC-015, `security.md:869-871`, `:1029-1037`). |
| 2 | Company name + role | Same menu, entry below Profile ("Company: Acme Tutoring" / role) | Session-carried membership makes it render without a fetch. Full management needs a dedicated surface (see #3). |
| 3 | Company admin (seats, invite teammate) | New static route e.g. `src/app/whiteboard/company/page.tsx` (A3), linked from the Company entry; render only when session says `owner|admin` | Seat management is a list + form, not a menu item; the room list is the tutor's home so a route is discoverable. Must have its own Worker route rules and server role checks (investigator 1: admin-initiated invites, `spec/findings/01-accounts-identity.md:314-338`). |
| 4 | Referral invite + counter | `UserProfileMenu.tsx` panel (or a small `ReferralPanel` component it renders), available to paying tutor accounts only | A referral is a personal billing-adjacent perk, not a room artifact; putting it in `RoomTitleMenu` next to the student join link and PIN would conflate two invite kinds (`RoomTitleMenu.tsx:266-336`). Counter shown as a `text-[10px] font-semibold` chip per `DESIGN.md:71-73`, with a persistent `role="status"` (`CopyButton.tsx:77-84` precedent). |

Correction to the working assumption in the task: corporate seat invites are
**not** a room invite. They belong with the company admin route (#3); only the
referral link (#4) belongs on a general teacher surface.

## Data flow

1. **Plan/company without an extra round trip.** Extend the
   `/auth/session/current` JSON in `worker.ts:461-469` (and the IdentityDO read
   behind it, `IdentityDO.ts:388-394`) with server-derived `plan` (e.g.
   `{ id, status }`) and `company` (`{ id, name, role }` or absent). The client
   already parses that payload in `page.tsx:17-21` and `RoomClient.tsx:575-581`;
   pass it into `UserProfileMenu` as props next to `displayName`
   (`UserProfileMenu.tsx:17-27`). `AccessSessionBootstrap` sees the same
   payload (`AccessSessionBootstrap.tsx:36-42`) but discards it; do not add a
   third independent fetch — either thread the value from the existing page
   fetch or accept the duplicate read as today.
2. **Subscription.action.** New `POST /api/account/checkout` /
   `/api/account/portal` style routes (Worker → IdentityDO) that return a
   processor URL; the client only navigates. Entitlement state is written from
   webhooks, never the redirect (`security.md:876-882`).
3. **Referral counter.** New teacher-only `GET /api/referrals/me` (code,
   `redemptionCount`, server-issued link) and it must be fetched lazily when
   the panel opens, like `RoomTitleMenu`'s `loadShareSettings`
   (`RoomTitleMenu.tsx:149-157`), not on app load. Code/link text can reuse
   `CopyButton` (`CopyButton.tsx:15-91`).
4. **Company seats.** New teacher-only `GET/POST /api/company/*` routes
   (mirroring `listAccountRooms`, `worker.ts:655-674`) driven by an injected
   `request?: AjaxFetch` prop so components are testable with real `Response`
   objects (`TeacherRoomsPanel.tsx:34-40`).
5. **Provenance/role derivation is server-side.** The UI receives a rendered
   answer ("Free", "Tutor Pro", "Acme Tutoring — admin"); it must not derive
   plan from limits or from client-declared state (`security.md:872-875`).

## Student-safety boundary

Exact places the boundary is enforced today, and where new work must not break
it:

- **Client nav suppression:** `RoomTopNav.tsx:31-37` returns `null` on the
  guest host, which is what hides `UserProfileMenu` (`:56-61`) from students.
  Any in-room entry added anywhere else (e.g. the `center` slot at
  `RoomClient.tsx:928-937`, or `RoomTitleMenu`) loses that blanket protection
  and needs its own host/role gate. `RoomTitleMenu` is at least owner-only
  (`:209-213`), and guests are never room owners.
- **Room-page fetch skip:** `RoomClient.tsx:564-567` and
  `AccessSessionBootstrap.tsx:15-18` both short-circuit on the guest host, so
  guest pages never read `/auth/session/current`; keep plan/company fields off
  any payload a guest page reads.
- **Menu gating:** `UserProfileMenu` currently renders identical entries for
  every caller. Plan/company/referral props must default to absent and the
  component must render nothing for them when absent (the `supportEmail()`
  "unset means no button" idiom, `SupportButton.tsx:17-18`).
- **Server guards (the real boundary):** `/auth/*` and `/api/whiteboard/rooms`
  are teacher-host-only (`requestGuard.ts:79-94`, `:116-118`), `/auth/guest`
  is guest-host-only (`:136-139`), and all account mutations are
  origin-guarded (`:212-223`). Every new billing/company/referral route must be
  added to `isTeacherOnlyPath` and to the origin-guarded set, then re-checked
  in `requestGuard.test.ts` (`:104-118`) and the guest-host e2e
  (`tests/e2e/guest-join.spec.ts:342-363`).
- **Never in the student path:** `GuestJoinPrompt.tsx` (`:67-88`) and
  `WaitingRoom.tsx` (`:81-95`) must stay free of any plan, price, company, or
  invite-own-friends copy. A student also must never see the rooms page or the
  profile menu; both are behind the teacher host and the `showNav` check.
- Legal copy already tells users the account menu is where deletion lives
  (`public/privacy.html:93`, `public/terms.html:88`); adding entries is
  compatible, but do not reword that promise.

## Test plan

Conventions to copy:

- Real-object component test exemplar:
  `src/app/whiteboard/TeacherRoomsPanel.test.tsx:7-26` ("No test doubles live
  here": a plain async function returning real `Response` objects, injected as
  a prop).
- Focus/ARIA exemplar: `UserProfileMenu.test.tsx:68-91` (userEvent,
  `document.activeElement`).
- E2E profile exemplar: `tests/e2e/account-profile.spec.ts:4-38` (rooms page →
  menu → PATCH → assert session JSON via `expect.poll`). In-room overlay
  exemplar: `tests/e2e/ui-controls.spec.ts:45-85`.

Proposed tests, in TDD order:

1. **Red unit/component (new files, real objects):**
   `src/components/whiteboard/PlanSummary.test.tsx` and
   `ReferralPanel.test.tsx` (or one `AccountPanels.test.tsx`) rendering the
   new panel components with `request` returning real `Response`s:
   - Free sees "Free" and an Upgrade link/entry; paid sees plan + "Manage".
   - The referral link and `redemptionCount` render; a failed read shows an
     error/retry and no fabricated zero.
   - `role="status"` content for copy success and for a counter refresh.
2. **Extend `UserProfileMenu.test.tsx` only where props are the behavior**
   (e.g. entries hidden when `plan`/`company` are absent, badge text). Keep
   new network behavior out of the mocked file; if the menu itself must fetch,
   move the fetch behind a prop-injected component first.
3. **Worker tests (`*.workers.test.ts`, real workerd):**
   - `GET /api/referrals/me` returns the caller's code and count and no other
     account's (`src/worker.access.workers.test.ts:174-182` cross-account
     pattern).
   - Checkout/portal session creation is owner-only and never trusts a client
     price/plan.
   - Company admin endpoints: member role accepted, member (non-admin)
     rejected, non-member rejected, guest rejected, wrong-origin rejected.
4. **Negative tests before guards exist (AGENTS.md:70-74):** guest-host route
   denial for every new path; a guest calling referral/company/billing gets the
   same 404 as `requestGuard.test.ts:113-118` expects; a student page has no
   billing entry.
5. **Mutation tests:** one on the host check, one on the company role check,
   one on the referral ownership check (AGENTS.md:103-122).
6. **E2E (required, browser-reachable):** extend
   `tests/e2e/account-profile.spec.ts` for "the header shows Free and opens
   Subscription"; add the new routes to the guest-origin 404 list
   (`tests/e2e/guest-join.spec.ts:349`); assert absence of plan/company
   testids on a guest page. Run `npm run test:e2e` before claiming any
   security.md item.
7. **jsdom limits to plan around:** no layout/CSS/z-index (assert class tokens
   as the existing tests do), no real navigation (stub `next/navigation` only
   where already necessary), no clipboard (stub), no `Response` streaming
   nuance; focus is assertable only via `document.activeElement`, and
   `matchMedia`/reduced-motion cannot be tested there.

Files the work would touch or add:

- Edit: `UserProfileMenu.tsx`/`.test.tsx`, `RoomTopNav.tsx`,
  `src/app/whiteboard/page.tsx`, `src/app/whiteboard/[roomId]/RoomClient.tsx`
  (pass-through props), `src/worker.ts`, `src/do/IdentityDO.ts`,
  `src/lib/worker/requestGuard.ts` (+ its test), `src/lib/identity/sessionStore.ts`.
- Add: new panel components + tests, `src/app/whiteboard/company/page.tsx`
  (A3), referral lib module + test, Worker/IdentityDO handlers +
  `*.workers.test.ts`, e2e spec additions.

## Risks & open questions

1. **SEC-015 says there is no company tier.** "This is not a school product:
   no seat pools, no rosters, no district billing, no admin consoles"
   (`security.md:955-956`) and "No School tier" (`:988-990`). A company
   context + seat invites either amends that owner decision or must be scoped
   to a non-school tutor group. **[owner decision, blocks naming and routes]**
2. **Who is the company admin, and can a member change company?**
   investigator 1 proposes one company per account for v1
   (`spec/findings/01-accounts-identity.md:239-241`) and an owner/admin role
   (`:231`) — the UI copy ("Seats", "Invite teammate") depends on this being
   final. **[owner decision]**
3. **Does the plan live on the account or the company?** SEC-015 keys
   entitlement to `account_id` (`security.md:872-875`, `:998-1009`);
   investigator 1 proposes company-level entitlements with a derived effective
   plan. The badge must not display two disagreeing plan names. **[design
   dependency]**
4. **Referral integrity and display.** Nothing server-side exists today; the
   counter must come from server-side redemption records keyed by the tutor
   account, never a client tally. How redemptions are attributed (access
   subject vs account, `accounts`/`access_subjects` at
   `src/lib/identity/identityStore.ts:102-110`) is investigator 4's area.
5. **Menu crowding.** The menu is `w-64` with three items plus heading
   (`UserProfileMenu.tsx:210-253`). Plan + company + referral + subscription
   adds up to seven rows; prefer a "Plan" section heading and panels over
   a long list, matching `RoomTitleMenu`'s disclosure pattern.
6. **Billing links inside a menu form risk looking like in-app billing.**
   Keep every purchase/cancel action a navigation to a server-issued URL, and
   never render an amount from client state (`security.md:1049-1054`).
7. **`aria-controls` points to a conditionally-mounted element**
   (`UserProfileMenu.tsx:184` vs `:204`); touching this file is the cheap
   moment to fix it, but changing it is behavior a test should pin first.
8. **`UserProfileMenu.test.tsx` is mock-based**, so any new behavior in that
   component cannot get an AGENTS-compliant test without moving the network
   call behind an injected-request child or prop. Decide this before
   implementing rather than after (AGENTS.md:62-66).
9. **Pricing page parity.** `public/pricing.html:20-45` promises "Students
   always join free — only tutors ever pay" and "pricing coming soon"; a
   Subscription entry pointing at `/pricing` must not lead to a dead end while
   prices are TBD (`UX_IMPROVEMENTS.md:185` "no dead ends" spirit), so the
   profile entry should say "coming soon" or stay hidden until checkout
   exists.
