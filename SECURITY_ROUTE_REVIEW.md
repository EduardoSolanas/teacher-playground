# Route and real-time authorization review

Review date: 2026-09-13. Scope: every HTTP route the Worker serves on its three
hostnames, every Durable Object route those reach, and every frame the room
socket accepts, checked against the authorization contract in
[`security.md`](security.md) ("Required authorization contract"). Method: a
line-by-line read of `src/worker.ts`, `src/lib/worker/requestGuard.ts`,
`src/do/RoomDO.ts` and `src/do/IdentityDO.ts`, with each row tied to the test
that pins it, plus live probes of production on the same date.

This review was carried out by an AI code reviewer working from the source and
the test suites. It is evidence for the Phase 6 route-review item, not a
substitute for an independent human review, which is recorded as an owner action
in [`SECURITY_OPERATIONS.md`](SECURITY_OPERATIONS.md) §7.

## How a request is authorized

Every request passes the same gates, in this order. A request refused at any gate
never reaches the next.

1. **Host kind** (`routeHostKind`). The `Host` header is matched exactly against
   `TEACHER_HOSTNAME`, `GUEST_HOSTNAME` and `MARKETING_HOSTNAME`; anything else
   is `unknown` and answered 404.
2. **Host route allowlist** (`isRouteAllowedOnHost`). A path/method not listed for
   the host is 404. Path traversal (`..`) is always refused.
3. **Cloudflare Access** (teacher host only). The Access application covers the
   whole hostname at the edge; the Worker verifies the Access JWT again
   (`verifyAccessRequest`: signature, issuer, audience, expiry) before any
   session work.
4. **Origin guard** (`originGuard`). State-changing requests need an exact
   same-origin `Origin`.
5. **Local session** (`sessionAuthorized` / `guestSessionAuthorized`). The
   `__Host-` session cookie must be valid, unrevoked, within idle and absolute
   expiry, and match the account's current authorization epoch. A guest session
   is bound to one room.
6. **Durable Object matrix.** `RoomDO.authorize` and the IdentityDO route guards
   decide by the Worker-stamped account id; client-supplied ids, emails and peer
   ids are never authority.

## Marketing host (`playground.sen-tutor.co.uk`) — no Access, no sessions

| Route | Method | Rule | Evidence |
| --- | --- | --- | --- |
| `/`, `/pricing`, `/terms`, `/privacy`, `/favicon.ico`, `/logo.svg`, `/brand.css`, `/_next/*`, `/fonts/*`, `/data/*` | GET, HEAD | Static assets only; security headers and nonce CSP on HTML | `worker.marketing.workers.test.ts`; live probe 200 with HSTS, CSP, COOP, CORP |
| `/whiteboard`, `/whiteboard/<room>` | GET, HEAD | 302 to the teacher host; target from env, exact shapes only | `worker.marketing.workers.test.ts`; live probe 302 |
| `/api/billing/webhook` | POST | Stripe signature over the raw body, 300 s tolerance, body read with a 1 MiB cap, 120/min per IP, attested apply, livemode re-checked in the writer | `worker.billing.workers.test.ts` (signature, cap, rate limit, marketing host); `billing.workers.test.ts` (attestation, idempotency) |
| anything else | any | 404 | live probe `/api/whiteboard/rooms` 404 |

## Teacher host (`app-playground.sen-tutor.co.uk`) — Access, then session

| Route | Method | Authorization | Evidence |
| --- | --- | --- | --- |
| `/auth/session` | POST | Access principal; issues a local session for that principal's account; `TUTOR_ACCOUNT_CAP` refuses a brand-new account at the cap | `worker.access.workers.test.ts`, `identityDO.workers.test.ts` |
| `/auth/session/current`, `/auth/session/confirm`, `/auth/session/logout` | GET/POST | Access + own session only | `access-session.spec.ts`, `worker.access.workers.test.ts` |
| `/auth/account/profile`, `/auth/account/export` | GET/POST | Access + own session; export contains only the caller's rows | `identityDO.workers.test.ts` (export isolation) |
| `/auth/account` | DELETE | Access + own session **and** a fresh re-authentication | `identityDO.workers.test.ts` (erasure), `roomDelete.workers.test.ts` |
| `/api/whiteboard/rooms` | GET | Own session; lists only the caller's rooms | `identityDO.workers.test.ts` |
| `/api/company`, `/api/company/*` | GET/POST | Own session + exact Origin; membership and role read from the session, never the body; per-subject rate limits | `worker.company.workers.test.ts`, `company.workers.test.ts` |
| `/api/company/operator/*`, `/api/operator/accounts/{disable,enable,revoke-all}` | POST | Access-verified email on `OPERATOR_EMAILS` (404 when unset, 403 otherwise); audited with the operator as actor | `worker.company.workers.test.ts` |
| `/api/billing/checkout`, `/api/billing/portal` | POST | Own session + exact Origin; price chosen server-side, client URLs and amounts ignored, customer from the caller's entitlement; 10/min per account | `worker.billing.workers.test.ts` |
| `/api/referrals/me` | GET | Own session; only the caller's rows; 60/min | `worker.referrals.workers.test.ts` |
| `/api/billing/webhook` | POST | Same as the marketing host; unreachable in production behind Access, kept for local runs | `worker.billing.workers.test.ts` |
| `/api/whiteboard/room/<room>` and subroutes | any | Own session, then the RoomDO matrix below; `/files` and `/guest-verify` refused from the public API | `roomDO.workers.test.ts`, `roomDOGuards.workers.test.ts` |
| `/api/whiteboard/room/<room>/files/<file>` | PUT/GET | RoomDO `authorize-write` / `authorize-read`; per-file and per-room byte quotas | `roomFileQuota.workers.test.ts`, `board-images.spec.ts` |
| `/api/av/token`, `/api/av/mute` | POST | Own session, then RoomDO `/room/av` | `roomDO.workers.test.ts` |
| `/signaling?room=` | GET upgrade | Own session + exact Origin; per-room and per-account socket caps | `signalingAdversarial.workers.test.ts`, `socketRevocation.workers.test.ts` |
| `/whiteboard`, `/whiteboard/<room>` | GET, HEAD | Access; static app shell | live probe 302 to Access login without a credential |

## Guest host (`join-playground.sen-tutor.co.uk`) — no Access, room-bound guest sessions

| Route | Method | Authorization | Evidence |
| --- | --- | --- | --- |
| `/auth/guest` | POST | Exact guest Origin; 5/min per IP in the Worker and 20/10 s at the edge; the room registry is checked before the room object is touched; PIN verified by the room with lockout; identical 403 for every failure | `worker.guest.workers.test.ts` |
| `/whiteboard/<room>` | GET, HEAD | Static app shell | `worker.guest.workers.test.ts` |
| `/api/whiteboard/room/<room>` and room subroutes, `/signaling`, `/api/av/*` | as teacher host | Guest session bound to that room, then the RoomDO matrix with `guest=1` (owner surfaces always refused) | `guestSignaling.workers.test.ts`, `roomDO.workers.test.ts` |
| settings, stats, library, `/auth/session/*`, `/api/company/*`, `/api/operator/*`, billing, referrals | any | 404 at the host allowlist | `requestGuard.test.ts`; live probes 404 |

## RoomDO matrix

The authoritative table is the comment above `RoomDO.authorize`
(`src/do/RoomDO.ts`). Summary, by role held in `room_members` for the stamped
account:

| Surface | Owner | Editor | Viewer | Pending / banned / outsider | Guest (`guest=1`) |
| --- | --- | --- | --- | --- | --- |
| Read room, presence | yes | yes | yes | 403 | once granted |
| Write scene | yes | yes | no | 403 | once granted editor |
| Settings, stats, library, clear board, delete room | yes | 403 | 403 | 403 | 403 |
| Waiting queue, requests (approve/reject/ban) | yes | 403 | 403 | 403 (may withdraw own request) | 403 |
| Kick / suspend | yes (never the owner) | 403 | 403 | 403 | 403 |
| A/V token | yes, all sources | camera + microphone | subscribe only | 403 | as granted role |
| A/V mute, allow/revoke screen share | yes | 403 | 403 | 403 | 403 |
| End own screen share | no-op | yes | 403 | 403 | as editor |
| Raise / lower hand | yes | yes | yes | 403 | once granted |

## IdentityDO routes

IdentityDO is reachable only through Durable Object bindings held by the Worker
and RoomDO; `/api/internal/identity/*` answers 404 through the Worker
(`identityDO.workers.test.ts`). Routes that act for a person validate that
person's session themselves; the rest take only server-derived input:

- `/accounts/plan` requires proof: a session (its own account) or an owned room
  (`accountId` + `roomId` in `account_rooms`) — never a bare id.
- `/rooms/registered` answers only yes or no.
- `/billing/events/apply` requires `signatureVerified: true` and a SHA-256
  payload hash, and re-checks `livemode`.
- `/accounts/{disable,enable,revoke-all}` take `{accountId, actor, reason}`; the
  public path to them is the operator route above, which sets the actor.

## Real-time frames on `/signaling`

| Frame | Who may send | Handling | Evidence |
| --- | --- | --- | --- |
| Yjs sync (0) | granted writer (owner, editor) | Applied, then `sanitizeSceneDoc` strips embed types, unsafe links, malformed entries and over-cap scenes; relayed to peers; a viewer's handshake is answered without applying writes | `roomDOSync.workers.test.ts`, `signalingAdversarial.workers.test.ts` |
| Awareness (1) — cursors, laser | any granted | Relayed; the only frame shed when a socket passes its 120/s budget (sync is never shed); never persisted | `signalingBudget.test.ts`, `cursorAwareness.test.ts` |
| Follow / guide | owner only | Other senders ignored; a UX hint that moves viewports, never authorization | `followGuide.workers.test.ts` |
| Call start / end | owner only | Other senders ignored; call state stored durably | `roomCall.workers.test.ts` |
| Presence (100) and unknown types | nobody | Never relayed | `signalingAdversarial.workers.test.ts` |
| Any frame from a revoked, banned or ungranted account | — | Socket closed 4401; an ungranted account is also removed from LiveKit; the revocation alarm re-checks epochs within 30 s | `socketRevocation.workers.test.ts`, `roomDOGuards.workers.test.ts` |

## Findings from this review

Each was fixed on branch `security/close-open-items` with a failing test first:

| Finding | Fix |
| --- | --- |
| `/accounts/plan` served any `accountId` it was handed (SEC-A20) | `78998cc` — proof by session or owned room |
| Webhook buffered unbounded chunked bodies and had no rate limit (SEC-A21) | `b24ff41` |
| A socket found ungranted was closed but its account stayed in the LiveKit call | `076fae3` |
| Every participant could screen share with no host control | `3204e6f`, `0d0fdc5` |
| A guest PIN attempt at a random room id created an empty Durable Object | `28d1904` |
| Stripe webhooks could not reach production: Access covers the whole teacher hostname | `49ee509` — served on the marketing host |
| No operator path to disable an account without a deploy | `0a68a8b` |
| The daily billing reconcile was never scheduled in production | `70485df` |
