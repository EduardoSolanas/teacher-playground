# Security remediation plan

Last reviewed: 2026-08-17 (checkbox pass re-verified 2026-08-17)

This is a task backlog for the current working tree, not a statement that the
application is secure. Findings were derived from source review and local
tests; no production penetration test was performed.

Priority meanings:

- **P0:** security boundary is currently ineffective; fix before public use.
- **P1:** exploitable data-loss, availability, privacy, or supply-chain risk.
- **P2:** defense in depth and operational hardening.

## Status of the previous review

The previous review was correct that room APIs, moderation, signaling, and
resource creation are unauthenticated. It missed the most important
architectural point: `y-webrtc` connects participants directly, so HTTP and
signaling checks alone cannot enforce a read-only viewer or revoke an already
connected peer.

Original dependency/deployment baseline (now remediated locally):

- The original `npm audit --omit=dev` reported **0 production vulnerabilities**,
  while the full audit reported **4 development-chain vulnerabilities: 2
  critical and 2 high**, involving `concurrently`/`shell-quote`, Vite, and
  `brace-expansion`. Both current audit commands now report zero vulnerabilities.
- The original Docker runtime copied the complete `node_modules`, including
  development-only packages. The unsupported Docker/Node production path has
  since been removed from the current tree.

## Authentication and authorization architecture decision

Use a hybrid boundary: Cloudflare Access authenticates social identities and
provides coarse application admission; this application retains full control of
endpoint, room, and real-time authorization.

- Configure Google and Facebook as Cloudflare Access identity providers.
  Cloudflare handles the external provider callback and authentication session.
- [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
  may decide whether a verified user can reach the production hostname or
  coarse paths such as `/admin/*`, using login method, email/domain, IdP group,
  country, MFA, or device posture. They are not the room permission system and
  must not be used to create one Access policy per room.
- The Worker must require Cloudflare's verified Access context on every
  protected request and check the expected application audience and human-user
  identity. If that context is unavailable in a retained runtime, validate
  `Cf-Access-Jwt-Assertion`: signature against the account JWKS, exact issuer,
  audience, expiry, token type, and required identity claims. Do not trust the
  presence of an Access header or cookie alone; follow Cloudflare's
  [Worker JWT validation guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
- Resolve the verified Access subject to a server-owned local account ID. Do
  not authorize by email, name, avatar, provider name, or any client-supplied
  field. If multiple identities can belong to one account, linking/unlinking
  requires a current authenticated session and fresh proof; matching emails
  must never auto-link accounts.
- Local state owns account disablement, room grants, creator/viewer/editor
  roles, waiting approval, moderation, revocation, retention, and audit logs.
  A valid Access session proves identity only; it grants no room access by
  itself. Local revocation must deny the next request even while the Access JWT
  remains otherwise valid.
- The Worker authorizes the local account before forwarding HTTP requests or
  issuing short-lived real-time tickets. Strip caller-supplied identity headers
  and pass only a server-derived principal through the private Durable Object
  binding. The Durable Object applies the matrix below to every operation.
- Protect cookie-authenticated mutations against CSRF with exact `Origin`
  validation and, where same-origin cannot be proven, a CSRF token. Reject
  cross-site requests before reading request bodies.
- Disable or protect every alternate origin and route, including `workers.dev`,
  preview deployments, the legacy Node server, and direct backend hostnames, so
  an attacker cannot bypass Access. Keep in-Worker JWT validation even when the
  edge policy is correctly configured.
- Request only basic identity scopes. The application should never receive or
  retain Google or Facebook access/refresh tokens when Access is the
  authentication broker. Never place Access JWTs, real-time tickets, or local
  authorization material in `localStorage`, URLs, room codes, or logs.

Cloudflare therefore performs authentication and useful coarse authorization;
the Worker and Durable Object perform all security-sensitive application
authorization. Use an opaque local application session bound to the verified
Access principal so logout, per-device revocation, account authorization epochs,
and live-connection expiry remain under application control.

## Required authorization contract

Use this matrix as the specification for HTTP and the real-time transport.
Authorization must happen before parsing a request body or returning room data.

| Operation | Unauthenticated | Authenticated pending | Viewer | Peer/editor | Creator |
| --- | --- | --- | --- | --- | --- |
| Request access / check own request | no | yes, rate-limited | yes | yes | yes |
| Read room canvas | no | no | yes | yes | yes |
| Publish canvas update | no | no | no | yes | yes |
| Heartbeat/leave as self | no | no | yes | yes | yes |
| Read active users | no | no | minimal list | minimal list | full list |
| Read waiting queue or request PII | no | no | no | no | yes |
| Change room settings | no | no | no | no | yes |
| Approve, reject, suspend, kick, revoke | no | no | no | no | yes |
| Delete room | no | no | no | no | yes |
| Open real-time read channel | no | no | yes | yes | yes |
| Open real-time write channel | no | no | no | yes | yes |

All decisions must use one normalized room ID, one server-derived principal,
one grant state, and one expiry/revocation policy. A room code or client-supplied
`peerId` is never authorization.

## P0 — establish a real security boundary

### SEC-001 — replace or constrain the peer-to-peer sync architecture

**Evidence:** collaboration starts before admission in
`src/hooks/useCollaboration.ts:61-71`; `y-webrtc` starts immediately in
`src/lib/whiteboard/collaboration.ts:22-24` and
`src/lib/whiteboard/ywebrtcProvider.ts:57-75`; the waiting screen is rendered
only afterward in `src/app/whiteboard/[roomId]/RoomClient.tsx:106-117`.
Established WebRTC peers exchange Yjs updates directly, outside the Durable
Object.

- [ ] Choose and document one enforceable model. Recommended: move Yjs sync to
  authenticated, server-authoritative Durable Object WebSockets so the server
  can authorize each read/write and disconnect revoked sessions.
- [ ] Do not create any sync provider until the access state is approved.
- [ ] Bind each live connection to a grant, role, session ID, and expiry.
- [ ] On kick, revoke, or expiry, close the live channel and reject reconnects.
- [ ] If direct P2P is retained, remove `viewer` and security claims about kick
  or waiting-room enforcement; treat every admitted peer as a trusted editor.

**Acceptance tests:** an adversarial pending client receives no existing board
bytes; a viewer update is rejected; a peer update succeeds; a kicked peer's
already-open connection stops receiving/sending updates and cannot reconnect.
Tests must use a raw/adversarial client, not only assert which UI is visible.

### SEC-002 — unify admission and enforce the HTTP authorization matrix

**Evidence:** existing-room writes and deletes are unconditional in
`src/lib/whiteboard/handlers/room.ts:65-70,164-172`; moderation and arbitrary
peer removal are unconditional in
`src/lib/whiteboard/handlers/presence.ts:45-91,219-238` and
`src/lib/whiteboard/handlers/waiting.ts:39-126`. Grant approval and
`waiting_peers` approval are separate state machines, and ordinary client
requests in `src/hooks/useCollaboration.ts` send no bearer credential.

- [ ] Replace the parallel waiting/grant flows with one admission state machine.
  Draft evidence (unverified): `room_members.role` is the only grant state
  (`owner`/`editor`/`viewer`/`pending`/`banned`); `/access`, `/requests`, and
  `/waiting` read and write it; bearer tokens do not authorize. See
  `src/lib/whiteboard/membership.ts` and `src/do/roomDO.workers.test.ts`.
- [ ] Require a cryptographically verified Access principal and enabled local
  account to create a room. Bind the creator grant to that local account; do not
  infer ownership from provider, email, room code, or peer ID.
- [ ] Apply the matrix above to every route before reading JSON or querying
  sensitive state.
- [ ] Enforce same-origin/CSRF checks on every cookie-authenticated mutation.
- [ ] Split scene writes from creator-only settings changes.
- [ ] Return consistent `401` for missing/invalid identity and `403` for a valid
  principal with the wrong role.

**Acceptance tests:** table-driven Worker tests cover missing, malformed,
expired, revoked, wrong-room, and wrong-role credentials for every method. A
rejected request leaves every room table unchanged. E2E covers create, request,
approve, join, refresh, expiry, revoke, and denial.

### SEC-003 — authenticate and bound WebSocket admission

**Evidence (updated 2026-08-18):** `/signaling` requires Access + local
session, exact Origin, Worker-stamped `accountId`, and a granted room role
(`owner`/`editor`/`viewer`) before `acceptWebSocket`; pending, banned, and
non-members get 403. Independent verifier APPROVE; skipping `isGrantedRole`
gave outsiders 101. Residual: no frame-size/rate/socket-cap; string `publish`
still fans out to every room socket; Yjs after grant is still y-webrtc P2P.

- [ ] Prefer a same-origin, hostname-protected upgrade authenticated by Access
  and the local application session. Add a short-lived, single-use,
  room/role/session-bound ticket only if a documented cross-origin transport
  requires one; never put long-lived credentials in URLs.
- [ ] Validate the exact allowed production `Origin` and reject unknown origins.
- [ ] Require an existing room and bind the connection attachment to its room.
- [ ] Enforce protocol schemas, expected topic, frame size, sockets per room and
  principal, message rate, and bounded fan-out.
  - Verified live in code (review round 2, `RoomDO.webSocketMessage`): no
    frame-size cap, no message-rate limit, no per-principal socket cap, and a
    `publish` is broadcast to every room socket — an admitted peer can send
    arbitrarily large frames at any rate with room-sized amplification. This
    is a standing weakness on main today, not merely planned work.
- [ ] Redact credentials/tickets from logs and metrics.
- [ ] Revalidate on hibernation wake: a WebSocket attachment written at accept
  time is a snapshot, not a session. On wake (message or alarm after
  hibernation), re-check the attachment's grant version, account epoch, and
  expiry against current state before acting on any frame, so a revocation that
  happened while the socket slept is enforced at the first byte, not at the
  next reconnect.

**Acceptance tests:** missing, revoked, expired, wrong-room, and foreign-origin
upgrade credentials fail; if tickets are retained, replay also fails; topic
mismatch is dropped; oversized frames close with `1009`; policy violations close
with `1008`; rate excess isolates only the attacker.

### SEC-004 — bind identity and moderation to the authenticated session

**Evidence:** `src/lib/whiteboard/peerId.ts:1-12` creates a `Math.random` ID in
mutable local storage; presence accepts client-supplied IDs; the UI infers host
from ID equality and even the first user in
`src/app/whiteboard/[roomId]/RoomClient.tsx:103-105`.

- [ ] Issue peer/session identity server-side from the approved grant.
- [ ] Configure and staging-test Google and Facebook in Cloudflare Access.
- [ ] Require the verified Access context inside the Worker and resolve its
  issuer/subject pair to an enabled local account before any protected route
  reaches a Durable Object.
- [ ] Use one Access issuer/subject pair as one local account, expose no social
  account-linking UI, and document a reverified recovery process if an Access
  subject changes. Never merge distinct local accounts merely by matching email.
- [ ] Add local disable, logout, revoke-all, and provider-account removal
  behavior. Revocation must take effect on HTTP and already-open real-time
  connections even if the Cloudflare Access session remains valid.
- [ ] Strip inbound identity headers and close every unprotected alternate
  origin, route, preview, and legacy-server bypass.
- [x] Ignore client-supplied identity for authorization.
  - Evidence: `forward()` in `src/worker.ts` overwrites `accountId`/`accountEpoch`
    with `searchParams.set`, so a client-supplied value cannot survive into the
    Durable Object, and `RoomDO.authorize` decides on the server-derived account
    rather than the request's `peerId`.
- [x] Allow heartbeat and leave only for the caller's own session.
  - Evidence: `RoomDO.peerAccountId` refuses a presence `POST` that claims a
    `peerId` another account owns and a presence `DELETE` for a peer another
    account owns; moderation `POST`s are excluded from peer binding so a kick or
    suspend cannot transfer the target peer to the moderator. Verified by real
    workerd tests, and all three guards were mutation-tested (removing each one
    fails the suite). **Granularity note:** enforcement is per *account*, not per
    session — two sessions of the same account can still act on each other's
    peers. Per-session binding remains open.
- [x] Moderate and ban a grant/session, not a replaceable `peerId`.
  - Evidence: independent verifier APPROVE. Kick/reject ban the
    `account_id` and clear that account's presence/waiting rows; a new
    `peerId` stays `403`. Optional body `peerId` must match the bound
    account (`409` mismatch). Forging creator `peerId`/`hostPeerId` grants
    no owner power. Re-verified: `npm test` 222/222, `npm run test:workers`
    88/88, typecheck clean. Residual: per-account not per-session; e2e for
    this slice did not run (locked `out/` on Windows).
- [ ] Require fresh proof for destructive owner actions: room deletion and
  revoke-all must not ride a long-idle session cookie alone. A recent-activity
  threshold or an explicit re-confirmation bound to the session (not a UI-only
  dialog) is enough; a stolen cookie should not be able to erase a class's
  boards silently.
- [x] Make the first-user host fallback an explicit per-room setting that
  defaults to off, and remove client-side authorization.
  - Decision: the fallback is retained as an opt-in room setting rather than
    removed outright, because some rooms need a host when none is recorded. The
    escalation risk is closed by defaulting it off; turning it on is a deliberate
    creator choice.
  - Evidence: `rooms.allow_first_user_host` defaults to `0`, existing rooms
    migrate to `0`, and `readActiveUsers` grants the earliest peer host status
    only when the setting is on — a recorded host always wins. Exposed through
    the room API as `allowFirstUserHost`; omitting it on a write leaves it
    unchanged. `RoomClient` no longer infers host from `users[0]` and uses the
    server's answer for display only. 13 real-SQLite tests, and every branch
    (schema default, handler default, setting-ignored, fallback-overrides-host)
    was mutation-tested.

**Acceptance tests:** each configured provider completes a real staging login
and resolves to the correct local account; missing, forged, expired,
wrong-issuer, and wrong-audience Access identities fail closed; an unprotected
origin cannot reach the application; the application does not merge distinct
subjects by email; cross-site mutations have no side effects; local
disable/logout/revoke-all invalidates HTTP and live-channel access within the
documented bound. Token A cannot heartbeat, leave, or act as B; forging the
creator's public peer ID grants no power; choosing a new peer ID does not bypass
kick/rejection; only a creator can moderate.

## P1 — prevent data exposure and resource abuse

### SEC-005 — validate identifiers, bodies, scenes, and quotas at the edge

**Evidence:** arbitrary IDs reach `idFromName` in `src/worker.ts:13-28`; first
touch initializes SQLite in `src/do/RoomDO.ts:34-37`; `elements`, `viewport`,
and `maxUsers` are `unknown` in `src/lib/whiteboard/requestSchemas.ts:16-43`.
Names, emails, peer IDs, queues, requests, sockets, and room creation have no
effective server-side quota. The React creation throttle is bypassable.

- [x] Define one server-side room-ID grammar/length and reject before DO lookup.
  - Evidence: `isValidRoomId` (`^[A-Za-z0-9_-]{1,64}$`) rejects with `400` in
    `src/worker.ts` before `idFromName`, on both `/api/whiteboard/room/*` and the
    `/signaling` upgrade. Mutation-tested.
- [ ] Prefer signed or otherwise verifiable IDs so random invalid IDs do not
  allocate Durable Objects.
- [ ] Require room existence for every subroute before persisting anything.
- [x] Enforce content type and byte limits before `request.json()`; return `413`.
  - Evidence: mutations over the 1 MiB cap return `413` from the declared
    `Content-Length`, and a mutation declaring a body without a JSON content type
    returns `415`, both before the request reaches the Durable Object.
    Mutation-tested.
- [ ] Bound element count, serialized scene bytes, nesting, field lengths,
  access/waiting counts, sockets, and writes per interval.
- [ ] Validate email, color, viewport, role, maximum users, and permitted scene
  element types/URL schemes. Disable `iframe`, `embeddable`, image, or external
  link behavior unless explicitly required and safely allowlisted.
- [ ] Add per-principal/IP creation and request limits with `429` responses.
- [ ] Configure edge-level protection in front of the Worker: Cloudflare custom
  WAF rules and rate limiting on the production zone, so floods are dropped
  before they bill Worker invocations. Free-plan budget: 5 custom WAF rules and
  exactly 1 rate-limiting rule (plus basic Bot Fight Mode; managed rulesets are
  paid) — spend the single rate-limit rule on the most abusable route
  (room creation or session issue) and treat app-level quotas above as the
  primary mechanism, not the backup.

**Acceptance tests:** malformed/oversized IDs never instantiate a DO;
nonexistent-room subroutes persist nothing; just-over-limit bodies return
`413`; quota overflow returns `429`; hostile scenes cannot trigger external
loads or crash clients.

### SEC-006 — use cryptographic room and capability creation

**Evidence (updated):** room identifiers are still 8 characters of
`Math.random` in `src/app/whiteboard/page.tsx` (~41 bits, guessable), so this
section stays open. The `peerId` half has narrowed: it is still `Math.random`,
but it is now a display/cursor label only — authorization comes from
`room_members.account_id`, so forging a peer id no longer grants anything
(SEC-004). Room creation now requires an authenticated account and the creator
grant is bound to that account, closing the anonymous pre-claim path; creation
is still not one transaction.

- [x] Generate at least 128 bits of randomness with a cryptographic RNG.
  - Evidence: independent verifier APPROVE. `randomHexId()` uses 16 bytes
    from `crypto.getRandomValues` (32-char lowercase hex). Create page
    calls `generateRoomId()`; minted peer labels are `user-` plus that
    hex. Focused tests 13/13; `Math.random` spy unused. Residual: join
    input still `{1,20}` so paste-join cannot take a 32-char create id;
    `collaboration.ts` still has a `Math.random` fallback if peerId is
    omitted.
- [ ] Keep display/share codes separate from authorization capabilities.
- [ ] Make room, host session, and creator grant creation one transaction.
- [ ] Reject duplicate/preclaimed creation without changing ownership.
- [ ] Define secure client storage and rotation; never store long-lived bearer
  capabilities in `localStorage`.

**Acceptance tests:** monkey-patching `Math.random` cannot affect security IDs;
knowing only a room ID yields no data; concurrent create attempts produce one
owner; injected transaction failure leaves no partial room or grant.

### SEC-007 — make deletion, expiry, and retention complete

**Evidence:** room deletion removes only the `rooms` row in
`src/lib/whiteboard/handlers/room.ts:164-172`; related tables in
`src/lib/whiteboard/roomSchema.ts:30-85` have no cascades. Access, requests,
presence, waiting, kicked rows, and live sockets survive. Expired grant cleanup
exists but is not scheduled.

- [x] Make creator-only deletion atomic across every room-scoped table.
  - Evidence: independent verifier APPROVE. `deleteRoomScopedData` deletes
    all seven `applySchema` room tables in one SQLite transaction.
    `handleRoomDelete` is the only caller. Re-verified: `room.test.ts` 12,
    `roomDelete.workers.test.ts` 1, `npm test` 234, typecheck clean.
- [ ] Close all room sockets and call the appropriate Durable Object storage
  deletion mechanism after responding safely.
  - Evidence: sockets close with 4404 after a successful DELETE
    (`deleteSockets`). This line stays open until `storage.deleteAll` (or
    equivalent) lands.
- [ ] Tombstone IDs or prove old grants cannot authorize a recreated room.
- [ ] Set TTLs for rooms, requests, kicks, sessions, grants, and PII; purge with
  Durable Object alarms and record the retention policy.
- [ ] Add backup/restore for Durable Object SQLite state (rooms and identity)
  with a tested restore path and a recovery-point objective, so a bad deploy or
  storage incident cannot silently destroy classroom data. Verified: SQLite
  Durable Objects and their 30-day point-in-time-recovery API are included on
  the Workers Free plan (5 GB total account storage), so the restore path costs
  nothing extra — what this task adds is exercising it and recording the
  procedure.

**Acceptance tests:** seed every table plus live sockets, delete, and assert all
data is gone and sockets close; recreation rejects every old token; expiry
physically purges records rather than only ignoring them.

### SEC-008 — treat tracked SQLite state as a potential data incident

**Original evidence (locally remediated):** `git ls-files .data` returned
`.data/whiteboard.db`, `.data/whiteboard.db-shm`, and
`.data/whiteboard.db-wal`; the schema can contain board content, names, emails,
and token hashes. The current index no longer tracks these files and `.data/`
is ignored. Public-history and external incident actions remain incomplete.

- [ ] Stop tracking all database/WAL/SHM files and ignore `.data/`.
- [ ] Replace them with synthetic fixtures or schema migrations only.
- [ ] Determine whether the repository or artifacts were shared; if so, follow
  incident handling, rotate/revoke affected credentials, and purge history
  where appropriate.
- [ ] Ignore `.wrangler/`, non-example environment files, and ad-hoc test output;
  - Partly done: `.wrangler/`, `.data/`, `.idea/`, `*.iml`, and agent scratch
    (`.omo/`) are ignored. Still untracked and unignored: `.cursor/` and
    editor/agent config (`AGENTS.md`) — decide tracked-or-ignored for each.
    Ad-hoc test output (`test-results.txt`, `e2e-results.txt`,
    `test-output.txt`) and blocking secret/PII scanning in CI remain open.
  add blocking secret/PII scanning.

**Acceptance tests:** `git ls-files .data` is empty;
`git check-ignore .data/whiteboard.db` succeeds; a clean test run uses disposable
synthetic data; repository/history scans report no secrets or PII.

### SEC-009 — harden or remove the legacy Node signaling deployment

**Original evidence (legacy production path removed):** `server.js:69-70`
performed unguarded `JSON.parse`; both Node signaling implementations had
unbounded subscriptions and messages; `signaling-server.mjs:128-135` accepts
upgrades on every path and binds to `0.0.0.0`; and `Dockerfile:67` started
`server.js`. The current supported deployment no longer references those
Node/Docker artifacts; the retained signaling source is unsupported.

- [ ] Prefer removing the legacy deployment if Cloudflare is authoritative.
- [ ] Otherwise add parse guards, strict schemas/path/origin checks, `maxPayload`,
  connection/topic/rate caps, timeouts, and safe error handling to both servers.
- [ ] Declare `ws` as a direct audited production dependency.
- [ ] Destroy sockets for unsupported upgrade paths.

**Acceptance tests:** malformed/noniterable/oversized messages do not terminate
the process; oversized frames close `1009`; wrong path/origin is rejected; live
health and authorized collaboration continue after hostile input.

### SEC-010 — close supply-chain and deployment gaps

**Original evidence (partly remediated):** full `npm audit` was not clean;
`.github/workflows/ci.yml` made audit non-blocking; and `Dockerfile:18,48`
shipped dev dependencies. The current audits are clean and the Docker path is
removed. Remaining open: production-only install/image scan (no image remains),
GitHub environment protection, Cloudflare token scoping, and a required
deploy gate that waits on CI. CI Node and Action pins below are verified
locally. GitHub states a
[full commit SHA is the immutable form](https://docs.github.com/en/actions/reference/security/secure-use).

- [x] Remediate the complete dependency graph and make high/critical audit
  failures blocking; exceptions require an owner and expiry.
  - Evidence: independent verifier APPROVE for this slice; `npm audit
    --audit-level=high` in `.github/workflows/ci.yml` has no
    `continue-on-error`; dependency-review uses `fail-on-severity: high`;
    8 deployment policy tests pass; no exception is required.
- [ ] Build a production-only dependency stage (`npm ci --omit=dev`) and scan
  the final image, not only the lockfile.
- [ ] Move CI/build/runtime to a maintained LTS Node line and pin exact image
  digests/versions.
  - Evidence: independent verifier APPROVE for the CI Node pin only.
    Workflows use `node-version: 22.23.2` on `ubuntu-24.04`. Runner images
    are not digest-pinned; there is no production container image.
- [x] Pin every GitHub Action to a verified full commit SHA.
  - Evidence: independent verifier APPROVE; every `uses:` in `ci.yml` and
    `deploy-cloudflare.yml` is a 40-character SHA whose GitHub tag object
    matches the version comment (`actions/checkout` v4.4.0,
    `actions/setup-node` v4.4.0, `actions/upload-artifact` v4.6.2,
    `actions/dependency-review-action` v4.9.0, `cloudflare/wrangler-action`
    v3.15.0). Policy tests reject mutable `@vN` tags.
- [ ] Scope `packages: write` to the publish job; protect production environments
  and minimize Cloudflare token permissions.
- [ ] Make both deployments depend on one required lint, typecheck, unit,
  Worker, audit, and relevant E2E/smoke gate.
- [ ] Contain dependency install scripts: run CI installs with
  `--ignore-scripts` where the build allows it, and record an explicit
  allowlist for packages that genuinely need lifecycle scripts (for example
  `better-sqlite3`, dev-only), so a compromised transitive package cannot run
  arbitrary code on install.

**Acceptance tests:** both audit commands exit zero at `--audit-level=high`;
runtime image contains no Vite, Vitest, ESLint, Playwright, Wrangler, or
`concurrently`; image scan has no high/critical finding; CI rejects mutable
Actions and prevents deploy when any required check fails.

## P2 — privacy and defense in depth

### SEC-011 — reduce browser and WebRTC privacy exposure

**Evidence:** Direct WebRTC can still disclose participant network metadata to
peers. Offline board cache and kick/waiting-leave clearing are verified locally
below; server revoke still has no client persistence hook.

- [x] Default shared/classroom rooms to no offline board cache, or require
  explicit informed opt-in.
  - Evidence: independent verifier APPROVE. `saveBoardState` does not
    `setItem` unless `setOfflineBoardCacheEnabled(roomId, true)` wrote the
    opt-in flag; nothing in the UI calls that setter. Leftover keys without
    opt-in are purged on load. 9 persistence tests passed.
- [ ] Clear room, peer, and session material on leave, kick, revoke, and expiry.
  - Evidence: independent verifier APPROVE for kick and waiting-room leave
    (`clearSession` → `clearRoomSessionMaterial`) and 24h expiry of
    room-scoped keys. Still open: in-room leave UI, reject/suspend, and
    server-revoke client hook. Tab close does not clear peer id / username.
- [ ] Document WebRTC IP/ICE privacy. If peer IP privacy is required, use an
  authoritative relay or managed TURN with relay-only ICE.

**Acceptance tests:** leave/kick/revoke removes all room keys; a later local user
cannot recover board data; relay-only tests show host candidates are not shared.

### SEC-012 — add response, cache, framing, and indexing protections

**Evidence:** `src/worker.ts:51-59` returns asset responses directly and handlers
have no shared hardening. Sensitive JSON has no explicit `Cache-Control`.

- [x] Add CSP (report-only first, then enforced), `frame-ancestors 'none'`,
  `object-src 'none'`, `base-uri`, `X-Content-Type-Options: nosniff`, strict
  referrer policy, and a minimal Permissions Policy.
  - Evidence: `withSecurityHeaders` applies `nosniff`, `Referrer-Policy:
    no-referrer`, `X-Frame-Options: DENY`, and a Permissions Policy denying
    camera, microphone, geolocation, payment, USB, MIDI, and serial to every
    response; HTML additionally carries a report-only CSP with `frame-ancestors
    'none'`, `object-src 'none'`, and `base-uri 'self'`. Mutation-tested.
    **Still report-only:** promoting the CSP to enforced is deliberately not
    done, and remains open below.
- [ ] Restrict CSP `connect-src` to the actual HTTPS/WSS/TURN allowlist.
  - Not done: the policy currently allows `'self' wss:`, which is a scheme, not
    an allowlist. Needs the production hostname, so it is blocked on the same
    external input as the Phase 1 hostname tasks.
- [ ] Promote the CSP from report-only to enforced once violations are observed
  to be clean against a real Excalidraw session.
- [x] Set `Cache-Control: no-store` and appropriate `Vary` on room, presence,
  grant, and request responses.
  - Evidence: every non-HTML response gets `Cache-Control: no-store` and
    `Vary: Cookie, Origin`, appended to any existing `Vary` rather than replacing
    it. Mutation-tested.
- [x] Add `X-Robots-Tag: noindex` to room pages.
  - Evidence: `withSecurityHeaders` sets `X-Robots-Tag: noindex` on every HTML
    response, which covers the room page rewrite. Mutation-tested.

**Acceptance tests:** headers are asserted on HTML, JavaScript, API 2xx/4xx/5xx,
and room pages; CSP E2E reports no unexpected violations; sensitive responses
are never cacheable.

### SEC-013 — minimize PII and internal error disclosure

**Evidence:** anonymous presence/waiting responses expose names and queues in
`src/lib/whiteboard/handlers/presence.ts:6-16` and
`src/lib/whiteboard/handlers/waiting.ts:5-30`; handlers return raw exception
messages, for example `src/lib/whiteboard/handlers/room.ts:115-119`.

- [x] Return only self status and the minimum approved-user fields by default;
  expose queue/request PII only to the creator.
  - Evidence: presence GET requires a granted role, so anonymous and pending
    callers get `403` and no user list; the waiting queue is attached to the
    payload only for the owner (`callerSeesWaitingQueue`); the requests list
    with emails is owner-only (`handleRequestsGet`); the active-user list
    carries display fields only (peer label, name, color, host flag) — no
    email or account id.
- [x] Return generic 5xx bodies and log structured, redacted server details.
  - Evidence: independent verifier APPROVE. Handler catches use
    `internalErrorResponse`; clients get `{ error: "Internal server error" }`;
    logs are one JSON line with email/JWT/Bearer/`elements` redaction.
    Re-verified `npm test` 234/234, typecheck clean. Residual: JWT regex
    needs `eyJ`; nested board arrays can leak later ids in logs.
- [ ] Add security-event logging for auth failures, grant changes, revocation,
  rate limiting, and abnormal socket closure with retention/alert thresholds.

**Acceptance tests:** anonymous/pending/viewer responses contain no board,
queue, email, token, or unnecessary identity data; induced SQL/storage errors
never reveal internals; logs contain no raw credentials or board content.

### SEC-014 — remove configuration and debug escape hatches

**Evidence:** signaling URL policy and debug globals are verified locally
below. y-webrtc P2P sync itself is unchanged (Phase 3).

- [x] In production allow only same-origin or explicitly allowlisted `wss:`
  signaling endpoints; reject credentials, fragments, insecure schemes, and
  unexpected paths.
  - Evidence: independent verifier APPROVE. Configured
    `NEXT_PUBLIC_YWEBRTC_SIGNALING_URL` entries are sanitized; if all are
    unsafe the list is empty (no fallback). Production requires `wss:` and
    page host or `NEXT_PUBLIC_YWEBRTC_SIGNALING_ALLOWED_HOSTS`. 16
    `ywebrtcProvider` tests passed.
- [x] Expose debug globals only behind an explicit development/E2E build flag.
  - Evidence: independent verifier APPROVE. `__whiteboardStore` /
    `__whiteboardCollab` attach only when `NODE_ENV !== 'production'` or
    `NEXT_PUBLIC_WHITEBOARD_DEBUG=1` or `NEXT_PUBLIC_E2E=1`. Residual:
    a production E2E build still exposes them.
- [x] Keep Cloudflare and any retained Node deployment configuration/security
  behavior identical or remove the unsupported path.
  - Evidence: the Node/Docker path was already removed (Phase 0 / SEC-009);
    Cloudflare Worker plus Durable Objects is the only supported deployment.

**Acceptance tests:** unsafe/misconfigured signaling URLs fail closed; production
builds contain no debug globals; parity tests exercise the same authorization,
headers, limits, and error behavior on every supported deployment.


### SEC-016 — account lifecycle, erasure, and data-subject rights

**Status:** not covered anywhere outside the payments section, yet the
application stores identity PII (names, emails, provider subjects), board
content, and audit trails for teachers and students — a population that in most
jurisdictions carries data-subject rights (GDPR-style erasure/export) and
heightened duties for minors (FERPA/COPPA-like rules depending on market).
Retention TTLs (SEC-007) bound how long data lives; this section is about what
happens when a *person* asks for their data or its removal, or stops being a
user.

- [ ] Record the lawful-basis and data-inventory decision: what personal data is
  held, where (identity store, room tables, audit log, logs), for whom
  (teacher vs student), and who the controller is. This decides every item
  below and belongs to the product owner.
- [ ] Implement account deletion: a verified request removes or anonymizes the
  account row, its provider subjects, sessions, grants, presence/waiting rows,
  and display names embedded in other accounts' rooms, within a documented
  deadline.
- [ ] Resolve the audit-trail tension explicitly: security audit records may be
  retained on legitimate-interest grounds, but then must be pseudonymized on
  erasure (keep the event, drop the direct identifiers) — decide and document,
  do not leave it implicit.
- [ ] Implement data export for an account's own data in a portable format.
- [ ] Decide and document the minors policy: what identity data students may
  enter at all (a display name may be enough — email is already optional),
  whether student emails should be refused rather than stored, and who consents
  on a student's behalf.
- [ ] Propagate erasure to operational stores: logs, error reports, analytics,
  and backups (document the backup-erasure window rather than pretending
  backups can be rewritten instantly).

**Acceptance tests:** after erasure, no table, log fixture, or export contains
the account's identifiers; an export contains the account's own data and nobody
else's; a deleted account's sessions and live sockets are closed; audit rows
survive erasure only in pseudonymized form.

### SEC-017 — impersonation and classroom abuse resistance

**Status:** not covered. Display names are client-chosen free text
(`userName`), rendered to every participant in the presence panel, waiting
queue, and cursors. Authorization no longer trusts them (SEC-004), but humans
do: in a classroom, a student naming themselves after the teacher — or after
another student — is a working social-engineering attack on the *owner's
moderation decisions* (approve/kick target selection), and abusive names or
board content are a duty-of-care problem, not just a UX one.

- [ ] Visually distinguish the room owner in every participant list and cursor
  by server-verified role, never by display name, so a name collision cannot
  imitate the teacher's authority.
- [ ] Disambiguate duplicate display names in owner-facing moderation UI (queue
  and kick targets) with a stable server-side discriminator, so the owner
  always acts on the account they intend.
- [ ] Bound and normalize display names and room names: strip control and
  zero-width characters, collapse confusable whitespace, and enforce the
  existing length caps at the server (SEC-005 covers length; this adds
  normalization so "Teacher" and "Teacher\u200b" are not two identities).
- [ ] Give the owner a low-friction abuse response: kick/ban already exists;
  add clearing another participant's strokes and, if boards can be shared
  beyond the live room, a report path with an accountable recipient.
- [ ] Rate-limit join/name-change churn per account so cycling names cannot
  flood the queue or the presence panel (shares the SEC-005 quota mechanism).

**Acceptance tests:** a participant with the owner's exact display name is
never rendered with owner affordances; moderation actions resolve to the
intended `account_id` under duplicate names; control/zero-width characters are
gone from stored names; name-churn beyond the limit returns `429` and leaves
the queue stable.

### SEC-015 — keep paid membership and payments outside the trust boundary

**Status:** not started. No billing, plan, or payment code exists in the tree
today; `src/lib/whiteboard/membership.ts` models *room* roles (owner, editor,
viewer, pending, banned), which is a different concept from a paid plan. This
section is the security contract for the feature when it is built, so the design
constraints are agreed before any processor is chosen.

**Why it is last:** payments add a new external trust boundary (the processor),
a new class of privileged state (entitlements), and a new category of PII
(billing identity). None of that is safe to add while room authorization,
revocation, and the real-time boundary are still open, because an entitlement is
only as trustworthy as the account it hangs off.

**Threats specific to this surface:** paying nothing and being entitled anyway
(client-declared plan, tampered price, forged or replayed webhook, checkout
redirect treated as proof of payment); entitlement outliving payment (cancel,
refund, chargeback, or failed renewal that never reaches live sessions); one
account's billing data reachable by another; and a classroom application
accidentally collecting payment or billing identity from minors.

- [ ] Never let card data touch this application. Use the processor's hosted
  checkout or hosted fields so the deployment stays in the lowest PCI DSS
  self-assessment scope, and record which SAQ level that is.
- [ ] Treat entitlement as server-owned state keyed by local `account_id`, in the
  identity store next to `accounts`. Never accept plan, tier, seat count, price,
  amount, currency, coupon, or trial eligibility from the client; the server
  selects the price identifier.
- [ ] Never grant entitlement from a checkout success redirect, a client callback,
  or a `session_id` in a URL. Grant only from server-side verification: a
  signature-verified webhook or an authoritative read back from the processor.
- [ ] Verify every webhook: exact signature over the raw body, freshness window,
  and per-event-ID deduplication so a replayed or retried delivery cannot apply
  twice. Handle out-of-order delivery by reconciling against processor state
  rather than trusting event order.
- [ ] Make entitlement changes idempotent and audited. Reuse the existing
  `authorization_audit` pattern: actor, reason, before/after, written in the same
  transaction as the change.
- [ ] Propagate downgrade, cancellation, non-payment, refund, and chargeback the
  same way revocation propagates — bump the account authorization epoch so HTTP
  and already-open real-time connections lose the entitlement within the
  documented bound. An expiring plan must not depend on a client asking.
- [ ] Enforce plan limits (rooms, seats, participants, retention) server-side at
  the same boundary as the authorization matrix, not in the UI.
- [ ] Scope billing routes to the owning account only. Reading or changing another
  account's plan, invoices, or payment method must fail closed, and admin
  overrides must be audited.
- [ ] Bill teachers only. Students must never reach a payment flow or have billing
  identity stored, and the design must state how it keeps minors out of that
  path.
- [ ] Store only processor identifiers (customer, subscription, invoice) plus
  what is legally required. No PAN, no full billing address unless tax rules
  demand it. Document the conflict between invoice retention duties and erasure
  requests, and which wins.
- [ ] Rate-limit and bound abuse of free tiers: one trial per account, coupon
  redemption limits, and creation limits that survive account churn.
- [ ] Keep processor secrets (API key, webhook signing secret) in Worker secrets,
  never in code, client bundles, logs, or `wrangler.toml`; document rotation.
- [ ] Add a reconciliation job that compares local entitlement against processor
  state and alerts on drift, so a missed webhook is detected rather than silently
  granting or denying access.

**Acceptance tests:** a forged, replayed, stale, or wrong-signature webhook
changes nothing; a client-declared plan, tampered price, or self-granted
entitlement is ignored; a checkout redirect alone entitles nobody; cancel,
refund, chargeback, and failed renewal each remove access from HTTP and from an
already-open socket within the documented bound; one account cannot read or
modify another's billing state; plan limits are enforced server-side against a
raw client; duplicate webhook delivery applies once; and induced processor
errors or timeouts never leave entitlement and payment in disagreement.

#### Proposed membership structure (Phase 7 input — awaiting owner sign-off)

A concrete default so Phase 7 starts from a reviewable model instead of a blank
page. The product owner can amend any number here; the *shape* (server-owned
catalog, account-keyed entitlement, grace-then-downgrade, students never
billable) is the part SEC-015 depends on.

**Who is billable.** Only teachers — the accounts that create and own rooms.
Students authenticate and join rooms but are never billable, never see payment
UI, and never have billing identity stored (SEC-016 minors policy). A room's
capabilities are decided by its *owner's* plan, so a student's experience
changes with the teacher's tier without the student ever touching billing.

**Tiers (proposed).**

| | Free | Teacher Pro | School (later) |
| --- | --- | --- | --- |
| Active rooms per account | 2 | 20 | pooled per seat |
| Participants per room | 3 (current default) | 10 (current schema cap) | 10 |
| Room retention after last activity | 7 days | 90 days | policy-set |
| Billing | — | monthly/annual, one price each | per teacher seat, central invoice |

School/district is deliberately deferred: seats, rosters, and admin consoles
multiply the authorization surface, and nothing in the individual model blocks
adding it later. Ship Free + Pro first.

**Plan catalog lives in code, not the database.** A static, versioned map of
`plan_id -> limits` (max rooms, max participants, retention days) deployed with
the Worker. The database stores only which plan an account has. This keeps the
price/limit definition out of reach of SQL tampering and makes limit changes an
auditable code review.

**Entitlement data model (identity store, beside `accounts`).**

- `entitlements`: `account_id` (PK, FK accounts), `plan_id`, `status`
  (`free` / `trialing` / `active` / `past_due` / `canceled`),
  `current_period_end`, `processor_customer_id`, `processor_subscription_id`,
  `updated_at`. One row per account; absence of a row means Free. Every write
  bumps the account's authorization epoch (SEC-015 revocation binding) and
  lands an `authorization_audit` row in the same transaction.
- `billing_events`: `event_id` (PK — the processor's event id, which is the
  dedupe key), `type`, `payload_hash`, `processed_at`. Webhook handling
  inserts-or-ignores here first; a duplicate insert means a replay and is
  dropped before any entitlement read.

**Entitlement state machine.**

`free -> trialing -> active` on server-verified checkout;
`active -> past_due` on `invoice.payment_failed` (grace: 7 days, full access,
dunning emails are the processor's job); `past_due -> active` on recovery, or
`past_due -> canceled` when grace lapses; `active|past_due -> canceled` on
subscription deletion; chargeback (`charge.dispute.created`) skips grace and
goes straight to `canceled` plus a review flag. Every transition is
webhook-driven or reconciliation-driven — never client-driven.

**Downgrade semantics — never destroy data on a billing event.** Dropping to
Free with more rooms than the Free quota archives the excess (owner-readable,
not writable, not joinable) rather than deleting it; retention deletion follows
the SEC-007 TTL machinery on the *Free* schedule from the downgrade timestamp,
so a lapsed card never silently erases a class's boards. Over-quota actions
return the distinct "over plan limit" status from Phase 7, which must not leak
whether other rooms exist.

**Processor (proposed): Stripe, hosted surfaces only.** Stripe Checkout for
purchase, Stripe Customer Portal for card changes/cancellation — the
application renders links and never a card field, keeping SAQ-A scope
(SEC-015). Webhooks consumed: `checkout.session.completed`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.payment_failed`, `charge.dispute.created`. Reconciliation reads
`subscriptions.list` per stored customer id on a daily alarm and alerts on
drift. Any processor with equivalent hosted checkout + signed webhooks
satisfies the contract; the choice is the owner's.

**Public sales surface (landing page, pricing, checkout funnel).** Selling
the service needs public pages, and public pages invert two rules the app
relies on, so the inversions must be explicit and scoped:

- The landing/pricing pages must be reachable *without* Cloudflare Access
  while every app and API route stays behind it. That exemption is defined by
  path/hostname allowlist (for example a `/` marketing shell or a separate
  `www` hostname), reviewed like a firewall rule: nothing under `/api/`,
  `/auth/`, `/whiteboard/`, or `/signaling` may ever fall inside it.
- Marketing HTML must be indexable, unlike app HTML which is `noindex` by
  design (SEC-012). The `X-Robots-Tag` exception is scoped to the exact
  marketing routes, never applied by content-type or wildcard.
- The funnel is: landing -> pricing -> sign in (Access) -> server-created
  Stripe Checkout session. The public pages contain no card fields, no
  amount/price parameters on any link (the server selects the price by plan
  id), and no logic that grants anything — the funnel's only power is to
  redirect an authenticated teacher to a checkout session the server built.
- Public pages still carry the security-header baseline and a strict CSP;
  being public is not a reason to relax framing or script policy — a
  lookalike or injected script on the sales page is a credential-phishing
  surface for the app behind it.
- Email capture (waitlist/contact), if added, stores the minimum, states its
  purpose, joins SEC-016 erasure, and is never presented to student-facing
  flows. Prefer cookieless, self-hosted analytics on marketing pages; no
  third-party trackers that would demand a consent banner on a checkout path.
- Terms of service and a privacy policy are prerequisites for charging anyone
  (Stripe requires them, SEC-016 depends on them); they are content tasks but
  they gate the funnel going live.

**Acceptance criteria for the structure itself:** a student session can never
reach a billing route (server-enforced, not hidden UI); an account with no
entitlement row behaves exactly as Free everywhere; archive-on-downgrade is
provably reversible by re-upgrading; the plan catalog is immutable at runtime;
and every entitlement transition appears exactly once in `authorization_audit`
with the processor event id as its reason.


## Implementation phases

Checkbox status is evidence-based: `[x]` means verified complete in the current
tree and `[ ]` means not implemented or not yet verified. Do not start a later
phase until the preceding phase gate passes. If an external-authority-only
blocker prevents a gate, safe locally implementable work in later phases may
continue, but the affected task and gate stay unchecked and no external
behavior is claimed.

The detailed SEC checklists above are broader acceptance sub-items. A checked
Implementation-phase task verifies only the narrower task named there and its
recorded evidence; it does not imply that every checkbox in the referenced SEC
section is complete. Those detailed sub-items remain unchecked until their own
acceptance tests and evidence are satisfied.

### Phase 0 — contain exposure and establish the baseline

- [x] Record the current source, architecture, dependency, and authentication
  findings in this remediation plan.
- [x] Stop tracking `.data/` database, WAL, and SHM files; add the required
  ignore and clean synthetic-test-data rules (SEC-008).
  - Evidence: independent verifier APPROVE; task-owned diffs are clean, local
    files remain ignored and unchanged, 40 unit persistence tests and 12 real
    Durable Object SQLite contract tests pass.
- [ ] Determine whether tracked database content left the repository boundary;
  document the incident decision and rotate/revoke affected credentials or
  grants where required (SEC-008).
  - Evidence: confirmed public exposure and the public-history purge are
    documented in `SECURITY_INCIDENT_2026-08-17.md`. The purge is complete: on
    2026-08-17, `git filter-repo --invert-paths --path .data/` removed the
    artifacts from every public ref, and `main`, `master`,
    `cloudflare-workers-port`, and `codex/whiteboard-realtime-ci` were force-
    pushed. Re-verified independently in this pass: a fresh clone of
    `origin` shows zero commits touching `.data`, zero objects under that
    path (checked across all 627 blobs reachable from all four remote
    branches), and zero blobs beginning with the SQLite file magic; `git
    ls-tree -r --name-only` on each of the four branch tips also contains no
    `.data` path. What genuinely remains outstanding, and is not within this
    repository's control: GitHub has not yet been asked to drop cached commit
    views and API responses, so old objects may still be retrievable there;
    the data owner has not yet determined whether any rows were real
    classroom data, which also determines any notification duty; grants and
    sessions in any deployed environment have not been invalidated; and
    downstream clones, forks, and Actions artifacts have not been identified.
    Every commit hash on every branch changed, so anyone holding a clone from
    before the rewrite can reintroduce the purged objects by pushing from it;
    this is not fully closed until those clones are accounted for. An
    independent incident verifier returned `APPROVE-AS-BLOCKED` for this
    status.
- [x] Record the supported production deployment. Remove the legacy Node path if
  Cloudflare Worker plus Durable Objects is authoritative (SEC-009).
  - Evidence: independent verifier APPROVE; Cloudflare Worker plus Durable
    Objects is the sole supported production path, the Node/Docker/GHCR path is
    removed, the unsupported signaling server is unreachable from scripts, and
    the policy, 117 unit, 27 real-workerd, and typecheck checks pass.
- [x] Remediate the full development dependency audit, not only
  `npm audit --omit=dev`, and record any time-limited exceptions (SEC-010).
  - Evidence: independent verifier APPROVE; the regression test proves the
    former vulnerable lock fails, current installed and locked graphs resolve
    patched versions, both audit commands report zero vulnerabilities, and 118
    unit plus 27 real-workerd tests, lint, and typecheck pass. No exception is
    required.

**Phase gate**

- [ ] A clean checkout contains no real database/PII, both audit commands have no
  unaccepted high/critical finding, and there is one declared production path.
  - Evidence, re-verified in this pass: a fresh clone of `origin` contains no
    `.data` commits, objects, or SQLite-magic blobs on any of the four public
    branches (see above); `npm audit` and `npm audit --omit=dev` both report
    "found 0 vulnerabilities"; `DEPLOY.md` declares Cloudflare Worker plus
    Durable Objects as the sole supported production path and states the
    Node/Docker/GHCR paths are removed, and no `Dockerfile` or `server.js`
    remain in the working tree; `npm run security:scan` passed over 714
    tracked files; and the test baseline is green — `npm test` 229/229, `npm
    run test:workers` 73/73, `npm run test:e2e` 91/91, `npm run typecheck` clean
    on both tsconfigs.
    Every technical condition in this gate now passes. The gate stays open
    because the purge's completion does not resolve what remains outside this
    repository's control: GitHub cached commit views/API responses have not
    been asked to drop the old objects, the data owner has not determined
    whether any exposed rows were real classroom data, grants/sessions in any
    deployed environment have not been invalidated, and downstream clones,
    forks, and Actions artifacts have not been identified — any of which could
    still expose or reintroduce the purged data.

### Phase 1 — establish social identity and locally controlled sessions

- [ ] Confirm Cloudflare Access user limits, pricing, and product fit for the
  expected number of teachers and students before making it mandatory.
  - Evidence: current official limits, seat semantics, pricing, and go/no-go
    thresholds are recorded in `CLOUDFLARE_ACCESS_PRODUCT_FIT.md`. Commercial
    fit remains blocked until the product owner supplies the expected distinct
    teacher/student count and the billing owner accepts the resulting plan.
- [ ] Create one hostname-based self-hosted Access application covering the site,
  APIs, and `/signaling`; configure Google and Facebook and prohibit `Bypass`
  rules.
  - Evidence contract and exact external blockers are recorded in
    `CLOUDFLARE_ACCESS_STAGING.md`. The task remains unchecked because no
    authorized staging account, hostname, Access configuration, or Google and
    Facebook OAuth credentials are available for real verification. An
    independent verifier returned `APPROVE-AS-BLOCKED` and confirmed Wrangler
    is unauthenticated and no staging Access evidence exists.
- [ ] Declare the production custom domain/route and set `workers_dev = false`
  and `preview_urls = false`; close every alternate or direct backend origin.
  - Evidence: the two generated-hostname settings and their real-file regression
    test are locally complete; an independent verifier returned
    `APPROVE-AS-BLOCKED`. The task stays open until an owner supplies the custom
    hostname/zone, inventories deployed origins, applies the route, and proves
    every alternate HTTP/WebSocket origin fails closed.
- [x] Choose one identity rule before creating tables. Recommended KISS model:
  one `(Access issuer, Access subject)` maps to one local account, with no social
  account-linking UI and a documented recovery path if the Access subject
  changes.
  - Decision and recovery contract are recorded in
    `SECURITY_IDENTITY_MODEL.md`; implementation tables are intentionally deferred
    to the next task. An independent security-architecture verifier returned
    `APPROVE`, including subject-change, race, duplicate-email, audit, and
    revocation behavior.
- [x] Add an authoritative global account/session store with `accounts`,
  `access_subjects`, and `sessions`; do not duplicate identity PII in every room.
  - Evidence: independent verifier `APPROVE`; 14 real-SQLite identity tests and
    8 real-workerd IdentityDO tests prove exact composite identity, concurrent
    first-login convergence, singleton access, hash-only session schema,
    constraints/cascades, no public route, and room/global schema separation.
- [x] Create an opaque server-managed `__Host-` application session after Access
  authentication, bind it to the Access principal and local authorization epoch,
  store only its hash, and implement rotation, idle/absolute expiry, logout,
  revoke-all, and account disablement.
  - Evidence: independent verifier `APPROVE`; 8 real-SQLite and 16 real-workerd
    tests prove hash-only 256-bit sessions, exact `__Host-` cookie protections,
    bounded idle/absolute expiry, non-extending atomic rotation, logout,
    epoch revocation, disablement, and fail-closed concurrency. The Access
    verification boundary and public session route are intentionally the next
    task.
- [x] Require a verified Access context on every protected Worker request and
  verify the expected audience and human-user identity. If explicit JOSE
  verification is retained as a fallback, validate algorithm, key ID, token
  type, issuer, audience, time claims, and non-empty subject with rotation-aware
  JWKS caching.
  - Evidence: independent verifier `APPROVE`; production and local assets run
    the Worker first, 37 focused verifier tests and 50 real-workerd tests prove
    fail-closed RS256/claims/context validation, bounded rotation-aware JWKS
    handling, local account/session binding, and JSON/no-store failures. A fresh
    isolated build and 5 real Chromium tests prove secure session bootstrap,
    protected API access, authenticated WebSocket `101`, and rejection of
    missing, malformed, forged, duplicate, and oversized credentials. Real
    Cloudflare variables and Google/Facebook staging remain external gate work.
- [x] Enforce exact `Origin`/CSRF checks for state changes and ensure expired SPA
  requests return an API `401`, not an HTML login page.
  - Evidence: independent verifier `APPROVE`; 9 focused and 53 full real-workerd
    tests prove exact-Origin rejection before session, Durable Object, body, or
    WebSocket work with no rejected side effects. All browser API/auth calls use
    forced same-origin credentials and Cloudflare's documented
    `X-Requested-With: XMLHttpRequest` contract. A fresh build and 2 real
    Chromium flows prove valid API/WebSocket operation and an expired signed
    Access assertion returning JSON/no-store `401`, no redirect or navigation,
    and fail-closed session UI. Real Access expiry remains a staging-gate check.

**Phase gate**

- [ ] Real staging logins work through Google and Facebook; forged, expired,
  wrong-audience, service-token, and alternate-origin requests fail closed; a
  locally disabled account is denied while its Access session remains valid.

### Phase 2 — enforce HTTP authorization and one admission state

- [x] Replace the parallel waiting-room and access-grant flows with one state
  machine keyed by local `account_id` (SEC-002).
  - Evidence: independent verifier APPROVE. `room_members` is the single
    grant machine (none / pending / viewer / editor / owner / banned).
    `/access`, `/requests`, and `/waiting` read and write that table; bearer
    tokens and `peerId` cannot obtain membership. `RoomDO.authorize` fails
    closed for unknown sections. Re-verified: `npm test` 214/214, `npm run
    test:workers` 79/79, typecheck clean. Residual: `applySchema` now
    drops leftover `room_access` / `access_requests` (independent verifier
    APPROVE; 284 unit / 99 workers; DROP mutant killed). y-webrtc remains
    P2P (Phase 3).
- [x] Implement the authorization matrix for every HTTP method before body
  parsing or sensitive reads; use consistent `401`, `403`, and `404` behavior.
  - Evidence: independent verifier APPROVE. `RoomDO.authorize` maps every
    room HTTP route; grant role is loaded before board/queue/PII reads;
    missing account is `401`, wrong role `403`, non-members `403` even if
    the room is missing. Re-verified: `npm test` 219/219, `npm run
    test:workers` 83/83, typecheck clean. Residual: scene and settings still
    share `POST /room` (next task); y-webrtc remains P2P.
- [x] Split canvas writes from creator-only room settings and lifecycle routes.
  - Evidence: independent verifier APPROVE. `POST /room/:id` is scene-only;
    `POST`/`PATCH /room/:id/settings` is owner-only; mixing fields on the
    wrong route is `400` with tables unchanged. Re-verified: `npm test`
    223/223, `npm run test:workers` 84/84, typecheck clean. Residual:
    create is two requests; delete is not yet atomic (later phase).
- [x] Bind creator, viewer, editor, waiting, moderation, and ban state to local
  accounts/grants rather than email, bearer hash, or client `peerId` (SEC-004).
  - Evidence: independent verifier APPROVE. Membership, waiting, kick, and
    join use Worker-stamped `accountId`; Bearer and email cannot select a
    grant; `hostPeerId` is a cursor label. Server-issued peer identity and
    Access staging remain open SEC-004 items. Per-session binding remains
    open.
- [x] Default the first-user host fallback to off and permit heartbeat/leave only
  for the authenticated caller's account.
  - Evidence: see the two SEC-004 items above. The fallback is now an opt-in
    per-room setting defaulting to off, and presence writes/deletes are refused
    when the named peer belongs to a different account. Enforcement is per
    account rather than per session; per-session binding stays open, as does the
    rest of this phase.
- [x] Add the complete table-driven negative authorization suite and the
  create-request-approve-join-expire-revoke E2E flow.
  - Evidence: independent verifier APPROVE for this item (not the gate).
    19-route missing/malformed/expired Access → 401 with tables unchanged;
    wrong-role/wrong-room → 403 including `/settings`; pending/anon leak no
    board/queue/email. New Playwright lifecycle spec passed (5/5).
    Re-verified: `npm test` 234, `npm run test:workers` 93, typecheck
    clean, `npm run test:e2e` 89 passed / 3 failed (stale UI specs).
    Residual: e2e TTL is `expiresAt` assertion only; real expiry is
    workers-only.

**Phase gate**

- [x] Every HTTP route is mapped to the matrix; rejected operations leave all
  tables unchanged; no anonymous or pending caller receives room data or PII.
  - Evidence: independent verifier APPROVE for the gate. Owner `GET`/`HEAD`
    `/settings` returns settings-only JSON (no scene); viewer/editor/pending/
    outsider get 403 with tables unchanged; missing session 401. Mutant
    (`owner` → `granted` on GET/HEAD settings) killed
    `matrix-role-viewer GET /settings` (200 vs 403); reverted.
    Re-verified: `npm test` 284, `npm run test:workers` 99, typecheck
    clean. E2E `room-authorization` 5/5; one unrelated `multi-peer` flake
    (92/93) is y-webrtc, not this gate. Residual: `HEAD /settings` is
    authorized but not in the table-driven route list; y-webrtc remains
    P2P (Phase 3).

### Phase 3 — replace the peer-to-peer security boundary

- [ ] Move Yjs synchronization from direct `y-webrtc` peers to authenticated,
  server-authoritative Durable Object WebSockets (SEC-001).
  - Evidence: independent verifier APPROVE-AS-BLOCKED (do not check).
    RoomDO relays binary frames to other granted sockets (sender excluded);
    dropping the ArrayBuffer branch timed out the workers test (reverted).
    Browser collaboration uses `y-websocket` `SignalingWebsocketProvider`
    against `/signaling?room=` (`url` getter is live in y-websocket 3).
    Residual: late-joiner e2e uses API persist, not Yjs history. Viewer
    binary and JSON `publish` are separately APPROVE (live `canWriteBoard`).
- [ ] Do not create a collaboration provider before approval and authorization.
  - Evidence: independent verifier APPROVE-AS-BLOCKED (do not check).
    `shouldStartCollaboration` blocks pending/waiting/kicked; the hook
    creates y-webrtc only after GET /room 200 or approved access, and
    destroys it on kick/waiting. Mutation-tested (dropped `isWaiting`;
    unit test failed; reverted). `npm test` 289, workers 99, typecheck
    clean. E2E 91/93: two `waitForPresence` failures are waiting-queue
    isolation (join-via-code / never-created URL), not a canvas grant.
    Residual: after grant, the client now opens y-websocket on `/signaling`
    (see Yjs move item); Phase 3 gate still needs e2e convergence.
- [ ] Use a same-origin, hostname-protected WebSocket upgrade carrying the local
  session unless a documented cross-origin requirement proves that a separate
  one-time ticket is necessary (SEC-003).
  - Evidence: independent verifier APPROVE for grant-gated `/signaling`
    upgrades (pending/outsider 403, owner 101). Origin + session were
    already required. Residual: ping/subscribe still have no write gate;
    Yjs binary shares this socket (see Yjs move item).
- [ ] Bind every socket attachment to `account_id`, `session_id`, room grant
  version, role, and expiry; validate exact `Origin`, protocol, topic, schema,
  message size, connection count, rate, and bounded fan-out.
- [ ] Implement room kick/revoke by incrementing the grant version and closing
  matching live and hibernating sockets.
  - Evidence: independent verifier APPROVE for immediate socket close on
    kick (4401) and for `rooms.grant_version` increment before close.
    Sockets stamp `grantVersion` at upgrade; stale binary/`publish` is
    dropped (`isStaleGrant` vs current DB). Mutants: skip increment
    (version stayed 0); `isStaleGrant` always false (stale relay tests
    failed). Residual: identity-wide disable still uses the ~30s alarm;
    hibernating ping auto-response does not wake the DO. Suspend now
    increments `grant_version` the same way as kick (verifier APPROVE).
- [ ] Revalidate hibernated-socket attachments on wake against current grant
  version, epoch, and expiry (SEC-003).
  - Evidence: independent verifier APPROVE for `webSocketMessage` entry
    guard: missing attachment, stale `grantVersion`, or `!isGrantedRole`
    → 4401. Subscribe after version bump closes the socket. Mutant skip
    `closeRevoked` killed that test. Residual: `{type:'ping'}` still uses
    `setWebSocketAutoResponse` and never hits the guard; epoch is still
    the ~30s identity alarm, not per-frame IdentityDO RPC.
- [ ] Choose and document account-wide revocation: reliable active-room fan-out,
  or a measurable maximum delay enforced by authorization-epoch revalidation,
  short socket expiry, and forced reconnect.
- [ ] Add raw-client adversarial tests for pending reads, viewer writes, socket
  replay, wrong room/origin, malformed/oversized frames, rate abuse, kick, and
  account-wide revocation.
  - Evidence: independent verifier APPROVE for viewer binary drop and
    viewer JSON `publish` drop. Each ArrayBuffer and each `publish` is
    gated with live `getGrantRole` + `canWriteBoard`; missing attachment
    fails closed. Mutants (skip each guard) killed the matching workers
    tests. Residual: ping/subscribe from viewers; viewer awareness binary
    is also dropped. Room kick now closes matching sockets immediately
    (4401); identity-wide disable still uses the ~30s alarm.

**Phase gate**

- [ ] Pending users receive no board bytes, viewers cannot publish, kicked users
  stop immediately, account revocation meets its documented maximum delay, and
  no direct peer path bypasses the server.

### Phase 4 — bound data, resources, and lifecycle

- [ ] Enforce room-ID, content-type, body-size, scene, field, URL, quota, and
  creation-rate limits before Durable Object allocation or JSON parsing
  (SEC-005).
  - Evidence: independent verifier APPROVE for scene-element bounds and
    an unwired in-memory `createRateLimiter`. `sceneElementSchema` requires
    a conforming id, caps strings at 4KiB, keys at 64, depth at 10, and
    `MAX_ELEMENTS` 10_000. Mutation `z.array(z.unknown())` killed 4 tests.
    Rate limiter: per-key sliding window; max-guard mutant killed 4 tests.
    Residual: limiter not on HTTP routes; URL/quota/429 not done.
- [ ] Replace security-sensitive `Math.random` values with at least 128 bits from
  a cryptographic RNG and make room creation transactional (SEC-006).
  - Evidence: independent verifier APPROVE for the CSPRNG slice only.
    Transactional create-with-owner already exists in RoomDO; capability
    vs display codes and client storage/rotation stay open. This Phase 4
    task stays unchecked.
- [ ] Implement creator-only atomic deletion across every room table, close all
  sockets, and prevent old grants from authorizing recreated rooms (SEC-007).
  - Evidence: independent verifier APPROVE for the atomic SQL slice and
    socket close 4404. Tombstone helper APPROVE (in-memory
    `createTombstoneStore` / `assertNotTombstoned`; add-noop mutant killed
    3 tests). Residual: not wired into RoomDO; `storage.deleteAll` and
    recreate-vs-old-grant proof are not done.
- [ ] Add TTLs and scheduled cleanup for rooms, sessions, grants, requests,
  waiting entries, kicks, PII, and tombstones.
  - Evidence: independent verifier APPROVE for editor-row purge only.
    `purgeExpiredGrants` deletes expired `role='editor'` rows for one room;
    owner/viewer/pending/banned and other rooms stay. Mutation-tested
    (dropped `role = 'editor'`; membership test failed; reverted).
    `npm test` 284/284. Residual: wired into `RoomDO.alarm()` (verifier
    APPROVE): unique `roomId`s on open sockets are purged before identity
    RPC. Skip-purge mutant left expired editor rows. Purge does not close
    live sockets (next non-ping frame does). Sessions, rooms, waiting,
    kicks, PII, and tombstone TTLs are not done. `effectiveRole` already
    treats expired editors as absent.
- [ ] Add boundary, quota, concurrent-create, injected-failure, expiry, deletion,
  and recreation tests.

**Phase gate**

- [ ] Oversized or abusive input is rejected without unwanted allocation or
  partial state; delete and expiry remove all scoped data and live access.

### Phase 5 — harden runtime, browser, privacy, and operations

- [ ] Remove or fully harden the legacy Node signaling deployment (SEC-009).
- [ ] Ship production-only dependencies on a maintained Node LTS and pin images
  and GitHub Actions immutably (SEC-010).
  - Evidence: independent verifier APPROVE for the local CI slice only
    (Node 22.23.2, SHA-pinned Actions, blocking high audit). The Phase 5
    task stays open because production-only install/image scan, digest-pinned
    runtime images, Cloudflare token scoping, and a deploy job gated on CI
    are not done. Do not treat the full SEC-010 section as complete.
- [ ] Remove plaintext shared-room persistence by default and clear all local
  room/session material on leave, kick, revoke, or expiry (SEC-011).
  - Evidence: independent verifier APPROVE for default-off cache and
    kick/waiting-leave/expiry clearing. In-room leave `clearOnLeave` is
    APPROVE-AS-BLOCKED: unit mutant killed peer-id clear; no Playwright
    spec asserts localStorage wipe on `whiteboard-leave-room-btn`. Residual:
    revoke/reject/suspend paths and TURN/relay.
- [ ] Add CSP, framing, content-type, referrer, permissions, cache, and indexing
  protections across assets and API responses (SEC-012).
- [ ] Minimize PII responses, replace internal error disclosure, and add
  structured redacted security-event logs and alert thresholds (SEC-013).
  - Evidence: independent verifier APPROVE for generic 5xx + log redaction
    and (earlier) owner-only queue PII. This Phase 5 task stays open
    because a structured `logAuthEvent` helper is APPROVE-AS-BLOCKED: unit
    tests prove email/JWT/bearer/cookie redaction (email-redact mutant
    killed 2 tests) but it is not imported from RoomDO or the Worker yet.
- [x] Remove production debug globals, restrict signaling configuration, and
  prove parity across every retained deployment (SEC-014).
  - Evidence: independent verifier APPROVE. Production signaling is
    fail-closed; debug globals are gated; the unsupported Node path is
    already gone so there is no second deployment to parity-test. Residual:
    `NEXT_PUBLIC_E2E=1` production builds still attach debug globals.
- [ ] Implement account erasure, data export, and the recorded minors policy
  (SEC-016).
- [ ] Add owner-role display integrity, name normalization, and moderation
  disambiguation (SEC-017).
  - Evidence: independent verifier APPROVE for ASCII-control stripping
    only. `stripAsciiControls` + `normalizedNameBase` on room name,
    presence `userName`, and request `userName`. Mutation-tested (skip
    `.replace`; 6 tests failed; reverted). `requestSchemas.test.ts` 33/33;
    full unit 326. Residual: owner-role display and duplicate-name
    disambiguation are not done. Scene-element bounds live in the same
    file and were still present at this verify.

**Phase gate**

- [ ] Header, privacy, retention, logging, runtime-image, hostile-input, and
  deployment-parity tests all pass without leaking credentials, PII, or boards.

### Phase 6 — release security verification

- [ ] Require lint, typecheck, unit, Worker, adversarial E2E, secret/PII scan,
  dependency audit, final-image scan, and staging smoke tests in CI.
- [ ] Review every HTTP route and real-time event against the authorization
  matrix and record reviewer approval.
- [ ] Run a staging penetration test covering authentication bypass, IDOR,
  privilege escalation, CSRF, WebSocket abuse, resource exhaustion, revocation,
  retention, and alternate-origin access.
- [ ] Record operational owners, deadlines, incident response, backup/restore,
  session/key rotation, monitoring, and emergency access-revocation procedures.

**Phase gate**

- [ ] Every P0/P1 task and adversarial test is complete, no high/critical finding
  is unowned, and the release owner signs off before public deployment.


### Phase 7 — paid membership and payments

Last by design. This phase must not start until the Phase 6 gate passes: an
entitlement is only as trustworthy as the account and revocation path it hangs
off, so billing built on an unfinished authorization boundary would be a way to
pay for access that the boundary cannot actually enforce.

- [ ] Decide and record the commercial model before writing code: what a plan
  entitles, who pays (teacher, school, or district), how seats are counted, what
  happens at the limit, and what the free tier is. The answer changes the data
  model, so it is a prerequisite rather than a detail. A concrete proposal
  (tiers, entitlement tables, state machine, downgrade semantics, Stripe hosted
  surfaces) is recorded under SEC-015 — sign-off or amendment of that proposal
  completes this task.
- [ ] Choose a payment processor with hosted checkout and record the resulting
  PCI DSS scope and the compliance obligations the deployment accepts.
- [ ] Add entitlement tables to the identity store keyed by `account_id`, with
  plan, status, current period, seat allocation, and an audit trail (SEC-015).
- [ ] Implement server-side checkout session creation with a server-selected
  price, an idempotency key, and no client-supplied amounts.
- [ ] Implement the signature-verified, deduplicated, replay-resistant webhook
  endpoint and the reconciliation job that detects missed events.
- [ ] Bind entitlement to the authorization epoch so downgrade, cancellation,
  non-payment, refund, and chargeback revoke access on HTTP and on already-open
  real-time connections.
- [ ] Enforce plan limits at the authorization boundary and return a distinct,
  non-leaking status for "over plan limit" versus "not permitted".
- [ ] Add the billing account-isolation, entitlement-tampering, webhook-forgery,
  replay, and revocation-propagation test suites against the processor's test
  mode.
- [ ] Build the public landing and pricing pages under the scoped Access
  exemption: marketing routes public and indexable, every app/API route still
  Access-protected and `noindex`, with a test that walks the exemption list
  and asserts nothing sensitive is inside it (SEC-015 sales surface).
- [ ] Publish terms of service and privacy policy pages and link them from the
  checkout flow; treat their absence as a release blocker for charging.
- [ ] Implement the sign-in -> server-created Checkout redirect funnel with no
  price/amount input from the client anywhere in the funnel.
- [ ] Record billing operations: refund and dispute handling, dunning, invoice
  retention versus erasure requests, secret rotation, and who is on call when
  payment state and access state disagree.

**Phase gate**

- [ ] No entitlement can be obtained without a server-verified payment event; no
  cancelled, refunded, or unpaid account retains access beyond the documented
  bound; billing state is isolated per account; card data never reaches this
  application; the reconciliation job proves local entitlement matches the
  processor; and the public-page Access exemption contains only marketing
  routes, verified by test.

### Product phases 8-10 — feature parity with security gates

Sourced from `MISSING_FEATURES.md` (Pencil Spaces gap analysis): of its full
Phase 0-7 feature ladder, these are the three highest-value layers by its own
priority table. They live in this file because each one opens a new attack or
PII surface, and the security work is part of the feature, not a follow-up.
They may proceed in parallel with Phase 7 (payments); they must not start
before the Phase 3 gate (server-authoritative sync), because every one of them
assumes the server can enforce who sees what.

**Status update (2026-08-18):** LiveKit voice and video calling landed ahead
of plan (merge `362a3e9`): server-minted join tokens for admitted accounts
only, identity forced to the verified account, waiting/suspended denied,
secrets in Worker bindings. This changes the build order — the feature doc's
P0 layer ("A/V + chat") is half done, so finishing and hardening what shipped
now outranks starting new surface.

#### Build order (milestones, most important first)

Each milestone is a shippable slice; its checkboxes live in the phases below.
Order rationale: harden what exists, then complete the classroom P0 (chat),
then the persistence foundation everything later assumes, then structure,
then recording last because it is gated on the SEC-016 minors policy.

| # | Milestone | Why now | Checkboxes |
| --- | --- | --- | --- |
| M1 | A/V hardening: live eviction on kick/ban, host-gated screen share | The gap shipped with the feature; every day it stands, a kicked student can stay on the call | Phase 10, first three items |
| M2 | In-space chat (group first) | Completes the feature doc's P0 layer; first stored student content, so it drags SEC-016/017 into practice | Phase 9, chat items |
| M3 | Cloud Spaces + real library | The foundation layer the feature doc says unblocks everything; boards stop being ephemeral | Phase 8, all items |
| M4 | Private per-student boards + breakouts | Highest-value classroom structure; child rooms reuse the room grant model | Phase 9, private-board items |
| M5 | Host controls: raise hand, timer, follow-me, per-student permissions | Session-management polish on top of M2-M4 primitives | Phase 9, remaining items |
| M6 | Recording + transcripts | Hard privacy surface; blocked on the SEC-016 minors policy being recorded first | Phase 10, recording items |
| M7 | Teaching content: Drive/OneDrive import, PDF annotation, vetted embeds | Needs the M3 library to land imports into; the OAuth and embed surface must follow the Phase 11 contract, not ad-hoc scopes | Phase 11, all items |

Not scheduled (tracked in `MISSING_FEATURES.md` only): scheduling/rostering,
education SSO, LMS/SIS, admin consoles, AI layer — high effort, later market
stage, and the AI items depend on M6 existing first. In-board Google Docs
*editing* is also deferred: unlike import, it requires broad write scopes and
a live third-party editing surface inside the board, which multiplies the
Phase 11 contract for one feature.

### Phase 8 — cloud Spaces and real persistence

The foundation layer: named persistent Spaces, cloud board history/restore,
and a real content library replacing the `LibraryPanel` stub. Security-wise
this turns boards from ephemeral rooms into long-lived stored records.

- [ ] Named persistent Spaces (create / open / list) owned by the creator's
  `account_id`; the Space list route returns only the caller's own Spaces.
- [ ] Extend the authorization matrix to Spaces, board history, and library
  items before any of them ship — same `401`/`403` discipline as rooms
  (SEC-002), same account-keyed grants (SEC-004).
- [ ] Cloud board history / restore with bounded depth; restore is
  owner-gated and audited, and history inherits the room's retention clock
  rather than living forever (SEC-007).
- [ ] Real content library: per-account saved items, size- and count-bounded
  (SEC-005), never shared across accounts without an explicit grant.
- [ ] Cross-device sync of library items rides the existing session, not a new
  token or storage channel.
- [ ] Fold all new tables into deletion, retention, erasure, and backup:
  SEC-007 TTLs, SEC-016 account erasure, and the tested restore path.

**Phase gate**

- [ ] A teacher can close a Space and reopen the same board on another device;
  no route leaks another account's Spaces, history, or library items; erasing
  an account removes its Spaces, history, and library within the documented
  deadline.

### Phase 9 — classroom session UX

Chat, raise hand, session timer, follow-me, per-student edit permissions, and
private boards / breakouts. This is the phase where *student-generated
content* (messages) is stored for the first time, so SEC-016/SEC-017 stop
being abstract.

- [ ] In-space chat, group first: messages bound to `account_id`, rendered
  with the SEC-017 name normalization and owner-role display integrity, with
  server-side length/rate bounds (SEC-005) and owner delete.
- [ ] Chat retention is short by default and recorded in the SEC-007 policy;
  student messages are PII and join the SEC-016 erasure and export paths
  before launch, not after.
- [ ] Raise hand, session timer, and connection indicators as presence-channel
  events — schema-validated, rate-bounded, carrying no free text.
- [ ] Follow-me / view lock is a host-issued hint enforced client-side only;
  document explicitly that it is a UX affordance, not a security control, so
  no later claim treats it as one. Per-person viewport stays the default.
- [ ] Granular per-student edit permissions extend `room_members.role` rather
  than adding a parallel store; the authorization matrix gains the new role
  column before the UI does.
- [ ] Private per-student boards and breakout rooms are child rooms with their
  own grant rows: the owner sees all, a student sees only their own; the
  Phase 3 socket boundary enforces it for live sync, not the client.
- [ ] Idle / distraction alerts are aggregate and ephemeral (no per-student
  browsing surveillance is stored) — record this as a deliberate privacy
  decision.

**Phase gate**

- [ ] A student cannot read another student's private board or 1:1 chat by any
  raw-client request; moderation and permission changes resolve to accounts;
  chat erasure works; a forged follow-me event moves nobody's authorization.

### Phase 10 — live A/V and recording

Audio, video, screen share, then session recording with transcripts. The
heaviest privacy surface in the entire roadmap: live media from minors, and
stored recordings of them. Recording items must not start before the SEC-016
minors policy is recorded. Voice and video landed 2026-08-18 (merge
`362a3e9`); the unchecked A/V items below are the hardening that must follow
it (milestone M1).

- [x] Choose the media path deliberately: SFU or managed service with
  per-session, server-issued join tokens bound to the room grant — never P2P
  mesh for classroom A/V, or SEC-001 returns as an unfixable media problem
  (peer IP exposure between students).
  - Evidence: LiveKit SFU. HS256 join tokens are minted in RoomDO only for
    admitted accounts (waiting/suspended/outsiders get 403), the token
    identity is forced to the server-verified account id (a client-chosen
    identity could bump another participant's live session), and secrets live
    in Worker bindings with a 503 graceful-degrade when unset. 276 unit, 76
    workers, and 92 e2e tests passed on the merge.
- [ ] A/V join/leave rides room authorization: kick, suspend, ban, and epoch
  revocation must drop live media within the same documented bound as sockets.
  - Partially landed ahead of phase (Phase 3 A/V merge, 2026-08-18): LiveKit
    join tokens are minted server-side for admitted accounts only, the token
    identity is forced to the verified account (a client-chosen identity could
    bump another participant's session), waiting/suspended accounts are denied,
    and secrets stay in Worker bindings. Review round 2 (`15e994e`): the token
    route is POST-only — GET minting sat in the intersection of the
    SameSite=Lax cookie (sent on top-level GET navigations) and the origin
    guard's GET exemption — with roomId grammar validation and the shared
    security headers; mutation-tested. Independent verifier APPROVE
    (2026-08-18): `banned` is `not-a-member` and is checked before the
    `waiting_peers` override; treating banned as admitted killed 3 tests.
    **Open gap:** a kick or ban revokes future joins but does not evict an
    already-connected media participant — wire server-side eviction through
    LiveKit's room service API (`RemoveParticipant`) into the same paths
    that close room sockets.
- [ ] Screen share is host-approved per instance for students, on by right
  only for the owner.
- [ ] Recording requires explicit, visible, per-session consent; a recording
  indicator every participant can see; and a recorded decision on who may
  start it (owner only by default).
- [ ] Recordings and transcripts are stored encrypted, owner-scoped, join the
  SEC-007 retention schedule and SEC-016 erasure/export, and never leave the
  declared storage region.
- [ ] Transcripts of minors are the most sensitive data this product would
  hold: default them off; enabling is a per-Space owner decision recorded with
  the consent trail.
- [ ] Extend the abuse story (SEC-017) to media: report path, and owner mute /
  camera-off controls that act on accounts.

**Phase gate**

- [ ] Media join is impossible without a current room grant and dies on
  revocation within the bound; no recording exists without its consent trail;
  recordings honor retention, erasure, and export; a student cannot screen
  share without host approval.

### Phase 11 — teaching content and third-party integrations

Drive/OneDrive import, PDF/document annotation, and embedded third-party
tools (Desmos, Kahoot, and similar). This is the layer most often built
dangerously: broad OAuth scopes "to be safe", refresh tokens in the browser,
and unsandboxed iframes. The contract below is what keeps a whiteboard from
becoming a bridge into a teacher's entire Drive.

- [ ] Import uses the narrowest possible OAuth scope: Google `drive.file` via
  the Picker (access only to files the user explicitly picks, not the Drive),
  and the OneDrive file-picker equivalent. Broad `drive.readonly` or full
  Drive scopes are prohibited; adding any scope is a reviewed change to this
  file.
- [ ] Provider tokens never reach the client or persistent storage in
  plaintext: short-lived access tokens are used server-side and discarded;
  if offline refresh tokens are ever genuinely needed, they are encrypted at
  rest, scoped per account, revocable from the account page, and covered by
  SEC-016 erasure. Prefer designs that need no refresh token at all —
  import-as-copy, then forget the source.
- [ ] Imported files become *our* stored objects: content-type allowlist
  (PDF, images, and the office formats actually supported), size caps
  (SEC-005), server-side re-encoding or sanitization for anything rendered
  (SVG and PDF are script-capable), and storage that joins retention
  (SEC-007), erasure/export (SEC-016), plan quotas (SEC-015), and backup.
- [ ] A student's view of imported content is served from our origin, never a
  proxied provider URL, so a revoked import cannot keep leaking through a
  long-lived third-party link and provider cookies never mix into board
  traffic.
- [ ] Embeds run in sandboxed iframes with an explicit per-tool allowlist:
  `sandbox` without `allow-same-origin` toward us, a CSP `frame-src` listing
  exactly the vetted tool origins (the enforced-CSP work in SEC-012 gains
  this list), no postMessage handling without origin checks, and no tool
  added outside a reviewed allowlist change. Embedded tools never receive
  the session cookie, account ids, or roster data.
- [ ] The embed allowlist is owner-controlled per room and off by default, so
  a compromised or policy-violating tool can be cut off by config, and a
  room's students only ever load third-party origins its teacher chose.
- [ ] Each integration records what data flows *to* the provider (usually
  nothing beyond the user's own OAuth consent) and is added to the SEC-016
  data inventory before launch.

**Phase gate**

- [ ] Import works with only picked-file scope and no stored plaintext
  provider tokens; a hostile SVG/PDF cannot execute in a viewer's session;
  embedded tools load only from the allowlist, sandboxed, with no session or
  roster data; revoking an import or an embed stops student access; imported
  objects honor quotas, retention, erasure, and export.

## Definition of done

- Every P0 task and its adversarial tests pass.
- Both production-only and full dependency audits pass at high severity.
- Lint, typecheck, unit, Worker, E2E security, secret/PII scan, and final-image
  scan are required deployment gates from a clean checkout.
- A reviewer maps every HTTP route and real-time event to the matrix above.
- Both supported deployments meet the same contract, or the weaker deployment
  has been removed.
- Operational owners, deadlines, retention, incident response, backup, restore,
  and credential-rotation procedures are recorded.
- If paid membership ships, no entitlement exists without a server-verified
  payment event, revocation propagates to live connections, and card data never
  reaches this application (SEC-015).
- If Phases 8-10 ship, every new object type (Space, history, library item,
  chat message, private board, recording) is in the authorization matrix, the
  retention schedule, and the erasure path before its UI ships.
- If Phase 11 ships, no integration holds a broader scope than picked-file
  access, no plaintext provider token is stored, and no third-party origin
  loads in a room outside the owner-controlled allowlist (Phase 11 gate).

## Running locally

The local stack is native — `wrangler dev` plus two small Node scripts — and
deliberately not docker-compose. The repository removed its Docker path as
part of SEC-009 precisely because a second way to run the app is a second
security surface to keep in parity (SEC-014); reintroducing one for local
convenience would recreate that drift, and `workerd` under `wrangler dev` is
already the same runtime that serves production. If a container wrapper is
ever genuinely needed (for example CI on a locked-down runner), it must wrap
these same commands, not define its own server.

Prerequisites: Node (the version CI pins in `.github/workflows/ci.yml`),
`npm ci`.

| Command | What it runs |
| --- | --- |
| `npm run dev` | `next build` + `wrangler dev` — the real Worker, Durable Objects, static assets |
| `npm run dev:access` | Local Cloudflare Access stand-in (`scripts/local-access-issuer.mjs`): signs real RS256 assertions with a throwaway key, including negative variants (expired, wrong issuer/audience) |
| `scripts/local-access-proxy.mjs` | Fronts the Worker like Cloudflare's edge would: turns a login cookie into `Cf-Access-Jwt-Assertion` and strips any client-supplied copy of that header |
| `npm run test:e2e` | Orchestrates all of the above on free ports and runs Playwright against the production build — the closest thing to staging that exists locally |

Notes:

- The authentication boundary is exercised for real locally: the Worker
  verifies the local issuer's JWKS exactly as it would Cloudflare's, so
  forged/expired/wrong-audience requests fail closed in local runs too.
- Local state lives in `.wrangler/` (Durable Object SQLite) and is ignored;
  never point local runs at `.data/` or commit local databases (SEC-008).
- A/V needs `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` in
  `.dev.vars` (a LiveKit Cloud dev project or a local `livekit-server`).
  Without them the token route returns 503 and the board runs without A/V —
  that degradation is itself a tested path.
- Never put real production secrets in `.dev.vars` or `wrangler.local.toml`;
  local runs use throwaway credentials only.
