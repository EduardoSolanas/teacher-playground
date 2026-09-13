# 01 — Accounts & Corporate Identity

Research for the personal-vs-corporate account spec. Read-only investigation: no
production code, tests, or configs were changed; no app suites were run. `git`
is installed at `C:\Program Files\Git\cmd\git.exe` and not on this shell's
`PATH` (corrected in spec/STATE.md v2).

**Method / mark keys.** Every claim carries `path:line`. Statements marked
**[assumption]** are design proposals, not existing behavior. Statements marked
**[owner decision]** are questions the product owner must settle before the
merged spec is written; the most important one is the SEC-015 target-market
reversal in "Decisions needed".

---

## Current model

### 1. Where accounts come from and how they resolve

- The identity store is the single global `IdentityDO` named `global`
  (`src/do/IdentityDO.ts:74`, `src/do/IdentityDO.ts:694-699`). It owns its own
  SQLite schema, applied on construction (`src/do/IdentityDO.ts:318-322`).
- `applyIdentitySchema` creates `accounts`, `access_subjects`, `sessions`,
  `authorization_audit`, `account_rooms`, `pending_erasures`
  (`src/lib/identity/identityStore.ts:40-228`). The unit test pins the exact
  table list (`src/lib/identity/identityStore.test.ts:25-60`).
- An access account is created lazily by exact `(issuer, subject)` pair via
  `resolveAccountForSubject`; account ids are random UUIDs and email/provider
  labels are deliberately never stored or used as keys
  (`src/lib/identity/identityStore.ts:347-397`, `src/lib/identity/identityStore.ts:343-346`,
  test at `src/lib/identity/identityStore.test.ts:118-136`).
- The Worker verifies the Access JWT and forwards only `{issuer, subject}` to
  the DO (`src/worker.ts:987-995`, `src/worker.ts:371-373`,
  `src/worker.ts:438-442`).
- Guest accounts are `provenance='guest'` + non-null `guest_room_id`, created
  through `POST https://identity/guests/issue`; the invariant is enforced by
  BEFORE INSERT/UPDATE triggers because `CHECK` cannot be added by `ALTER TABLE`
  (`src/lib/identity/identityStore.ts:59-99`, `src/lib/identity/identityStore.ts:403-433`,
  route at `src/do/IdentityDO.ts:627-656`).
- **There is no account kind/role (tutor vs student).** `accounts` has
  `state`, `authorization_epoch`, `provenance`, `guest_room_id`, and (after
  migration) `preferred_display_name` only (`src/lib/identity/identityStore.ts:43-57`,
  `src/lib/identity/identityStore.ts:215-227`). A student is simply an access
  account that holds a room membership; nothing in the schema says "student".
  **[assumption]** This matters: "keep students out of billing" cannot be a
  schema predicate today and needs an invite/grant gate or a new account kind.

### 2. Sessions and authorization-epoch revocation

- Sessions are opaque 32-byte tokens; only the SHA-256 hash is stored, with
  idle (30 min) and absolute (12 h) TTLs (`src/lib/identity/sessionStore.ts:12-27`,
  `src/lib/identity/sessionStore.ts:102-110`, `src/lib/identity/sessionStore.ts:15-17`).
- Session validation joins `sessions` to `accounts` and requires
  `session.authorization_epoch === account.authorization_epoch`, account
  `state='active'`, not revoked, and unexpired (`src/lib/identity/sessionStore.ts:112-137`,
  `src/lib/identity/sessionStore.ts:166-175`, `src/lib/identity/sessionStore.ts:359-389`).
- `changeAccountAuthorization` is the one epoch-mutation path: it optionally
  advances `authorization_epoch`, sets state, revokes every open session, and
  writes an `authorization_audit` row in the same transaction
  (`src/lib/identity/sessionStore.ts:653-700`). `revokeAllSessions` advances
  the epoch and revokes sessions (`:702-712`); `disableAccount` disables and
  advances (`:714-724`); `enableAccount` re-activates **without** advancing
  (`:726-736`).
- Audit rows are append-only, mandatory actor+reason, and deliberately not
  `ON DELETE CASCADE` (`src/lib/identity/identityStore.ts:157-179`,
  `src/lib/identity/identityStore.ts:251-262`, `src/lib/identity/identityStore.ts:264-304`).
- Live rooms re-check accounts on an alarm: RoomDO asks IdentityDO
  `POST /accounts/authorizations` for `{state, authorizationEpoch}` plus active
  session hashes, and closes any socket whose epoch/state/session no longer
  matches (`src/do/RoomDO.ts:2126-2189`, `src/do/RoomDO.ts:2149-2158`). The
  documented bound is the alarm interval, 30 s production default
  (`SECURITY_REVOCATION_BOUND.md:55`, `SECURITY_REVOCATION_BOUND.md:119`).
- Self-erasure: `eraseOwnAccount` revokes sessions, disables the account,
  drops `access_subjects`, records owned-room ids in `pending_erasures`,
  deletes `account_rooms`, and pseudonymizes `authorization_audit` rows
  (`src/lib/identity/sessionStore.ts:601-636`). It does **not** cover any other
  table by design today because no other table holds `account_id`
  (`pending_erasures` at `src/lib/identity/identityStore.ts:206-213`).

### 3. IdentityDO route surface (internal only)

The DO is never exposed publicly; it receives `https://identity/<path>` fetches
from the Worker or RoomDO, and the public Worker has a negative test that
identity session/account-control paths (`/api/internal/identity/...`) are
unreachable (`src/do/identityDO.workers.test.ts:1087-1102`).

Constants (`src/do/IdentityDO.ts:53-73`) and their handlers in `fetch`
(`src/do/IdentityDO.ts:324-690`):

| Path | Method | Handler / notes |
| --- | --- | --- |
| `/subjects/resolve` | POST | `resolveAccountForSubject` (`:328-341`) |
| `/sessions/issue` | POST | issues session from verified principal (`:343-366`) |
| `/sessions/current` | GET | `validateSession` (`:368-377`) |
| `/sessions/authorize` | POST | session + exact issuer/subject; returns `preferredDisplayName` (`:379-395`) |
| `/sessions/confirm` | POST | step-up timestamp (`:397-410`) |
| `/sessions/rotate` | POST | rotation (`:412-426`) |
| `/sessions/logout` | POST | logout (`:428-439`) |
| `/accounts/profile` | PATCH | caller-only display name (`:441-461`) |
| `/accounts/export` | GET | own data export (`:463-472`) |
| `/accounts` | DELETE | self-erasure + fresh-session gate (`:474-492`) |
| `/accounts/pending-erasures` | GET | erasure queue (`:494-501`) |
| `/accounts/clear-erasure` | POST | clear one target (`:503-512`) |
| `/accounts/rooms/touch` | POST | internal, room→identity last-used stamp (`:521-532`) |
| `/accounts/rooms` | GET/POST/DELETE | list / reserve / release owned room (`:534-584`) |
| `/accounts/authorizations` | POST | live-socket re-check (`:588-604`) |
| `/accounts/revoke-all`, `/accounts/disable`, `/accounts/enable` | POST | guarded audit mutations (`:606-625`) |
| `/guests/issue` | POST | guest account + 4 h guest session (`:627-656`) |
| `/guests/purge` | POST | per-room guest deletion (`:670-688`) |
| `/sessions/authorize-guest` | POST | guest session bound to one room (`:658-668`) |

### 4. The profile-edit pattern (`preferred_display_name`)

This is the template a "company profile" edit should copy end to end:

1. Worker route constant `ACCOUNT_PROFILE = '/auth/account/profile'`
   (`src/worker.ts:109`), dispatched only for teacher host + verified Access
   principal (`src/worker.ts:1020-1022`), handled by `accountProfile`
   (`src/worker.ts:515-538`), which first calls `sessionAuthorized` and then
   forwards the cookie and body to the DO.
2. DO branch PATCH `/accounts/profile`: validates session, then applies
   `setPreferredDisplayName` (`src/do/IdentityDO.ts:441-461`); the body guard
   requires exactly one `displayName` field (`src/do/IdentityDO.ts:157-163`).
3. Store write validates + strips ASCII controls, updates
   `accounts.preferred_display_name` and `updated_at`, fails if no row changed
   (`src/lib/identity/identityStore.ts:650-671`).
4. Read-back is folded into `/sessions/authorize`
   (`src/do/IdentityDO.ts:388-394`), and the Worker prefers it over the Access
   display name (`src/worker.ts:445-470`).
5. Tests: unit `src/lib/identity/identityStore.test.ts:482-513`; DO
   `src/do/identityDO.workers.test.ts:559-608`; guard
   `src/lib/worker/requestGuard.test.ts:115-118` and `:312-329`; browser
   `tests/e2e/account-profile.spec.ts:21`.

### 5. Rooms, roles, and where a plan is enforced

Two different tables model "owner":

- `room_members` lives in each RoomDO and is the real authorization record:
  `owner | editor | viewer | pending | banned` (`src/lib/whiteboard/membership.ts:3-23`),
  with role mechanics at `src/lib/whiteboard/membership.ts:54-100`,
  `src/lib/whiteboard/membership.ts:157-177`, and approval at
  `src/lib/whiteboard/membership.ts:328-346`. The owning account is read back
  from `room_members WHERE role='owner'` (`src/do/RoomDO.ts:1544-1547`).
- `account_rooms` lives in the IdentityDO and is only the "my rooms" index:
  one `role='owner'` row per (account, room) (`src/lib/identity/identityStore.ts:187-199`),
  written by `recordOwnedRoom` (`:532-567`) and never by a non-owner
  (`touchOwnedRoom` at `:592-611`).
- `limits.ts` is the only plan source today: every account is Free — 1 owned
  room, host + 1 student (`src/lib/plan/limits.ts:2-23`; enforced predicates at
  `:16-23`).
- Enforcement points that exist today:
  - owned-room count: `POST /accounts/rooms` refuses a second room with 402
    (`src/do/IdentityDO.ts:550-560`);
  - room creation `maxUsers` must be `<= FREE_MAX_USERS` (`src/lib/whiteboard/handlers/room.ts:247-249`);
  - room settings `maxUsers` likewise (`src/lib/whiteboard/handlers/room.ts:340-342`);
  - waiting-queue capacity is `min(rooms.max_users, 50)` (`src/lib/whiteboard/membership.ts:30-52`).
- Tests pinning this: `src/lib/plan/limits.test.ts:14-39`,
  `src/do/identityDO.workers.test.ts:960-982`, `src/lib/whiteboard/handlers/room.test.ts:162-191`,
  `src/worker.access.workers.test.ts:1322-1382`.
- **Where the owner's plan would have to be read** once plans exist
  (`security.md:963-967`: "A room's capabilities are decided by its *owner's*
  plan"):
  1. room create/settings `maxUsers` gate (`src/lib/whiteboard/handlers/room.ts:247`,
     `:340`) — currently a static constant;
  2. owned-room reservation (`src/do/IdentityDO.ts:550-560`) — needs the
     account's *effective* plan, not a constant;
  3. admission metering (SEC-015 distinct-student meter): owner approval paths
     `src/lib/whiteboard/handlers/requestsId.ts:38-53` and request-side
     `src/lib/whiteboard/membership.ts:188-253`;
  4. waiting-queue cap (`src/lib/whiteboard/membership.ts:33-41`);
  5. RoomDO currently does **not** read `max_users` to cap admitted
     participants at all (grep: no `max_users` reference in
     `src/do/RoomDO.ts`), so a participant/seats cap would be new server work at
     the admission boundary, using the owner resolved at
     `src/do/RoomDO.ts:1544-1547` and the IdentityDO lookup pattern at
     `src/do/RoomDO.ts:1549-1560`.
  - The Worker already stamps verified identity onto room requests
    (`accountId`, `accountEpoch`, `sessionId`) and strips forged headers
    (`src/worker.ts:777-814`, `src/lib/worker/requestGuard.ts:288-310`), so
    RoomDO can ask IdentityDO for the owner's effective plan without trusting
    client input.

### 6. Migration conventions (`applyIdentitySchema`)

- New tables: `CREATE TABLE IF NOT EXISTS` with `CHECK` constraints, FKs, and
  indexes (`src/lib/identity/identityStore.ts:43-57`, `:101-148`, `:186-204`).
- New columns on existing tables: read `PRAGMA table_info` and
  `ALTER TABLE ... ADD COLUMN` only if missing (`:59-68`, `:150-155`,
  `:215-227`); `ADD COLUMN` may carry `CHECK` (`:218-227`).
- Invariants that can't be a table `CHECK` (cross-column, or needed on legacy
  tables) are `CREATE TRIGGER IF NOT EXISTS ... RAISE(ABORT, ...)`
  (`:70-99`). Tests exercise both fresh and legacy-migrated DB shapes and
  idempotency (`src/lib/identity/identityStore.test.ts:534-609`,
  `:611-641`).
- Room schema follows the same pattern (`src/lib/whiteboard/roomSchema.ts:22-80`)
  and even does a controlled table rebuild for a role-union change
  (`src/lib/whiteboard/roomSchema.ts:163-191`) — available if an existing
  CHECK must change, but expensive and not needed for new tables.
- `authorization_audit.action` has a closed `CHECK (action IN ('revoke-all','disable','enable'))`
  (`src/lib/identity/identityStore.ts:166-167`), so company/seat actions
  **cannot** reuse that table without a rebuild. **[assumption]** Use a new
  append-only `company_audit` table instead.

---

## Proposed schema

**[assumption]** All of this is a proposal; nothing below exists in the tree.
It reuses identity-store conventions: opaque text ids, snake_case, `CHECK`,
FK to `accounts`, changes recorded with mandatory actor+reason.

```sql
-- A company/tenant. Opaque id; name is the only human label.
CREATE TABLE IF NOT EXISTS companies (
  company_id TEXT PRIMARY KEY
    CHECK (length(company_id) BETWEEN 1 AND 128),
  name TEXT NOT NULL
    CHECK (length(trim(name)) BETWEEN 1 AND 100),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active','disabled')),
  authorization_epoch INTEGER NOT NULL DEFAULT 0
    CHECK (authorization_epoch >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

-- Membership + corporate role. Seat state is separate so history survives.
CREATE TABLE IF NOT EXISTS company_members (
  company_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (company_id, account_id),
  FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);

-- One-company rule for v1. Drop this index to allow multi-company later.
CREATE UNIQUE INDEX IF NOT EXISTS company_members_one_per_account
  ON company_members(account_id);

-- Seat = the unit the company plan pays for. account_id NULL = unassigned seat.
-- A revoke keeps the row for audit; the partial index permits re-assignment.
CREATE TABLE IF NOT EXISTS company_seats (
  seat_id TEXT PRIMARY KEY
    CHECK (length(seat_id) BETWEEN 1 AND 128),
  company_id TEXT NOT NULL,
  account_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('assigned','revoked')),
  assigned_at INTEGER NOT NULL,
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= assigned_at),
  FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS company_seats_one_active_per_account
  ON company_seats(account_id)
  WHERE status = 'assigned' AND account_id IS NOT NULL;

-- Company-level plan state. Absence of a row = Free (SEC-015 pattern).
CREATE TABLE IF NOT EXISTS company_entitlements (
  company_id TEXT PRIMARY KEY
    REFERENCES companies(company_id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL
    CHECK (length(trim(plan_id)) BETWEEN 1 AND 64),
  status TEXT NOT NULL
    CHECK (status IN ('free','trialing','active','past_due','canceled')),
  seat_limit INTEGER NOT NULL CHECK (seat_limit >= 0),
  current_period_end INTEGER,
  processor_customer_id TEXT,
  processor_subscription_id TEXT,
  updated_at INTEGER NOT NULL
);

-- Append-only. Not ON DELETE CASCADE: the record outlives the company,
-- mirroring authorization_audit (identityStore.ts:157-160).
CREATE TABLE IF NOT EXISTS company_audit (
  audit_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL
    CHECK (length(company_id) BETWEEN 1 AND 128),
  account_id TEXT,                       -- subject account when the action names one
  action TEXT NOT NULL CHECK (action IN (
    'company-create','company-disable','company-enable',
    'member-add','member-remove','role-change',
    'seat-assign','seat-revoke','seat-release','entitlement-change'
  )),
  actor TEXT NOT NULL
    CHECK (length(trim(actor)) > 0 AND length(actor) <= 256),
  reason TEXT NOT NULL
    CHECK (length(trim(reason)) > 0 AND length(reason) <= 1024),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_company_audit_company
  ON company_audit(company_id, created_at);
```

Notes on the hard design questions:

- **Who holds plan state when several tutors share a company?** The company
  does. `company_entitlements` is the purchased plan; `company_seats` maps
  paid units to accounts; the *effective* plan of an account is derived:
  `company plan` if the account has an assigned seat in an `active` company
  with `trialing|active|past_due` entitlement, else its personal entitlement,
  else Free. Derive at read time; do not duplicate plan rows per member (drift
  risk). **[assumption]** A small pure resolver (e.g.
  `effectivePlanForAccount(db, accountId, now)` in `src/lib/plan/`) keeps this
  unit-testable per AGENTS.md's "unit tests are for pure modules".
- **Per-seat vs company-level entitlement.** This is the SEC-015 conflict: the
  current contract says "entitlement as server-owned state keyed by local
  `account_id`" (`security.md:872-875`). A company-keyed plan is a material
  amendment. The compromise consistent with the *spirit* of SEC-015 is:
  processor webhooks update `company_entitlements` (server-owned, no client
  input); each seat assignment writes a derived state for one `account_id`; all
  seat changes are audited and epoch-bound. That still needs the owner to
  re-confirm line 872's wording.
- **Seat assignment mechanics.** `assignSeat(companyId, accountId, actor)`:
  require caller role in (`owner`,`admin`); require target is a member (or add
  member in the same transaction); reject when
  `COUNT(seats WHERE company_id=? AND status='assigned') >= seat_limit` with a
  dedicated 402 "Plan limit reached" (`src/lib/plan/limits.ts:13-14`); flip an
  existing `account_id IS NULL` seat or insert a new assigned row; write
  `company_audit`; then advance the target account's epoch (see below).
  `revokeSeat` sets `status='revoked'`, `revoked_at`, writes audit, and
  advances the member's epoch.
- **One-account-one-company vs multi-company.** v1: one, enforced by
  `company_members_one_per_account`. Reason: one effective-plan derivation, one
  "current company" context, no UI for switching. Multi-company is a dropped
  index plus a context parameter, not a redesign — but it changes
  `effectivePlanForAccount` (max over companies) and every company route's
  "which company" resolution, so decide now. **[owner decision]**
- **Students/guests out of company membership.** Two layers:
  1. `company_members` writers reject targets whose account
     `provenance != 'access'` (guests) and self-enrollment is refused; enforce
     with a BEFORE INSERT/UPDATE trigger reading `accounts` (same mechanism as
     `src/lib/identity/identityStore.ts:75-99`), because a table CHECK cannot
     read another table.
  2. Because no tutor/student schema distinction exists, membership must be
     admin-initiated: an existing owner/admin names an `account_id` they can
     verify, or mints a single-use invite token bound to an exact
     `(issuer, subject)`. **[assumption]** Reject a bare "join company" route;
     an account cannot self-enroll into billing. Invite-by-email would require
     storing email, which the identity store explicitly forbids
     (`src/lib/identity/identityStore.test.ts:51-59`) — see Decisions.
- **Company erasure/deletion vs `pending_erasures`.** Recommended semantics:
  - Account self-erasure (`eraseOwnAccount`, `src/lib/identity/sessionStore.ts:601-636`)
    must be extended to release assigned seats, delete `company_members` rows,
    and pseudonymize `company_audit.account_id`/`actor` the same way
    `authorization_audit` is pseudonymized (`:626-632`). Otherwise a company
    seat or audit row leaks the erased account id after the erasure contract
    says identifiers were replaced.
  - Company deletion should be *disable + seat revoke + epoch bump* first, and
    only then a hard delete if required. Rooms and boards are owned per account
    via `account_rooms`/`room_members`, so company deletion must not cascade
    into tutor rooms. `pending_erasures` stays account+room scoped and needs no
    change for company-only deletion. Company deletion of retained audit rows:
    keep `company_audit` (no FK cascade) so the operator action trail survives
    — same rationale as `src/lib/identity/identityStore.ts:157-160`.
- **Epoch implications.**
  - Seat revoke / member remove: advance the member's `authorization_epoch`
    (pattern `src/lib/identity/sessionStore.ts:653-700`), which revokes their
    sessions and makes already-open room sockets fail the RoomDO re-check
    within the 30 s alarm bound (`src/do/RoomDO.ts:2185-2189`,
    `SECURITY_REVOCATION_BOUND.md:119`). Trade-off: this logs the tutor out of
    everything, not just the company context.
  - Company disable: in one transaction, advance the epoch of every member
    account (bounded batch — reuse `MAX_AUTHORIZATION_BATCH = 500`,
    `src/lib/identity/identityStore.ts:441`) and audit each change.
  - Company enable / seat assign: no epoch advance (mirrors `enableAccount`,
    `src/lib/identity/sessionStore.ts:726-736`); the derived plan comes back on
    the next read.
  - **[owner decision]** If logging a tutor out on seat revoke is unacceptable,
    the alternative is a company epoch carried in the `/accounts/authorizations`
    response and checked by RoomDO next to the account epoch. That is a
    smaller blast radius but a new cross-DO contract and a new test surface.

---

## Route/integration points

How the existing route machinery is extended (the exact pattern for this
codebase):

1. **Worker public route**: add a constant next to
   `ACCOUNT_PROFILE`/`ACCOUNT_ROOMS` (`src/worker.ts:103-113`); add a handler
   function modeled on `accountProfile` (`src/worker.ts:515-538`) that calls
   `sessionAuthorized` first and forwards cookie+body to IdentityDO; dispatch
   it inside the `!isGuestHost && principal` block (`src/worker.ts:1007-1032`).
2. **Request guard**: `/auth/account/...` is already teacher-host-only and
   origin-guarded by prefix (`src/lib/worker/requestGuard.ts:92-94`,
   `:220`), so `PATCH /auth/account/company` is covered automatically. A new
   `/api/...` path is **not** covered: the allowlist only admits
   `/api/whiteboard/room/...`, `/api/whiteboard/rooms`, `/api/av/token`,
   `/api/av/mute` and `/signaling` (`src/lib/worker/requestGuard.ts:164-197`),
   so it must be added explicitly or every request 404s at
   `src/worker.ts:966`. Origin guarding is automatic for any `/api/` path
   (`src/lib/worker/requestGuard.ts:222`). Guest-host denial must be preserved
   (`isRouteAllowedOnHost` returns `false` for teacher-only paths on the guest
   host, `src/lib/worker/requestGuard.ts:116-118`).
3. **IdentityDO route**: add a constant (`src/do/IdentityDO.ts:53-73`), a body
   guard shaped like `isProfileBody`/`isOwnedRoomBody`
   (`src/do/IdentityDO.ts:157-198`), and a `fetch` branch that validates the
   session cookie itself (model: `/accounts/profile`,
   `src/do/IdentityDO.ts:441-461`); unknown paths end in the 404 at
   `src/do/IdentityDO.ts:690`. Actor/reason-bearing mutations must copy the
   `isAccountBody` guard (`src/do/IdentityDO.ts:132-155`).
4. **Cross-DO reads**: RoomDO resolves the owner from `room_members`
   (`src/do/RoomDO.ts:1544-1547`) and reaches IdentityDO through the
   `IDENTITY` binding (`src/do/RoomDO.ts:1550-1560`,
   `src/do/RoomDO.ts:2149-2158`). Company/effective-plan reads should follow
   this same binding pattern; never trust a client-sent company id
   (compare `src/lib/worker/requestGuard.ts:288-310`).
5. **Where an org context comes from — recommendation:** DB lookup at request
   time, not a session claim. Sessions store only `account_id` + epoch
   (`src/lib/identity/identityStore.ts:120-140`); role changes within a company
   would go stale in a claim unless every role change also bumped the epoch.
   A synchronous SQLite read in IdentityDO's single-threaded DO is
   authoritative and cheap, and matches how `authorizeSessionForPrincipal`
   already re-reads `access_subjects` per request
   (`src/lib/identity/sessionStore.ts:411-427`). For real-time gating, extend
   the `/accounts/authorizations` response (`src/do/IdentityDO.ts:588-604`,
   `src/do/RoomDO.ts:2160-2167`) with effective-plan/company state, or accept
   the epoch-bump propagation. **[assumption]** Reject a `companyId` header or
   query parameter as an authorization input in all company routes.

---

## Migration plan

**[assumption]** Append-only migration inside `applyIdentitySchema`
(`src/lib/identity/identityStore.ts:40-228`), applied on every IdentityDO
construction (`src/do/IdentityDO.ts:318-322`); safe order and guards:

1. `CREATE TABLE IF NOT EXISTS companies` first, then `company_members`,
   `company_seats`, `company_entitlements`, `company_audit`, plus the two
   indexes — new tables cannot break existing rows; FKs are only to `accounts`
   and `companies` (`ON DELETE CASCADE`/`SET NULL` must be decided before
   shipping; changing FKs later needs a table rebuild, as
   `src/lib/whiteboard/roomSchema.ts:163-191` shows).
2. No new columns on `accounts` are required if effective plan is derived. If a
   cached `company_id` is ever added, use the `PRAGMA table_info` +
   `ALTER TABLE ADD COLUMN` guard (`src/lib/identity/identityStore.ts:59-68`,
   `:215-227`).
3. Add company membership/provenance triggers with
   `CREATE TRIGGER IF NOT EXISTS`, one per direction
   (`src/lib/identity/identityStore.ts:75-99`); triggers are the only way to
   enforce "member must be an access account" across tables and work on
   migrated databases.
4. Keep "absence of a row = Free": no backfill for existing accounts; a
   company row without `company_entitlements` is Free
   (`security.md:1003-1004`).
5. Idempotency is mandatory and tested: run twice, and against a legacy DB
   shape (`src/lib/identity/identityStore.test.ts:75-80`, `:581-609`). The
   exact-table-list assertion (`src/lib/identity/identityStore.test.ts:35-42`)
   must be updated in the same red step that adds the first table, or the suite
   fails for the wrong reason.
6. Do not put any of these tables in the per-room schema; the identity store
   test already asserts identity tables do not leak into a room DB
   (`src/lib/identity/identityStore.test.ts:62-73`).

---

## TDD test plan

Red first, one behavior per cycle, real objects only, negative tests for every
guard, then targeted mutation (AGENTS.md "Strict TDD", "Mutation testing").

Existing files to extend (red before implementation):

- `src/lib/identity/identityStore.test.ts`
  - update exact table list (`:35-42`) to include the company tables;
  - migration/idempotency for the new tables and legacy DB shape
    (pattern `:534-609`);
  - NEGATIVE trigger tests: guest-provenance account cannot be added to a
    company (mirror `:611-641`);
  - one-company unique index rejects a second membership; seat partial unique
    index rejects two active seats for one account; re-assign after revoke
    succeeds;
  - `effectivePlanForAccount` precedence (company > personal > Free; disabled
    company and revoked seat fall back).
- `src/lib/identity/sessionStore.test.ts`
  - erasure releases seats, deletes membership, pseudonymizes `company_audit`
    (model `:400-434`, `:436-468`);
  - seat revoke advances the member's epoch and revokes their sessions
    (model the audit assertions at `:515+`); company disable advances every
    member's epoch in one transaction;
  - NEGATIVE: revoke/disable for one company never touches another company's
    members or the personal account of an unseated account.
- `src/do/identityDO.workers.test.ts`
  - new route method/body/401/403 negatives in the style of `:224-265` and
    `:494-522`;
  - caller-only scoping for company profile routes (model `:559-608`);
  - seat-limit 402 with the standard body (model `:960-982`);
  - seat revoke/disabling company reflected in `/accounts/authorizations`
    (model `:731-767`);
  - NEGATIVE guest cookie and malformed body (model `:1208-1256`);
  - public-path denial for any new internal path (model `:1087-1102`).
- `src/lib/plan/limits.test.ts` — company plan catalog entries, seat/room
  limits, and "student never reaches billing" predicate (pure function).
- `src/lib/worker/requestGuard.test.ts` — host allow/deny for any new
  `/api/...` company path (`:115-118`, `:312-329`).
- `src/lib/whiteboard/handlers/room.test.ts` and
  `src/worker.access.workers.test.ts` — owner-plan gating: a company seat
  raises `maxUsers`/room caps, a revoked seat does not (models `:162-191` and
  `:1322-1382`).
- `tests/e2e/account-profile.spec.ts` or a new
  `tests/e2e/corporate-account.spec.ts` — browser flow: create company, assign
  seat, see plan-gated room behavior, revoke seat loses it; must use polling
  helpers, no `waitForTimeout` sampling (AGENTS.md "E2E").

New worker-test files likely needed (one behavior each, real DO SQLite):
`src/do/companyMembership.workers.test.ts`, `src/do/companySeats.workers.test.ts`,
`src/do/companyEpoch.workers.test.ts` (or fold into
`identityDO.workers.test.ts` if it stays under control).

Guard mutants that must be killed (one at a time, then reverted):

1. invert the member-role check on seat assignment (`member` allowed) — the
   wrong-role worker test must fail;
2. delete the guest-provenance trigger — the NEGATIVE membership test must
   fail;
3. remove the seat-limit comparison — the 402 seat test must fail;
4. remove the epoch increment on seat revoke — the live-socket/authorization
   test must fail.

---

## Risks & open questions

1. **Direct SEC-015 conflict — needs owner re-confirmation (not a finding to
   paper over).** `security.md:953-961` records the 2026-08-18 owner decision:
   private tutors, "**This is not a school product: no seat pools, no rosters,
   no district billing, no admin consoles**", and `security.md:988-990` says
   "**No School tier**". The requested corporate model (company record with
   owner/admin membership and seat assignment) is a seat pool with an admin
   surface. The merged spec must either (a) get the owner to amend that
   decision in `security.md`/the spec, or (b) drop seats and model "corporate"
   as something else. Silence here would make the spec contradict the
   security contract it claims to extend.
2. **Entitlement keying conflict.** `security.md:872-875` requires
   entitlement keyed by `account_id` in the identity store; a company plan is
   company-keyed. The derived-effective-plan design minimizes the drift but
   still needs line 872 amended (or the owner choosing per-account seats with
   per-account entitlement rows).
3. **No tutor/student account kind.** Nothing server-side distinguishes a
   student (see "Current model §1"). Until an invite/grant gate or account kind
   exists, "students never reach a payment flow" (`security.md:895-897`,
   `:1068-1073`) is a route-reachability claim, not a data-model one.
4. **Epoch-bump blast radius.** Seat revoke revoking *all* sessions of a tutor
   is safe but hostile; a company epoch is scoped but expands the DO contract.
5. **Invite identity requires PII the store forbids.** Email invites need
   email storage; `accounts` deliberately has none
   (`src/lib/identity/identityStore.test.ts:51-59`), and SEC-016 governs
   minors' data. Token/invite-by-existing-account avoids it but has worse UX.
6. **Company deletion vs room/board retention.** Rooms are account-owned
   (`src/lib/identity/identityStore.ts:187-199`); a company delete that
   cascaded into members' rooms would destroy class boards on a billing event,
   which SEC-015's downgrade rule forbids in spirit (`security.md:1021-1027`).
7. **Catalog budget.** A corporate plan needs ids/limits/prices in the code
   catalog (`security.md:992-996`); investigator #3's market research is an
   input, but the catalog itself is a security-reviewed code change.
8. **`security.md` acceptance tests are acceptance-gated.** No company work
   may be marked complete without the e2e flow and the negative billing-route
   test that SEC-015 names (`security.md:937-944`, `:1068-1073`).

## Decisions needed from owner

1. **Re-confirm or reverse the 2026-08-18 "no seat pools / no School tier"
   decision** (`security.md:953-961`, `:988-990`) now that corporate accounts
   are requested. This is the gate for everything else in this file.
2. **Amend entitlement keying** (`security.md:872-875`): may entitlement be
   company-keyed with a derived per-account effective plan, or must each
   tutor's plan stay strictly account-keyed (company is only a grouping)?
3. **One company per account in v1, or multi-company from day one?**
4. **Who may create a company and assign seats** — any tutor, or invite-only
   from an existing company admin? Can any account with an Access identity
   found one, or must it already own a room?
5. **Seat revoke semantics**: accept "bump the member's account epoch (logs
   them out of everything)" as the revocation bound, or fund a company-scoped
   epoch checked by RoomDO?
6. **Company deletion semantics**: disable + revoke seats + keep audit and
   tutor rooms (recommended), or hard delete? What must happen to
   `company_audit` and to seats on account self-erasure?
7. **Student exclusion mechanism**: single-use invite token bound to
   `(issuer, subject)`, admin naming an existing account, or a new
   `accounts.kind` column? (Emails are not stored today.)
8. **Corporate plan catalog**: plan id(s), seat limits, price/interval, and
   whether free personal accounts keep their Free room when a paid company seat
   is assigned (downgrade must not destroy rooms, `security.md:1021-1027`).
