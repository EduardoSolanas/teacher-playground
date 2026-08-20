# Guest join — implementation specification

**Audience:** implementation subagents (Haiku or similar). Read this file in full
before writing any code. Do not improvise beyond it. Where this document and
your instinct disagree, follow this document; where this document is silent,
stop and ask rather than inventing behaviour.

**Prerequisite:** `AGENTS.md` is binding for every task here — strict TDD
(red → green → refactor), real objects only (no mocks/stubs/doubles), targeted
mutation checks on every guard, and the full suite before reporting done.

---

## 1. Goal

Let a student with **no email address and no account** join a room by opening a
link and typing a **6-digit class PIN** the teacher reads out, land in the
existing waiting room, and be admitted by the teacher.

This is the Pencil Spaces model with a PIN in place of a public/private flag:
the link plus PIN buys a place in a **queue**, never access. Every actual grant
still comes from a human owner clicking Approve.

The driving constraint is that the student population is **minors who may not
have an email address at all**. That eliminates Google, Facebook, and one-time
email PIN delivery — every existing authentication path in this repo. Anonymous
join is therefore not a convenience feature; it is the only viable student path.

The privacy posture follows from the same fact: **collect nothing.** A guest
supplies a self-chosen display name and nothing else. No email, no OAuth
subject, no third-party identity broker record of a child's session.

---

## 2. Assumptions (stated, not verified with the product owner)

| # | Assumption | Rationale |
| --- | --- | --- |
| A1 | Entry is a **typed 6-digit PIN**, never a secret embedded in the URL. | Chosen by the product owner. Matches how a classroom works — the teacher says it aloud or writes it on the board. Because it is never in a URL, it does not leak through screen shares, browser history, or forwarded links. |
| A2 | Guests are admitted through the **existing** approve flow, with the owner choosing `peer` or `viewer` per approval. | `approveRoleFromPayload` already supports it; no new UI semantics. |
| A3 | A guest identity is **scoped to exactly one room** and is disposable. It never becomes a cross-room identity. | Minimises the durable record attached to a child. |
| A4 | Guests never create, own, moderate, or configure a room, and never appear in any owner-only payload beyond the queue entry they create. | Least privilege. |
| A5 | Guests reach the app on a **separate hostname with no Cloudflare Access application in front of it**. Teachers keep Access on their hostname, unchanged. | Chosen by the product owner. See §5. |

---

## 3. The PIN threat model — read before Task 3

A 6-digit PIN is **~20 bits**. One million guesses is not a large number. The
PIN is therefore **not** the security boundary and must never be treated as one.
Three controls carry the weight, and all three are mandatory:

1. **Per-IP rate limit** — 5 attempts/minute on `POST /auth/guest`.
2. **Per-room lockout** — a sliding window of failed attempts across *all*
   sources. 50 failures in 10 minutes locks guest join on that room for 15
   minutes. This is what defeats a distributed attack that walks around the
   per-IP limit. With it, an attacker gets roughly 7,200 guesses/day against a
   1,000,000-space — about 139 days for even odds, against a PIN that expires in
   12 hours.
3. **Mandatory expiry** — a PIN expires 12 hours after issue and can be rotated
   by the owner at any time.

The threshold of 50 is deliberately loose: a class of 30 children typing a
6-digit code will produce typos, and a lockout that trips during a real lesson
is a worse failure than a slightly wider attack window. Do not tighten it
without replacing it with something equally usable.

**The PIN is stored in plaintext.** This is a deliberate decision, not an
oversight, and the reasoning must survive into the code comment:

- The teacher must be able to *read the PIN back* at the start of every session.
  A hash cannot be displayed, so hashing it would break the primary use case.
- The threat model is **online guessing**, which the lockout addresses, not
  offline cracking. A 20-bit secret falls to an offline attack in milliseconds
  regardless of the KDF chosen, so a KDF buys nothing real here.
- If Durable Object storage is compromised, the attacker already holds the board
  contents and the member list. The room PIN is not the crown jewel in that
  scenario.

Comparison must still be **constant-time**, to deny a timing oracle.

---

## 4. Security-document amendments this feature requires

Do not quietly break written rules. Each amendment below must land in the same
commit series, or the change is not complete.

1. **`security.md:90`** — the authorization matrix says `Unauthenticated: no` on
   every row, including *Request access*. Amend so that a guest holding a valid
   guest session is a distinct principal column, with `no` in every owner-only
   row.
2. **`CLOUDFLARE_ACCESS_STAGING.md`** — currently describes a single Access
   application and assumes every route sits behind it. Amend to describe **two
   hostnames**: the teacher hostname with the existing application unchanged,
   and the guest hostname that **intentionally has no Access application at
   all**. State plainly that adding an Access application to the guest hostname
   breaks guest join, and that the Access app on the teacher hostname must be
   scoped to that **exact hostname, never a wildcard** — see §6.5.

> Two rules that a path-based bypass *would* have broken are **not** touched by
> this design, and that is the main reason it was chosen:
> - `CLOUDFLARE_ACCESS_STAGING.md:20` ("do not create path-specific Access
>   applications") survives intact — there is no path application and no
>   `Bypass` policy anywhere.
> - `security.md:77` ("no authorization material in URLs") survives intact,
>   because the PIN is typed rather than carried in the link. The "or logs" half
>   of that rule still binds absolutely: see §10.

Also add a short **minors / data-minimisation** section to
`SECURITY_DATA_PROTECTION.md`. Nothing in the repository currently mentions
minors, COPPA, FERPA, GDPR-K, age gating, or parental consent —
`MISSING_FEATURES.md:259` parks compliance as out of scope. That is a legitimate
engineering decision, but if minors are the actual user base it changes what
counts as PII, and the docs should say so explicitly rather than leave it
implicit.

---

## 5. Architecture: two hostnames

### 5.1 Why

`src/worker.ts:590` calls `verifyAccessRequest` on every non-marketing request,
and Cloudflare Access also sits in front of the hostname at the edge. A guest
with no Access JWT never reaches Worker code.

The chosen resolution is the one the reference product uses. Pencil Spaces
serves its app from `my.pencilapp.com` with **no identity proxy in front** — an
anonymous request gets a 200 and the app shell, and the application decides what
the caller may do. Their marketing site is a different domain entirely.

We do the same for the student path only:

| Hostname | Access application | Serves |
| --- | --- | --- |
| `app.<zone>` (teacher) | **Yes** — existing, unchanged | Everything |
| `join.<zone>` (guest) | **No — deliberately none** | Guest surface only (§6.1) |

Both hostnames route to the **same Worker**. The Worker, not the edge, is the
authorization boundary on the guest hostname — which is what
`CLOUDFLARE_ACCESS_STAGING.md:26` already says Access is for ("coarse
authentication, not endpoint authorization").

The decisive advantage over poking a `Bypass` hole in one hostname: the boundary
becomes **code with failing tests**, instead of a dashboard setting that this
repository cannot verify. It also preserves Access logging in full on the
teacher hostname, which a `Bypass` policy would have destroyed.

### 5.2 The principal is determined by hostname

There is no ambiguity to resolve and no content-sniffing. **The hostname decides
what kind of caller this can be**, before anything else runs:

```ts
type Caller =
  | { kind: 'access'; principal: VerifiedAccessPrincipal }  // teacher host only
  | { kind: 'guest'; session: ValidatedSession; roomId: string } // guest host only
  | { kind: 'anonymous' };  // guest host, static assets + /auth/guest only
```

- On the **teacher hostname**: behave exactly as today. Access-verify or 401.
  Guest cookies are never read, and `/auth/guest` returns 404.
- On the **guest hostname**: never call `verifyAccessRequest` at all. Read the
  guest cookie; a request to a teacher-only route returns 404.
- On **any other hostname**: 404. Fail closed.

A guest session is bound to one room. A request targeting a different room is
denied at the Worker, before the Durable Object is reached.

### 5.3 Cookie isolation is now browser-enforced

Guest sessions use a **separate cookie name**, `__Host-teacher-guest`, distinct
from `__Host-teacher-session`.

Under the split-hostname model this is enforced twice over:

- **By the browser.** `__Host-` cookies are host-scoped with no `Domain`
  attribute, so a cookie set on `join.<zone>` is never sent to `app.<zone>`, and
  vice versa. Cross-contamination is not merely unlikely; the browser will not
  do it.
- **By name.** A guest session can never satisfy `sessionAuthorized()`, because
  that function reads the teacher cookie name. Every teacher-only route stays
  closed to guests by construction, not by an allowlist someone can forget.

Keep both properties. Do not "simplify" them into one cookie or one hostname.

Guest sessions still live in the **existing `sessions` table**, so idle TTL,
absolute TTL, revocation, and the authorization-epoch machinery all apply
unchanged. Only the cookie name and the lifetime differ.

### 5.4 No eligibility probe — by design

There is deliberately **no** endpoint answering "does this room accept guests?".
The room page always shows the guest prompt, and a wrong PIN, a guest-disabled
room, a locked-out room, and a non-existent room all return the **same generic
failure**.

This is stronger than Pencil Spaces, where the presence or absence of the
"Continue as Guest" button reveals whether a Space exists and is public. Here
nothing distinguishes those cases, so the endpoint cannot enumerate room ids.

### 5.5 Trust summary

| Artifact | Grants | Does not grant |
| --- | --- | --- |
| Room link on the guest host | Sight of a name + PIN form | Nothing else |
| 6-digit PIN | The right to POST `/auth/guest` for that room | Any room data, any membership |
| Guest session cookie | The right to queue, poll own status, and act as self in one room | Read of board, presence, queue, or settings |
| Owner approval | `editor` or `viewer` membership, via the existing flow | Ownership, moderation |

---

## 6. Routing and data model

### 6.1 Route-to-hostname map (the firewall rule — review as such)

Every route belongs to **exactly one** category. A route in the wrong column is
a security bug, not a cosmetic issue.

**Teacher hostname only** — 404 on the guest hostname:

```
/                       marketing
/pricing /terms /privacy
/whiteboard             room list page
/auth/session*          teacher session issue/current/confirm/logout
/auth/account*          export, erase, profile
/api/whiteboard/rooms   owned-room list
```

**Guest hostname only** — 404 on the teacher hostname:

```
POST /auth/guest        issue a guest session
```

**Both hostnames** — principal kind decided by host per §5.2:

```
GET/HEAD /whiteboard/<roomId>       room placeholder page (32 lowercase hex)
GET/HEAD /_next/*                   JS/CSS bundles
GET/HEAD /excalidraw-assets/*       fonts and static editor assets
GET/HEAD /favicon.ico
         /api/whiteboard/room/:id*  room API, per §6.2
         /api/av/token              LiveKit join tokens (Worker POST-only)
         /signaling                 real-time transport, granted only
```

`POST /auth/guest` is guest-host-only on purpose: a guest session can then never
be minted on the Access-protected origin.

Traversal (`..`), suffix variants, and unexpected methods must all fail closed.
Test each.

### 6.2 Guest permissions on the room API

On the guest hostname a valid, room-bound guest session is required for every
row below. `/settings` is refused at the **host layer** as well, so it is
unreachable from the guest hostname regardless of grant.

| Path | Method | Guest allowed |
| --- | --- | --- |
| `/api/whiteboard/room/:id` | GET | only once granted |
| `/api/whiteboard/room/:id` | POST | never on a non-existent room (create); scene write only once granted editor — see §6.3 |
| `/api/whiteboard/room/:id` | DELETE | **never** |
| `/api/whiteboard/room/:id/access` | GET | yes |
| `/api/whiteboard/room/:id/requests` | POST | yes (self only) |
| `/api/whiteboard/room/:id/requests` | GET | **never** |
| `/api/whiteboard/room/:id/requests/:rid` | POST | **never** |
| `/api/whiteboard/room/:id/presence` | POST/DELETE | yes, self only, never `kick`/`suspend` |
| `/api/whiteboard/room/:id/presence` | GET | only once granted |
| `/api/whiteboard/room/:id/waiting` | DELETE | yes, self withdrawal only |
| `/api/whiteboard/room/:id/waiting` | GET/POST | **never** |
| `/api/whiteboard/room/:id/settings` | any | **never** (host layer + authz layer) |
| `/api/whiteboard/room/:id/av` | POST | only once granted |
| `/api/whiteboard/room/:id/guest-verify` | any | **never — 404 on both hostnames** (see below) |
| `/signaling?room=:id` | upgrade | only once granted, room-bound |

**`guest-verify` is internal-only and must never be reachable through the public
room API, on either hostname.** The Worker's `ROOM_API` branch forwards arbitrary
subpaths (`/room${subpath}`), and the RoomDO `guest-verify` branch deliberately
runs *before* the `accountId` check. Left open, that combination lets any
authenticated account brute-force the join PIN of any room it has no membership
in — bounded only by the per-room lockout, and never by the per-IP limiter, which
lives on `/auth/guest`.

The Worker must refuse the subpath with **404** (not 403 — a 403 confirms the
route exists) for every method. The `/auth/guest` handler reaches the DO route by
constructing its own internal request, never by proxying a client-supplied path.

> Found by an independent security audit of the working tree, not by this
> specification — §6.1 originally omitted `guest-verify` entirely. Task 8 must
> preserve the refusal; the regression tests live in
> `src/worker.access.workers.test.ts`.

### 6.3 Scene write

A guest admitted as `editor` writes the board through the same
`POST /api/whiteboard/room/:id` path as anyone else. The room-root POST is
therefore not blanket-denied for guests — it is denied **when the room does not
exist** (that is the create path) and otherwise falls through to the existing
`canWriteBoard(role)` check. Implement it exactly that way; do not add a second
role check.

### 6.4 Schema changes

**`src/lib/whiteboard/roomSchema.ts`** — additive columns on `rooms`, following
the existing `PRAGMA table_info` migration idiom in that file:

```sql
guest_access            INTEGER NOT NULL DEFAULT 0  -- off unless the owner opts in
guest_pin               TEXT                        -- plaintext, 6 digits; see §3
guest_pin_expires_at    INTEGER                     -- issue + 12h
guest_failed_count      INTEGER NOT NULL DEFAULT 0  -- lockout window counter
guest_failed_window_at  INTEGER                     -- start of the current window
guest_lockout_until     INTEGER                     -- non-NULL while locked out
```

`guest_access = 0` is the secure default; every existing room migrates to it.

**`src/lib/identity/identityStore.ts`** — additive columns on `accounts`:

```sql
provenance    TEXT NOT NULL DEFAULT 'access'
              CHECK (provenance IN ('access','guest'))
guest_room_id TEXT                             -- non-NULL iff provenance='guest'
```

Existing rows migrate to `'access'`, the secure default.

**Enforcement is by trigger, not by CHECK — this is settled, do not "fix" it
back.** SQLite cannot add a CHECK constraint via `ALTER TABLE`, and rebuilding
`accounts` is unsafe here: `access_subjects` and `sessions` both hold
`FOREIGN KEY ... REFERENCES accounts(account_id) ON DELETE CASCADE`, and
`applyIdentitySchema` runs under `PRAGMA foreign_keys = ON`, so a drop-and-rename
risks cascade-deleting live account data. Two triggers —
`accounts_provenance_insert` (BEFORE INSERT) and `accounts_provenance_update`
(BEFORE UPDATE) — `RAISE(ABORT)` unless
`(provenance='access' AND guest_room_id IS NULL) OR (provenance='guest' AND guest_room_id IS NOT NULL)`.
One mechanism for fresh and legacy databases alike, so they cannot diverge.

> **Implemented and verified** (Tasks 1 and 2 are complete). The first attempt at
> Task 2 added the columns only inside `CREATE TABLE IF NOT EXISTS`, which is a
> no-op on an existing table, so every deployed database would have been left
> without the columns entirely. A full green suite did not catch it, because the
> migration test wrote into a table the fixture had already created *with* the
> new columns.
>
> **Rule for every remaining schema task:** a migration test MUST hand-build a
> table using the genuine OLD DDL, then call the schema function, then assert.
> `src/lib/whiteboard/roomDb.test.ts` is the reference shape. Re-applying the
> schema to an already-current table proves nothing.

**`room_members`** — no schema change. For a guest, `email` must be written as
`NULL` **structurally**: the guest request path must not have an email field to
pass, not merely leave it unset.

### 6.5 Cloudflare and Wrangler configuration (owner-applied, not code)

Record this in `CLOUDFLARE_ACCESS_STAGING.md` and `DEPLOY.md`. The repository
cannot apply or verify any of it — per that document no authorized Cloudflare
account exists yet — so it stays a written contract.

- **Teacher hostname:** one self-hosted Access application scoped to that
  **exact hostname**. It must **not** be a wildcard application. A `*.<zone>`
  application would also cover the guest hostname and silently break guest join
  — Cloudflare wildcards match one label, so `*.example.com` does match
  `join.example.com`.
- **Guest hostname:** DNS record and Worker route, and **no Access application
  of any kind**. Its absence is the design. Anyone adding one has broken the
  feature.
- **No `Bypass` policy anywhere.** This design does not need one, and a `Bypass`
  would disable Access request logging for whatever it covers.
- **`workers_dev = false`.** [`wrangler.toml:6`](wrangler.toml) still has it
  `true` behind a TODO. Today that is survivable because the Worker demands an
  Access JWT everywhere. Once the guest surface exists, `*.workers.dev` is a
  working unauthenticated entrance that skips the zone's WAF and rate limiting.
  **This is a release blocker for the feature, not a cleanup task.**
- **Rate limiting:** the free plan allows exactly one rate-limiting rule
  (`security.md:388`). Spend it on `POST /auth/guest` on the guest hostname. It
  is now the most abusable unauthenticated route in the system, and room
  creation is already account-gated with app-level quotas.
- **Env vars:** add `TEACHER_HOSTNAME` and `GUEST_HOSTNAME` to `Env` and
  `wrangler.toml`. If either is unset, the Worker must treat **every** request
  as teacher-host (fail closed — the guest surface simply does not exist), never
  the reverse.

---

## 7. Task sequence

One behaviour per red/green cycle. One task per subagent. Do not fan out
overlapping edits to the same file. Tasks are ordered by dependency; do not start
a task before its predecessors are green.

Every task's red step must fail for the **right reason** (assertion or missing
symbol), never a syntax error in the test.

---

### Task 1 — room schema columns

**Files:** `src/lib/whiteboard/roomSchema.ts`, `src/lib/whiteboard/roomDb.test.ts`

**Red:** following the existing migration tests in `roomDb.test.ts`, assert that
`applySchema` on a legacy `rooms` table adds all six columns from §6.4, and that
a pre-existing row survives with `guest_access = 0`, `guest_pin IS NULL`, and
`guest_failed_count = 0`.

**Green:** `PRAGMA table_info` guarded `ALTER TABLE` blocks, matching the style of
the `allow_first_user_host` block immediately above.

---

### Task 2 — guest accounts in the identity store

**Files:** `src/lib/identity/identityStore.ts`, `identityStore.test.ts`

**Red:**
- `applyIdentitySchema` adds `provenance` and `guest_room_id`; existing rows
  become `'access'`.
- `createGuestAccount(db, { roomId, now })` returns an account with
  `provenance='guest'` and the given `guest_room_id`.
- **Negative:** inserting `provenance='guest'` with a NULL `guest_room_id` is
  rejected by the database.
- **Negative:** `resolveAccountForSubject` never returns or mutates a guest
  account — a guest account is not reachable through the `(issuer, subject)`
  path at all.

**Mutation check:** flip the `provenance` CHECK to permit anything; the negative
test must fail.

---

### Task 3 — the PIN module

**Files:** new `src/lib/whiteboard/guestPin.ts` + `guestPin.test.ts`

Pure module over `RoomDatabase`. No I/O, synchronous. Re-read §3 before starting.

**Red — issue and shape:**
- `issueGuestPin(db, roomId, now)` sets `guest_access = 1`, stores a 6-digit PIN,
  sets `guest_pin_expires_at = now + 12h`, and returns the PIN.
- The PIN is exactly 6 characters, all digits, leading zeros preserved
  (`'004271'` is valid — generate as a zero-padded string, never as a number).
- Drawn from `crypto.getRandomValues`, **not** `Math.random`. Assert the absence
  of `Math.random` in the module the way `security.md:405` does for room ids.
- Rotation produces a different PIN and invalidates the previous one.
- `revokeGuestAccess(db, roomId)` sets `guest_access = 0` and nulls the PIN.
- `readGuestPin(db, roomId)` returns the plaintext for owner display, or null.

**Red — verification (all negatives required):**
- Correct PIN on an enabled, unexpired, unlocked room → `{ ok: true }`.
- Wrong PIN, `guest_access = 0`, expired PIN, non-existent room, and a PIN issued
  for a *different* room → all `{ ok: false, reason: 'invalid' }`, **the same
  reason** in every case, never a distinguishable one.
- Empty string, whitespace, `'12345'`, `'1234567'`, `'abcdef'`, `' 123456'` →
  rejected without touching the lockout counter for malformed input.

**Red — lockout:**
- 49 failures inside the window → still accepting attempts.
- The 50th failure sets `guest_lockout_until = now + 15min`.
- While locked out, even the **correct** PIN returns
  `{ ok: false, reason: 'invalid' }`. Assert this explicitly — it is the whole
  point of the control.
- After the lockout expires, the correct PIN works again and the counter resets.
- The window slides: 40 failures, an 11-minute gap, then 40 more does **not**
  trip the lockout.

**Green:** constant-time comparison over the two 6-character strings — compare
every character and accumulate with bitwise OR; never early-return on the first
mismatch. Put the §3 reasoning in a module-level comment.

**Mutation checks (all three required):**
1. Make the comparison early-return on mismatch → the constant-time-shape test
   must fail.
2. Make `verifyGuestPin` ignore `guest_lockout_until` → the "correct PIN during
   lockout" test must fail.
3. Make the disabled-room and wrong-PIN branches return distinguishable reasons
   → the identical-reason test must fail.

---

### Task 4 — RoomDO guest-verify route

**Files:** `src/do/RoomDO.ts`, `src/do/roomDO.workers.test.ts`

This is the **one** route that runs without an `accountId`, because the guest has
no account yet. `RoomDO.fetch` currently returns 401 whenever `accountId` is
absent (`src/do/RoomDO.ts:189`). Relax that for **exactly** the `guest-verify`
section and nothing else.

**Red:**
- `POST /room/guest-verify` with a valid PIN on a guest-enabled room → 200
  `{ ok: true }`.
- **Negative:** wrong PIN, `guest_access = 0`, missing room, expired PIN, and
  locked-out room all → the **same** 403 with the **same** body. Assert byte
  equality between at least two of these responses.
- **Negative:** a tombstoned room → the existing tombstone response.
- **Negative:** any **other** section without `accountId` → still 401. Assert for
  at least `''`, `/settings`, and `/presence`.
- **Negative:** the response contains no room name, no member list, no queue, and
  no PII.

**Mutation check:** widen the no-`accountId` branch to any section; the "other
section still 401" test must fail.

---

### Task 5 — guest session issue and validation

**Files:** `src/lib/identity/sessionStore.ts`, `sessionStore.test.ts`

**Red:**
- `GUEST_SESSION_COOKIE_NAME === '__Host-teacher-guest'`.
- `issueGuestSession(db, { accountId, roomId })` returns a session bound to that
  room, `absolute_expires_at` at most `GUEST_SESSION_ABSOLUTE_TTL_MS` (**4
  hours** — deliberately shorter than the 12h teacher session).
- `guestSessionCookie()` emits `__Host-` prefix, `HttpOnly`, `Secure`,
  `SameSite=Lax`, `Path=/`.
- `authorizeGuestSession(db, token, roomId)` returns the session for the bound
  room.
- **Negative:** null for a different room id, a revoked session, past idle TTL,
  past absolute TTL, a token belonging to an `access` account, and a disabled
  account.
- **Negative:** `parseSessionCookie` (teacher) does **not** read the guest cookie,
  and the guest parser does not read the teacher cookie. Assert both directions.

**Green:** new functions beside the existing ones. Reuse `purgeExpiredSessions`,
the epoch logic, and the hashing already present. Do not fork the sessions table.

**Mutation check:** drop the room-id comparison in `authorizeGuestSession`; the
cross-room test must fail.

---

### Task 6 — IdentityDO guest routes

**Files:** `src/do/IdentityDO.ts`, `src/do/identityDO.workers.test.ts`

**Red:**
- `POST https://identity/guests/issue` `{ roomId, displayName }` → 201, sets the
  guest cookie, creates a guest account bound to that room.
- **Negative:** missing/blank `roomId`, missing/blank `displayName`, an
  over-length `displayName`, and any extra unexpected field → 400 via the
  existing `readExactJson` strictness.
- **Negative:** the response body never contains the session token.
- `POST https://identity/sessions/authorize-guest` validates the guest cookie; a
  teacher cookie presented here → 401.
- `POST https://identity/guests/purge` `{ roomId }` deletes every guest account
  bound to that room, cascading its sessions, leaving `access` accounts
  untouched.

**Mutation check:** make `/guests/purge` drop the provenance filter; the "access
accounts untouched" test must fail.

---

### Task 7 — hostname routing

**Files:** `src/lib/worker/requestGuard.ts`, `requestGuard.test.ts`

**Red:** a new exported pure function
`routeHostKind(hostname, teacherHost, guestHost): 'teacher' | 'guest' | 'unknown'`
and `isRouteAllowedOnHost(pathname, method, hostKind): boolean`, encoding §6.1
exactly.

Required cases:
- `routeHostKind` returns `'unknown'` for any third hostname, for an empty
  hostname, and — critically — when `guestHost` is undefined it must **never**
  return `'guest'`.
- Teacher-only paths on the guest host → false. Assert every entry in the
  teacher-only list of §6.1 individually, not as a loop over a shared constant;
  a loop over the same constant the implementation uses proves nothing.
- `POST /auth/guest` on the teacher host → false.
- `/whiteboard/<32-hex>`, `/_next/*`, `/excalidraw-assets/*` on GET/HEAD → true
  on both hosts; POST on those same paths → false.
- `/whiteboard/../etc`, `/whiteboard` with no id on the guest host, and
  trailing-dot or double-slash variants → false.
- `/api/whiteboard/room/<id>/settings` on the guest host → false.

**Mutation check:** make `routeHostKind` fall back to `'guest'` when
`GUEST_HOSTNAME` is unset; the fail-closed test must fail.

---

### Task 8 — Worker: host dispatch and the guest session path

**Files:** `src/worker.ts`, `src/worker.access.workers.test.ts`

Split into three red/green cycles, in this order:

**8a — host dispatch.** Resolve the host kind first, before
`verifyAccessRequest`.
- Teacher host: byte-for-byte today's behaviour. Assert at least three existing
  routes are unchanged, including a 401 with no Access JWT.
- Guest host: `verifyAccessRequest` is **never called**. Prove it — a request to
  the guest host carrying a deliberately invalid `Cf-Access-Jwt-Assertion` must
  still be served normally, which is only possible if verification never ran.
- Guest host, teacher-only path → 404. Teacher host, `/auth/guest` → 404.
- Unknown host → 404.

**8b — `POST /auth/guest`** (guest host only). Body `{ roomId, pin, displayName }`.
Origin-guarded (reuse `originGuard`; add the path to its guarded set — the
existing exact-origin comparison already works per-hostname). Verifies the PIN
via the Task 4 route, issues the session via Task 6, returns `{ ok: true }` plus
the cookie.
- **Negative:** wrong PIN, guest access off, and locked out → 403 with an
  identical body in all three cases.
- **Negative:** missing origin → 403; cross-origin `Origin` naming the *teacher*
  host → 403; non-POST → 405; oversized body → 413; non-JSON content type → 415.
- **Negative:** the PIN never appears in any emitted auth event. Assert against
  the captured writer via `setAuthEventWriterForTests`. Hard rule from §4.
- Rate-limit by `CF-Connecting-IP`, **5/min**, following the existing
  `createRateLimiter` pattern including the `local-test` strict variant.

**8c — guest API forwarding.** On the guest host, for an allowed room path with a
valid room-bound guest session, `forward()` stamps `accountId`, `accountEpoch`,
`sessionId` **and** a new `guest=1` parameter.
- **Negative:** guest session for room A used against room B → 401 at the Worker
  layer, before the DO is reached.
- **Negative:** no guest cookie at all on a room API path → 401.
- `forward()` must `set` (never append) `guest`, so a client-supplied `guest`
  parameter cannot survive — the invariant already relied on for `accountId`.

**Mutation checks:** remove the room-binding comparison → the cross-room test
must fail. Change `set` to `append` on `guest` and pass `?guest=1` from the
client → a teacher request must not become a guest request, nor the reverse.

---

### Task 9 — RoomDO guest authorization

**Files:** `src/do/RoomDO.ts`, `src/do/roomDO.workers.test.ts`

Read `guest = url.searchParams.get('guest') === '1'` and thread it into
`authorize`. Update the matrix comment block above `authorize` in the same edit.

This is defence in depth: the host layer already blocks several of these. A guest
account can also never hold an `owner` row. Add the explicit denials anyway —
two independent reasons to deny is the point.

**Red — every one of these is a required negative test:**

| Attempt (as guest) | Expected |
| --- | --- |
| `POST /room` on a **non-existent** room (create) | 403 |
| `DELETE /room` | 403 |
| `GET`/`POST`/`PATCH` `/settings` | 403 |
| `GET /waiting` | 403 |
| `GET /requests` | 403 |
| `POST /requests/:rid` (approve) | 403 |
| `POST /presence` with `action: 'kick'` or `'suspend'` | 403 |

**Red — required positive tests:**

- `POST /requests` (self) → queued as `pending`, with `email` NULL in the stored
  row. Assert the NULL directly against the database.
- `GET /access` → own status only.
- `POST /presence` join/heartbeat as self → 200.
- `DELETE /waiting?peerId=<own>` → 200; with another peer's id → 403.
- After the owner approves as `editor`: `GET /room` → 200, `POST /room` (scene) →
  200.
- After approval as `viewer`: `GET /room` → 200, `POST /room` (scene) → 403.

**Mutation check:** delete the `guest` denial for `/settings` → that test must
fail. Then delete the create guard → the create test must fail.

---

### Task 10 — signaling

**Files:** `src/do/RoomDO.ts`, `src/do/signalingAdversarial.workers.test.ts`

**Red:**
- **Negative:** a `pending` guest opening `/signaling` → refused at upgrade. This
  is the single most important test in the feature.
- A granted guest connects and is bound to `accountId`, `sessionId`,
  `authorizationEpoch`, `roomId`, `grantVersion` exactly like a teacher.
- **Negative:** on kick, the guest's socket closes `4401` and the grant version
  bumps.
- **Negative:** a guest socket for room A cannot subscribe or publish to room B.

**Green:** no new mechanism. The existing upgrade path already requires a granted
role and a non-empty `sessionId`; verify it holds and add nothing that weakens
it.

---

### Task 11 — client

**Files:** `src/app/whiteboard/[roomId]/RoomClient.tsx`,
`src/components/AccessSessionBootstrap.tsx`,
new `src/components/whiteboard/GuestJoinPrompt.tsx` + test,
`src/components/whiteboard/WaitingRoom.tsx`

**Behaviour:**
- `AccessSessionBootstrap` currently renders `unavailable` when no session can be
  issued. On the guest hostname it must render the guest prompt instead of a dead
  end. It must **not** attempt `/auth/session` on the guest host — that route
  404s there.
- `GuestJoinPrompt`: a name field, a 6-digit PIN field, one Continue button.
  **No email field — ever.** Trim and cap the name; reject empty/whitespace.
- The PIN input is `inputmode="numeric"`, `autocomplete="off"`, `maxlength=6`,
  digits only. It must **not** be `type="password"` — the child is typing a code
  the teacher just said aloud, and masking it only causes typos.
- On submit, POST `/auth/guest` via `ajaxFetch`, then fall into the normal
  waiting-room flow.
- Every failure — wrong PIN, guest access off, unknown room, lockout — shows the
  **same** message: "That PIN didn't work. Check with your teacher and try
  again." Do not let the UI become a room-enumeration oracle, and do not surface
  the lockout state, which would tell an attacker the attack is working.
- A rejected guest may retry after **3 minutes** (matching Pencil Spaces).
  Client-side spacing only; the server-side caps are the §3 lockout and
  `MAX_WAITING`.

**Red:** component tests with real DOM via Testing Library, per repo style. No
mocks — drive the real component.

---

### Task 12 — owner controls

**Files:** `src/lib/whiteboard/handlers/room.ts` (settings),
`src/components/whiteboard/TeacherRoomList.tsx`, tests alongside

**Red:**
- Owner enables guest access via `/settings` → the response carries the PIN.
- `GET /settings` as owner returns the current PIN **and** its expiry, so the
  teacher can read it out at the start of a lesson. This is why §3 stores it in
  plaintext.
- The owner UI shows the **guest-host** join URL to share, not the teacher-host
  one. A student sent the teacher-host link hits Access and cannot proceed —
  this is the most likely support complaint in the whole feature, so get the
  copied link right.
- Rotate produces a different PIN and invalidates the old one end-to-end.
- Disable sets `guest_access = 0`; a subsequent `/auth/guest` with the old PIN →
  403.
- The owner UI surfaces the lockout state and offers rotation as the remedy.
- **Negative:** a non-owner attempting any of these → 403. Assert that a granted
  `editor` — not merely an outsider — is refused, since an admitted guest could
  otherwise read the PIN.

---

### Task 13 — lifecycle and erasure

**Files:** `src/lib/whiteboard/membership.ts`, `src/worker.ts`, tests alongside

**Red:**
- Deleting a room calls `/guests/purge` for that room; guest accounts and their
  sessions are gone, `access` accounts untouched.
- Guest `pending` rows age out under the existing `WAITING_REQUEST_TTL_MS`.
- A guest account whose sessions have all expired is purged.
- **Negative:** purging room A's guests leaves room B's guests intact.

---

### Task 14 — end-to-end

**Files:** `tests/e2e/guest-join.spec.ts`, plus wiring in `scripts/run-e2e.mjs`
and `playwright.config.ts`

**Harness wiring.** The existing harness runs a local Access proxy in front of
`wrangler dev` and injects `CF_Authorization` (`scripts/run-e2e.mjs:99-101`,
`:207-210`). The two hostnames map onto that naturally:

- **Teacher origin:** `http://app.localhost:<accessProxyPort>` — through the
  Access proxy, exactly as today.
- **Guest origin:** `http://join.localhost:<wranglerPort>` — straight to the
  Worker, bypassing the proxy. This is a faithful local analogue of "no Access
  application on this hostname."

Export both as `PLAYWRIGHT_BASE_URL` and a new `E2E_GUEST_ORIGIN`, and set
`GUEST_HOSTNAME=join.localhost` / `TEACHER_HOSTNAME=app.localhost` in the
Worker's env. Chromium resolves any `*.localhost` name to loopback, so no hosts
file is needed.

**Verify first, before writing scenarios:** confirm a `__Host-` cookie is
accepted on `http://join.localhost:<port>`. Browsers treat `*.localhost` as a
secure context, and the repo already relies on this for `__Host-teacher-session`
over plain HTTP, but confirm it on the new hostname before building on it. If it
fails, stop and report — do not weaken the cookie prefix to work around it.

**Scenarios:**
1. Teacher creates a room on the teacher origin, enables guest access, reads the
   PIN from settings.
2. A **second browser context with no Access cookie** opens the room on the
   **guest origin**, sees the prompt, enters a name and the PIN, and lands in the
   waiting room.
3. Teacher sees the request and approves as editor.
4. Guest draws; the teacher's board receives it. Poll with `expect.poll` or the
   `waitForSync` helper — **never** assert on a value pulled out of
   `page.evaluate` after a fixed `waitForTimeout`.
5. Teacher kicks the guest; the guest's board disconnects.
6. **Negative:** a guest context that never submits the form cannot reach
   `/api/whiteboard/room/<id>` or `/signaling` on the guest origin.
7. **Negative:** a wrong PIN shows the generic error and grants nothing.
8. **Negative:** after the teacher disables guest access, the same PIN is
   refused.
9. **Negative:** `/auth/session`, `/auth/account/export`, and
   `/api/whiteboard/rooms` on the guest origin all 404.
10. **Negative:** `/auth/guest` on the teacher origin 404s.

Re-resolve peer rows after any admission or suspend boundary — peer ids are
re-minted, so an id captured before admission may not identify that peer after.

---

## 8. Definition of done

All four must be green, in this order:

```bash
npm test && npm run test:workers && npm run typecheck && npm run test:e2e
```

Plus:

- Every guard listed under a **Mutation check** has been manually mutated, the
  named test observed to fail, and the mutation reverted. Record each in the
  handoff.
- The two document amendments in §4 are written, plus the minors section and the
  §6.5 configuration contract.
- `security.md`'s matrix has a guest column.
- No `email` field exists anywhere on the guest request path.
- `git status` shows no unrelated files staged. The tree is edited concurrently
  by other agents — stage only files you touched.

---

## 9. Release blockers (not code)

These are owner actions. The feature must not ship without them, and no test in
this repository can prove them:

1. `workers_dev = false` in `wrangler.toml` (§6.5). Highest priority — it is a
   working unauthenticated bypass of the entire edge once guests exist.
2. Guest hostname DNS + Worker route created, with **no** Access application.
3. Teacher hostname Access application confirmed **exact-hostname, not
   wildcard**.
4. The single zone rate-limiting rule pointed at `POST /auth/guest`.

---

## 10. Guardrails

- **Never** merge the two hostnames, and never let the guest host reach a
  teacher-only route. §6.1 is the contract.
- **Never** call `verifyAccessRequest` on the guest hostname. If it is ever
  needed there, the design has been misunderstood — stop and report.
- **Never** let a guest session satisfy `sessionAuthorized`. The cookie split in
  §5.3 is the mechanism; do not "simplify" it into one cookie.
- **Never** log, echo, or emit the PIN — not in an auth event, not in an error
  body, not in a console line, not in a test fixture that prints.
- **Never** return a distinguishable error for wrong PIN vs guest-disabled vs
  unknown room vs locked out. One generic failure, everywhere, at every layer.
- **Never** trust a client-supplied `guest`, `accountId`, `roomId`, or `peerId`.
  `forward()` uses `set`, not `append`, for exactly this reason.
- **Never** add an email, age, birthday, school, or parent field to the guest
  path. The whole design rests on collecting nothing.
- **Never** generate the PIN with `Math.random`. `security.md:405` already
  records that mistake being made once in this repo.
- Any test that needs a fixed sleep to become true is wrong. A short sleep is
  acceptable only to prove something *stays* true.
- If a task needs a change this document does not describe, stop and report
  rather than widening scope.
