# Security controls and decisions

Last reviewed: 2026-09-13.

This document records the security controls this application enforces, the
evidence for each, and the decisions and accepted risks behind them. **It has no
open tasks.** Every item that was once a task is now either closed with evidence
or carries a dated resolution: the fix, the decision that replaced it, or the
owner action that only a person can take.

- Owner actions (role assignment, an independent penetration test, GitHub and
  Cloudflare account settings, incident close-out) are in
  [`SECURITY_OPERATIONS.md`](SECURITY_OPERATIONS.md) §8. They are the only open
  security items.
- Requirements for features not yet built (board history, chat, private boards,
  recording, imports, embeds) are in
  [`SECURITY_FEATURE_REQUIREMENTS.md`](SECURITY_FEATURE_REQUIREMENTS.md).
- The route-by-route and frame-by-frame authorization review is
  [`SECURITY_ROUTE_REVIEW.md`](SECURITY_ROUTE_REVIEW.md).
- Erasure windows, the minors policy and billing retention are in
  [`SECURITY_DATA_PROTECTION.md`](SECURITY_DATA_PROTECTION.md).

Evidence comes from source review, the unit, Worker and end-to-end suites,
targeted and Stryker mutation testing, and live probes of production. No
independent penetration test has been performed (owner action 4).

Related findings: `SECURITY_AUDIT_2026-09-10.md` (SEC-A01 to SEC-A16) and the
[post-billing sweep](#post-billing-security-sweep--2026-09-12) below (SEC-A17 to
SEC-A28). The phase-by-phase task plan this document used to carry, with its
per-phase evidence, is in git history at commit `4de9e9c`.

Priority meanings, as originally assigned to each finding:

- **P0:** security boundary was ineffective; fixed before public use.
- **P1:** exploitable data-loss, availability, privacy, or supply-chain risk.
- **P2:** defense in depth and operational hardening.

## Status of the previous review

History, kept for context: everything this section describes was fixed under
SEC-001 to SEC-004 below. The previous review was correct that room APIs, moderation, signaling, and
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

- Cloudflare Access is the identity broker and handles the provider callback
  and authentication session. Production accepts **Google only** (decision D-1);
  the allowed provider is pinned in Terraform, so adding one is a reviewed change.
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

| Operation | Unauthenticated | Guest session | Authenticated pending | Viewer | Peer/editor | Creator |
| --- | --- | --- | --- | --- | --- | --- |
| Request access / check own request | no | yes, self, rate-limited | yes, rate-limited | yes | yes | yes |
| Read room canvas | no | no until granted | no | yes | yes | yes |
| Publish canvas update | no | no until editor grant | no | no | yes | yes |
| Heartbeat/leave as self | no | yes | no | yes | yes | yes |
| Read active users | no | no until granted | no | minimal list | minimal list | full list |
| Read waiting queue or request PII | no | no | no | no | no | yes |
| Change room settings | no | no | no | no | no | yes |
| Approve, reject, suspend, kick, revoke | no | no | no | no | no | yes |
| Delete room | no | no | no | no | no | yes |
| Open real-time read channel | no | no until granted | no | yes | yes | yes |
| Open real-time write channel | no | no until editor grant | no | no | yes | yes |

A guest holding `__Host-teacher-guest` is a distinct principal from
Access-authenticated users; owner-only rows stay `no` for that column.

All decisions must use one normalized room ID, one server-derived principal,
one grant state, and one expiry/revocation policy. A room code or client-supplied
`peerId` is never authorization.

## P0 — establish a real security boundary

### SEC-001 — replace or constrain the peer-to-peer sync architecture

**Evidence (2026-08-18):** granted browsers sync Yjs over authenticated
`/signaling` (`SignalingWebsocketProvider` / y-websocket). Collaboration
starts only after GET /room 200 or approved access. Kick closes sockets
**4401** and bumps `grant_version`. Direct y-webrtc is not used for the
board.

- Choose and document one enforceable model. Recommended: move Yjs sync to
  authenticated, server-authoritative Durable Object WebSockets so the server
  can authorize each read/write and disconnect revoked sessions.
  - Evidence: independent verifier APPROVE-AS-BLOCKED then type-fixed; host→peer
    e2e over `/signaling` with WebRTC sentinel count 0.
- Do not create any sync provider until the access state is approved.
  - Evidence: `shouldStartCollaboration`; independent verifier APPROVE-AS-BLOCKED
    (waiting-queue e2e flakes, not a grant bypass). Pending e2e: no `/signaling`
    until approve (orchestrator full-build 1/1).
- Bind each live connection to a grant, role, session ID, and expiry.
  - Evidence: `SocketIdentity` stores `accountId`, `sessionId` (64-hex
    `sessions.session_hash` stamped by `forward()`), `authorizationEpoch`,
    `roomId`, and `grantVersion`; upgrade requires non-empty `sessionId` (401
    without). Role checked live on each message; expiry via grant TTL and
    alarm epoch revalidation. Independent verifier APPROVE. Mutation-tested
    (`forward()` sessionId stamp; JSON type whitelist). Workers: forged
    `sessionId` query overwritten; `explode` not relayed; viewer does not
    receive writer JSON `publish`. Residual: no dedicated empty-`sessionId`
    401 test (Worker `sessionAuthorized` + stamp is the live path). Closed 2026-09-13: `roomDOGuards.workers.test.ts` › refuses a signaling upgrade that carries no session; mutant (check removed) killed.
- On kick, revoke, or expiry, close the live channel and reject reconnects.
  - Evidence: independent verifier APPROVE for kick/suspend 4401 + grant_version;
    LiveKit RemoveParticipant APPROVE; stale ping 4401 APPROVE.
- If direct P2P is retained, remove `viewer` and security claims about kick
  or waiting-room enforcement; treat every admitted peer as a trusted editor.
  - Not retained. Viewers cannot publish binary or JSON `publish`.

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

- Replace the parallel waiting/grant flows with one admission state machine.
  Evidence: `room_members.role` is the single grant machine
  (`owner`/`editor`/`viewer`/`pending`/`banned`); `/access`, `/requests`, and
  `/waiting` read and write it; bearer tokens and `peerId` cannot obtain
  membership. Independent verifier APPROVE (Phase 2). See Phase 2 evidence.
- Require a cryptographically verified Access principal and enabled local
  account to create a room. Bind the creator grant to that local account; do not
  infer ownership from provider, email, room code, or peer ID.
  Evidence: every protected Worker request requires a verified Access context
  (Phase 1, independent verifier APPROVE); room creation requires an
  authenticated account and binds the owner grant to `account_id`.
- Apply the matrix above to every route before reading JSON or querying
  sensitive state.
  Evidence: `RoomDO.authorize` maps every room HTTP route; grant role is loaded
  before board/queue/PII reads. Independent verifier APPROVE (Phase 2).
- Enforce same-origin/CSRF checks on every cookie-authenticated mutation.
  Evidence: `originGuard()`/`hasExactOrigin()` in `src/worker.ts` runs before
  any DO, body, or WebSocket work on every non-GET/HEAD path; returns 403 on
  mismatch. Independent verifier APPROVE (Phase 1).
- Split scene writes from creator-only settings changes.
  Evidence: `POST /room/:id` is scene-only; `POST`/`PATCH /room/:id/settings`
  is owner-only; `RoomDO.authorize` routes them on distinct paths with distinct
  rules. Independent verifier APPROVE (Phase 2).
- Return consistent `401` for missing/invalid identity and `403` for a valid
  principal with the wrong role.
  Evidence: missing account → 401, wrong role → 403, non-members → 403 even if
  room is missing. Independent verifier APPROVE (Phase 2).

**Acceptance tests:** table-driven Worker tests cover missing, malformed,
expired, revoked, wrong-room, and wrong-role credentials for every method. A
rejected request leaves every room table unchanged. E2E covers create, request,
approve, join, refresh, expiry, revoke, and denial.

### SEC-003 — authenticate and bound WebSocket admission

**Evidence (2026-09-10):** `/signaling` requires Access + local session, exact
Origin, Worker-stamped `accountId`/`accountEpoch`/`sessionId`, and a granted role
before `acceptWebSocket`. Frame size 32 MiB (`MAX_WS_FRAME_BYTES`) → 1009;
account socket cap 4; message rate 120/window → 1008, closing only on a
sustained 360/window episode.

- Prefer a same-origin, hostname-protected upgrade authenticated by Access
  and the local application session. Add a short-lived, single-use,
  room/role/session-bound ticket only if a documented cross-origin transport
  requires one; never put long-lived credentials in URLs.
  - Evidence: independent verifier APPROVE (Phase 1 Origin + session; Phase 3
    grant gate). No ticket in URLs.
- Validate the exact allowed production `Origin` and reject unknown origins.
  - Evidence: independent verifier APPROVE; session CSRF mutant killed.
- Require an existing room and bind the connection attachment to its room.
  - Evidence: `roomId` on attachment; pending/outsider 403 before accept.
- Enforce protocol schemas, expected topic, frame size, sockets per room and
  principal, message rate, and bounded fan-out.
  - Evidence: JSON types `subscribe`/`unsubscribe`/`ping`/`publish` only;
    `publish` topic must be `room` (`SIGNALING_ALLOWED_TOPIC`); independent
    verifier APPROVE-AS-BLOCKED for the topic slice then split so this item
    can close. Frame **32 MiB** (`MAX_WS_FRAME_BYTES`) → **1009**; account cap
    **4**; room cap **32** (workers prove the cap via
    `signalingMaxSocketsPerRoomForTests`); rate **120/window** → **1008** on a
    sustained 360/window episode. Fan-out: JSON `publish` reaches `canWriteBoard`
    peers only (viewers excluded); binary sync frames relay a server-sanitized
    diff (`sceneGuard`, SEC-A02) to granted recipients (viewers included,
    read-only); every broadcast path is grant-filtered (SEC-A04). Mutants: topic
    invert killed mismatch test; Cookie strip is SEC-004.
- Redact credentials/tickets from logs and metrics.
  - Evidence: `logAuthEvent` redacts JWT/Bearer/Cookie/email; workers assert
    auth_failure lines contain neither Access JWT nor `__Host-teacher-session`.
- Revalidate on hibernation wake: a WebSocket attachment written at accept
  time is a snapshot, not a session. On wake (message or alarm after
  hibernation), re-check the attachment's grant version, account epoch, and
  expiry against current state before acting on any frame, so a revocation that
  happened while the socket slept is enforced at the first byte, not at the
  next reconnect.
  - Evidence: independent verifier APPROVE for ping: no
    `setWebSocketAutoResponse`; stale grant on ping closes 4401. Grant version
    and role are re-checked on every frame; account epoch and the exact session
    hash (`activeSessionHashes`) are re-checked by the alarm (≤30 s, SEC-A03).

**Acceptance tests:** missing, revoked, expired, wrong-room, and foreign-origin
upgrade credentials fail; if tickets are retained, replay also fails; topic
mismatch is dropped; oversized frames close with `1009`; policy violations close
with `1008`; rate excess isolates only the attacker.

### SEC-004 — bind identity and moderation to the authenticated session

**Evidence:** join/heartbeat labels are server-issued; host display uses
`isHost` from `grant_role`. Client `localStorage` may still hold a locator.

- Issue peer/session identity server-side from the approved grant.
  - Evidence: independent verifier APPROVE. `peerIdForAccount` ignores body
    `peerId` on join/heartbeat, reuses the account's row, or mints
    `user-` + 32 hex. Mutant restoring client `peerId` killed
    `issues a stable server peerId…`. Residual: join schema still requires a
    dummy body `peerId`. An API wart only: the value is ignored for authority.
- Configure and staging-test Google and Facebook in Cloudflare Access.
  Platform: needs a real Access application, hostname, and IdP credentials
  (`CLOUDFLARE_ACCESS_STAGING.md`). Local Access issuer covers tests only.
  - Resolution (2026-09-13): Google is live in production through the
    Terraform-managed Access application, with the allowed provider pinned and
    `npm run access:check` blocking in CI. Facebook is deliberately not added
    (D-1). There is no staging environment (D-3); production fails closed on
    live probes: unauthenticated and forged-JWT requests to the teacher host are
    redirected to Access login.
- Require the verified Access context inside the Worker and resolve its
  issuer/subject pair to an enabled local account before any protected route
  reaches a Durable Object.
  - Evidence: Phase 1 independent verifier APPROVE (`verifyAccessRequest` +
    IdentityDO session). Forged/expired/wrong-audience fail closed. Real
    Google/Facebook staging remains the platform item above.
- Use one Access issuer/subject pair as one local account, expose no social
  account-linking UI, and document a reverified recovery process if an Access
  subject changes. Never merge distinct local accounts merely by matching email.
  - Evidence: `SECURITY_IDENTITY_MODEL.md`; Phase 1 identity-rule verifier
    APPROVE. `access_subjects` is a composite unique key; no linking UI.
- Add local disable, logout, revoke-all, and provider-account removal
  behavior. Revocation must take effect on HTTP and already-open real-time
  connections even if the Cloudflare Access session remains valid.
  - Evidence: Phase 1 session verifier APPROVE (`revokeAllSessions`, logout,
    disable + epoch). Live sockets: kick/suspend 0 s; logout, idle/absolute
    expiry, disable, revoke-all ≤ 30 s via exact-session-hash and epoch
    revalidation; guest access disable closes guest sockets immediately
    (`SECURITY_REVOCATION_BOUND.md`). Provider-account unlinking is N/A
    under the no-linking identity rule; Access IdP removal is platform.
- Strip inbound identity headers on Worker `forward()` so RoomDO never
  sees client cookies, Access JWTs, or injected account headers.
  - Evidence: independent verifier APPROVE. `stripForwardedIdentityHeaders`
    drops `Cookie`, `Authorization`, `Cf-Access-Jwt-Assertion`,
    `Cf-Access-Authenticated-User-Email`, `X-Account-Id`, `X-User-Id`,
    `X-Forwarded-User`. WS upgrade headers and `Origin` kept. Session still
    only on stamped query params. Mutant: omit `cookie`; killed strip unit
    tests.
- Close every unprotected alternate origin, route, preview, and
  legacy-server bypass.
  Legacy Node signaling is already gone.
  - Resolution (2026-09-13): `workers_dev = false` and `preview_urls = false`
    (pinned by `deploymentPolicy.test.ts`); production serves only its three
    custom domains. Live probes: teacher APIs, billing and session routes answer
    404 on the guest and marketing hosts, and `workers.dev` serves nothing.
    Route inventory in `SECURITY_ROUTE_REVIEW.md`.
- Ignore client-supplied identity for authorization.
  - Evidence: `forward()` in `src/worker.ts` overwrites `accountId`/`accountEpoch`
    with `searchParams.set`, so a client-supplied value cannot survive into the
    Durable Object, and `RoomDO.authorize` decides on the server-derived account
    rather than the request's `peerId`.
- Allow heartbeat and leave only for the caller's own session.
  - Evidence: `RoomDO.peerAccountId` refuses a presence `POST` that claims a
    `peerId` another account owns and a presence `DELETE` for a peer another
    account owns; moderation `POST`s are excluded from peer binding so a kick or
    suspend cannot transfer the target peer to the moderator. Verified by real
    workerd tests, and all three guards were mutation-tested (removing each one
    fails the suite). **Granularity note:** enforcement is per *account*, not per
    session — two sessions of the same account can still act on each other's
    peers. Per-session binding is not required (D-20).
- Moderate and ban a grant/session, not a replaceable `peerId`.
  - Evidence: independent verifier APPROVE. Kick/reject ban the
    `account_id` and clear that account's presence/waiting rows; a new
    `peerId` stays `403`. Optional body `peerId` must match the bound
    account (`409` mismatch). Forging creator `peerId`/`hostPeerId` grants
    no owner power. Re-verified: `npm test` 222/222, `npm run test:workers`
    88/88, typecheck clean. Residual: per-account not per-session; (not required, D-20); e2e for
    this slice did not run (locked `out/` on Windows).
- Require fresh proof for destructive owner actions: room deletion and
  revoke-all must not ride a long-idle session cookie alone. A recent-activity
  threshold or an explicit re-confirmation bound to the session (not a UI-only
  dialog) is enough; a stolen cookie should not be able to erase a class's
  boards silently.
  - Evidence: independent verifier APPROVE for room `DELETE`. Sessions older
    than 5 minutes without `POST /auth/session/confirm` get 403
    `Reauthentication required` and the room stays. Mutant always-allow DELETE
    killed the stale-cookie workers test. Revoke-all is IdentityDO-internal
    (`/accounts/revoke-all` with accountId body), not a session-cookie Worker
    route, so the stolen-cookie threat does not apply there.
- Make the first-user host fallback an explicit per-room setting that
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

- Define one server-side room-ID grammar/length and reject before DO lookup.
  - Evidence: `isValidRoomId` (`^[A-Za-z0-9_-]{1,64}$`) rejects with `400` in
    `src/worker.ts` before `idFromName`, on both `/api/whiteboard/room/*` and the
    `/signaling` upgrade. Mutation-tested.
- Prefer signed or otherwise verifiable IDs so random invalid IDs do not
  allocate Durable Objects.
  - Resolution (2026-09-13): Not signed IDs (D-4). The one unauthenticated path
    that reached a room object with an arbitrary id, guest PIN entry, now checks
    the room registry first, so a guessed id never creates a Durable Object
    (`28d1904`, `worker.guest.workers.test.ts`). Every other room route requires
    Access and a session and is rate-limited per account.
- Require room existence for every subroute before persisting anything.
  - Evidence: missing `rooms` row → 404 on subroutes and signaling; presence
    writes nothing. POST room root still creates. GET `/access` on a
    never-created id is 200 `{status:'none'}` so create 429 can apply.
    Mutant: drop that exception; access-none test failed (404 vs 200).
    PII-matrix workers test timeout raised to 20s (was 5s flake).
- Enforce content type and byte limits before `request.json()`; return `413`.
  - Evidence: mutations over the 1 MiB cap return `413` from declared
    `Content-Length` or from the actual body when `Content-Length` is omitted
    (`readBoundedJsonBody`). A mutation declaring a body without JSON content
    type returns `415`. Both run before the Durable Object. Independent
    verifier APPROVE (mutant skipped `byteLength > MAX_BODY_BYTES`; unit and
    workerd tests failed; reverted).
- Bound element count, serialized scene bytes, nesting, field lengths,
  access/waiting counts, sockets, and writes per interval.
  - Evidence: `MAX_ELEMENTS` 10_000, nest depth 10, string/key caps, blocked
    embed types, `MAX_WAITING` 50, signaling socket and message-rate caps,
    scene/create 429s, and the 1 MiB body cap as the serialized-scene bound.
    Residual: no separate post-parse byte count besides that cap; WAF is the
    platform bullet below.
- Validate email, color, viewport, role, maximum users, and permitted scene
  element types/URL schemes. Disable `iframe`, `embeddable`, image, or external
  link behavior unless explicitly required and safely allowlisted.
  - Evidence: independent verifier APPROVE. Schema rejects iframe/embeddable/
    magicframe/image; links only `https:` or relative. Email/color/viewport/
    role/maxUsers already bounded. Mutant dropped `iframe`; type-reject
    test failed.
- Add per-principal/IP creation and request limits with `429` responses.
  - Evidence: independent verifier APPROVE. Room create 10/min and
    `POST .../requests` 20/min per account → 429 + Retry-After. Mutant skip
    request `take()` killed the 429 test (201 vs 429). Residual: no IP
    key; WAF is the platform bullet below. Accepted: creation requires Access and a session, and tutor accounts are capped at 50.
- Configure edge-level protection in front of the Worker: Cloudflare custom
  WAF rules and rate limiting on the production zone, so floods are dropped
  before they bill Worker invocations. Free-plan budget: 5 custom WAF rules and
  exactly 1 rate-limiting rule (plus basic Bot Fight Mode; managed rulesets are
  paid) — spend the single rate-limit rule on the most abusable route
  (room creation or session issue) and treat app-level quotas above as the
  primary mechanism, not the backup.
  Platform: production zone + paid/free WAF inventory. App-level 429s are
  the local primary control (SEC-005 above).
  - Resolution (2026-09-13): The zone's single free rate-limit rule is applied
    by Terraform to guest PIN submission, the only unauthenticated write
    (`infra/cloudflare/ratelimit.tf`). No custom WAF rules (D-5): the Worker's
    host and route allowlist refuses everything else.

**Acceptance tests:** malformed/oversized IDs never instantiate a DO;
nonexistent-room subroutes persist nothing; just-over-limit bodies return
`413`; quota overflow returns `429`; hostile scenes cannot trigger external
loads or crash clients.

### SEC-006 — use cryptographic room and capability creation

**Original finding:** room identifiers were 8 characters of `Math.random`
(~41 bits) and room creation was not one transaction. Both are closed below:
room ids are 128 bits from `crypto.getRandomValues`, a peer id is a display label
that grants nothing, and room, owner grant and registry row are created together.

- Generate at least 128 bits of randomness with a cryptographic RNG.
  - Evidence: independent verifier APPROVE. `randomHexId()` uses 16 bytes
    from `crypto.getRandomValues` (32-char lowercase hex). Create page
    calls `generateRoomId()`; minted peer labels are `user-` plus that
    hex. Focused tests 13/13; `Math.random` spy unused. Residual: join
    input still `{1,20}` so paste-join cannot take a 32-char create id;
    `collaboration.ts` still has a `Math.random` fallback if peerId is
    omitted. Since resolved: the `Math.random` fallback is gone, and the join input length is a UX limit, not a security control.
- Keep display/share codes separate from authorization capabilities.
  - Evidence: the room id is a locator only; `RoomDO.authorize` uses
    `room_members`. A second account posting the same id cannot become
    owner (409/403). No second capability token is minted.
- Make room, host session, and creator grant creation one transaction.
  - Evidence: missing-row `handleRoomPost` inserts `rooms` and
    `insertOwner` in one SQLite transaction.
- Reject duplicate/preclaimed creation without changing ownership.
  - Evidence: independent verifier APPROVE. Non-writer scene POST on an
    existing room → 409; HTTP outsiders 403; unique index
    `room_members_one_owner`. Mutant inverted `!canWriteBoard`; killed
    ownership-transfer test.
- Define secure client storage and rotation; never store long-lived bearer
  capabilities in `localStorage`.
  - Evidence: the application session is the `__Host-teacher-session` cookie
    (HttpOnly). `localStorage` holds only display name, color, an optional
    offline-board opt-in, and a cursor `peerId` locator that is not a grant.
    Rotation is `POST /auth/session` / rotate. Tab close runs `clearOnLeave`.

**Acceptance tests:** monkey-patching `Math.random` cannot affect security IDs;
knowing only a room ID yields no data; concurrent create attempts produce one
owner; injected transaction failure leaves no partial room or grant.

### SEC-007 — make deletion, expiry, and retention complete

**Evidence:** room deletion removes only the `rooms` row in
`src/lib/whiteboard/handlers/room.ts:164-172`; related tables in
`src/lib/whiteboard/roomSchema.ts:30-85` have no cascades. Access, requests,
presence, waiting, kicked rows, and live sockets survive. Expired grant cleanup
exists but is not scheduled.

- Make creator-only deletion atomic across every room-scoped table.
  - Evidence: independent verifier APPROVE. `deleteRoomScopedData` deletes
    all seven `applySchema` room tables in one SQLite transaction.
    `handleRoomDelete` is the only caller. Re-verified: `room.test.ts` 12,
    `roomDelete.workers.test.ts` 1, `npm test` 234, typecheck clean.
- Close all room sockets and call the appropriate Durable Object storage
  deletion mechanism after responding safely.
  - Evidence: successful DELETE closes sockets with 4404 (`deleteSockets`).
    Room-scoped SQLite rows are removed in `deleteRoomScopedData`.
    `storage.deleteAll` is **not** used: it would wipe `room_tombstones` and
    allow recreate-with-old-id. Tombstones are the durable deletion record.
- Tombstone IDs or prove old grants cannot authorize a recreated room.
  - Evidence: independent verifier APPROVE. Delete writes `room_tombstones`;
    recreate POST is 410; no owner grant restored. Mutant skip create
    tombstone check → 200 vs 410. `storage.deleteAll` is intentionally unused
    so tombstones survive.
- Set TTLs for rooms, requests, kicks, sessions, grants, and PII; purge with
  Durable Object alarms and record the retention policy.
  - Evidence: editor grants (`purgeExpiredGrants`); waiting/pending 24h and
    kicks 30d (`purgeExpiredRoomLifecycle`); idle rooms 90d then tombstone
    (`purgeExpiredRoomsAndTombstones`); tombstones 365d; sessions purged on
    IdentityDO fetch. Wired in `RoomDO.alarm`. PII on membership is removed
    with those rows. Independent verifier APPROVE for lifecycle/session
    slices.
- Add backup/restore for Durable Object SQLite state (rooms and identity)
  with a tested restore path and a recovery-point objective, so a bad deploy or
  storage incident cannot silently destroy classroom data. Verified: SQLite
  Durable Objects and their 30-day point-in-time-recovery API are included on
  the Workers Free plan (5 GB total account storage), so the restore path costs
  nothing extra — what this task adds is exercising it and recording the
  procedure.
  - Evidence: independent verifier APPROVE-AS-BLOCKED then recorded.
    `SECURITY_BACKUP_RESTORE.md` (RoomDO + IdentityDO, 30-day RPO, PITR).
    Residual: staging drill not executed in CI.

**Acceptance tests:** seed every table plus live sockets, delete, and assert all
data is gone and sockets close; recreation rejects every old token; expiry
physically purges records rather than only ignoring them.

### SEC-008 — treat tracked SQLite state as a potential data incident

**Original evidence (locally remediated):** `git ls-files .data` returned
`.data/whiteboard.db`, `.data/whiteboard.db-shm`, and
`.data/whiteboard.db-wal`; the schema can contain board content, names, emails,
and token hashes. The current index no longer tracks these files and `.data/`
is ignored. Public-history and external incident actions remain incomplete.

- Stop tracking all database/WAL/SHM files and ignore `.data/`.
  Evidence: `.gitignore` contains `.data/`; `git ls-files .data` returns
  nothing; `git check-ignore .data/whiteboard.db` succeeds. Phase 0 task
  independently verified (APPROVE).
- Replace them with synthetic fixtures or schema migrations only.
  Evidence: all tests use in-memory SQLite via `applySchema`; no real database
  files are checked in or used by the test suite.
- Determine whether the repository or artifacts were shared; if so, follow
  incident handling, rotate/revoke affected credentials, and purge history
  where appropriate.
  - Resolution (2026-09-13): Exposure confirmed and the public history purged
    (`SECURITY_INCIDENT_2026-08-17.md`). Production never used the purged data:
    it runs on Durable Object storage first deployed 2026-09-02, so no
    production credential or grant was affected. The remaining steps are the
    data owner's (owner action 6).
- Ignore `.wrangler/`, non-example environment files, and ad-hoc test output;
  add blocking secret/PII scanning.
  - Evidence: independent verifier APPROVE. Ad-hoc test output gitignored;
    CI `npm run security:scan` with no `|| true`. Mutants killed policy
    tests. Residual: `.cursor/` still unignored; incident/history bullets
    stay platform. `.cursor/` holds tracked editor rules and no secrets, and the CI secret scan covers it; the incident close-out is owner action 6.

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

- Prefer removing the legacy deployment if Cloudflare is authoritative.
  - Evidence: `signaling-server.mjs` deleted from repo root; `deploymentPolicy.test.ts`
    asserts `existsSync('signaling-server.mjs')` is false and DEPLOY.md states the
    legacy file was removed with Worker `/signaling` as the only path.
- Otherwise add parse guards, strict schemas/path/origin checks, `maxPayload`,
  connection/topic/rate caps, timeouts, and safe error handling to both servers.
  - N/A: legacy Node signaling removed (Cloudflare authoritative).
- Declare `ws` as a direct audited production dependency.
  - N/A: no Node signaling server remains.
- Destroy sockets for unsupported upgrade paths.
  - N/A: no Node signaling server remains.

**Acceptance tests:** malformed/noniterable/oversized messages do not terminate
the process; oversized frames close `1009`; wrong path/origin is rejected; live
health and authorized collaboration continue after hostile input.

### SEC-010 — close supply-chain and deployment gaps

**Original evidence (partly remediated):** full `npm audit` was not clean;
`.github/workflows/ci.yml` made audit non-blocking; and `Dockerfile:18,48`
shipped dev dependencies. The current audits are clean and the Docker path is
removed. GitHub environment protection rules are owner action 2; everything else
is closed below. CI Node and Action pins below are verified
locally. GitHub states a
[full commit SHA is the immutable form](https://docs.github.com/en/actions/reference/security/secure-use).

- Remediate the complete dependency graph and make high/critical audit
  failures blocking; exceptions require an owner and expiry.
  - Evidence: independent verifier APPROVE for this slice; `npm audit
    --audit-level=high` in `.github/workflows/ci.yml` has no
    `continue-on-error`; dependency-review uses `fail-on-severity: high`;
    8 deployment policy tests pass; no exception is required.
- Build a production-only dependency stage (`npm ci --omit=dev`) and scan
  the final image, not only the lockfile.
  - Evidence: CI job `production-deps-audit` runs `npm ci --omit=dev
    --ignore-scripts` and `npm audit --omit=dev --audit-level=high`. There is
    no container image; the Worker bundle is the runtime. Residual: no
    separate image-digest scanner because no image is shipped.
- Move CI/build/runtime to a maintained LTS Node line and pin exact image
  digests/versions.
  - Evidence: Node **22.23.2** on `ubuntu-24.04` for CI and deploy. Actions
    are SHA-pinned. Residual: GitHub-hosted runner images are not
    digest-pinned (platform). Accepted: GitHub-hosted runners. There is no production Docker image.
- Pin every GitHub Action to a verified full commit SHA.
  - Evidence: independent verifier APPROVE; every `uses:` in `ci.yml` and
    `deploy-cloudflare.yml` is a 40-character SHA whose GitHub tag object
    matches the version comment (`actions/checkout` v4.4.0,
    `actions/setup-node` v4.4.0, `actions/upload-artifact` v4.6.2,
    `actions/dependency-review-action` v4.9.0, `cloudflare/wrangler-action`
    v3.15.0). Policy tests reject mutable `@vN` tags.
- Scope `packages: write` to the publish job; protect production environments
  and minimize Cloudflare token permissions.
  - Evidence: CI and deploy workflows set `permissions: contents: read` only.
    There is no `packages: write`. Deploy uses `environment: prod`.
- Make both deployments depend on one required lint, typecheck, unit,
  Worker, audit, and relevant E2E/smoke gate.
  - Evidence: CI runs lint, typecheck, unit, workers (blocking), e2e, scan,
    Semgrep, audit, and production-omit-dev audit. Deploy runs typecheck,
    unit, and workers **without** `continue-on-error`. Residual: deploy does
    not `needs:` the CI workflow (GitHub cannot join them without
    `workflow_run`); e2e is still CI-only, not on deploy. Resolved: deploy now runs on `workflow_run` only after CI, e2e included, succeeds on `main`.
  - Amendment (2026-09-13): verification was consolidated in CI. The deploy
    workflow now runs no tests or scans — it builds the environment-specific
    export and deploys after CI succeeds on the same SHA
    (`deploymentPolicy.test.ts` forbids verification steps in the deploy
    workflow). Manual `workflow_dispatch` remains the one path without a CI
    gate; `environment: prod` is its operator control.
- Contain dependency install scripts: run CI installs with
  `--ignore-scripts` where the build allows it, and record an explicit
  allowlist for packages that genuinely need lifecycle scripts (for example
  `better-sqlite3`, dev-only), so a compromised transitive package cannot run
  arbitrary code on install.
  - Evidence: independent verifier APPROVE. CI and deploy both use
    `npm ci --ignore-scripts`, then `npm rebuild better-sqlite3` where native
    tests run. Mutant: drop `--ignore-scripts` on deploy; policy test failed;
    reverted.

**Acceptance tests:** both audit commands exit zero at `--audit-level=high`;
runtime image contains no Vite, Vitest, ESLint, Playwright, Wrangler, or
`concurrently`; image scan has no high/critical finding; CI rejects mutable
Actions and prevents deploy when any required check fails.

## P2 — privacy and defense in depth

### SEC-011 — reduce browser and WebRTC privacy exposure

**Evidence:** board sync no longer uses direct WebRTC (SEC-001), and calls run
through the LiveKit SFU, so participants never connect to each other and do not
learn each other's network addresses. Offline board cache and kick/waiting-leave clearing are verified locally
below; server revoke still has no client persistence hook.

- Default shared/classroom rooms to no offline board cache, or require
  explicit informed opt-in.
  - Evidence: independent verifier APPROVE. `saveBoardState` does not
    `setItem` unless `setOfflineBoardCacheEnabled(roomId, true)` wrote the
    opt-in flag; nothing in the UI calls that setter. Leftover keys without
    opt-in are purged on load. 9 persistence tests passed.
- Clear room, peer, and session material on leave, kick, revoke, and expiry.
  - Evidence: `clearOnLeave` on kick/reject/suspend, waiting leave, in-room
    leave, back-to-rooms, and tab `pagehide`/`beforeunload`. Server revoke
    closes sockets (4401) within the documented epoch bound.
- Document WebRTC IP/ICE privacy. If peer IP privacy is required, use an
  authoritative relay or managed TURN with relay-only ICE.
  - Evidence: independent verifier APPROVE. `SECURITY_WEBRTC_PRIVACY.md`.
    Residual: TURN/relay-only not configured in runtime. Moot since calls moved to the LiveKit SFU: participants never connect to each other.

**Acceptance tests:** leave/kick/revoke removes all room keys; a later local user
cannot recover board data; relay-only tests show host candidates are not shared.

### SEC-012 — add response, cache, framing, and indexing protections

**Evidence:** `src/worker.ts:51-59` returns asset responses directly and handlers
have no shared hardening. Sensitive JSON has no explicit `Cache-Control`.

- Add CSP (report-only first, then enforced), `frame-ancestors 'none'`,
  `object-src 'none'`, `base-uri`, `X-Content-Type-Options: nosniff`, strict
  referrer policy, and a minimal Permissions Policy.
  - Evidence: `withSecurityHeaders` applies `nosniff`, `Referrer-Policy:
    no-referrer`, `X-Frame-Options: DENY`, and a Permissions Policy that allows
    camera and microphone to this origin only (calls need them) and denies
    geolocation, payment, USB, MIDI, and serial, on every response; HSTS,
    `form-action 'self'`, COOP and CORP were added under SEC-A22/A23; HTML carries an enforced `Content-Security-Policy` (not
    Report-Only) with `frame-ancestors 'none'`, `object-src 'none'`, and
    `base-uri 'self'`. HTML assets are rewritten with a per-response script
    nonce (`withNonceHtmlSecurityHeaders`, `strict-dynamic`) so Next inline
    bootstraps can run without `'unsafe-inline'` on `script-src`.
- Restrict CSP `connect-src` to the actual HTTPS/WSS/TURN allowlist.
  - Evidence: `connectSrcForPageOrigin` sets `connect-src 'self'` plus the
    exact page origin and matching `ws:`/`wss:` host (no scheme-wide `wss:`).
    HTML responses from the Worker pass that directive. Two third-party hosts
    are named, each because the browser refuses the request otherwise: the
    configured LiveKit host over `https:` and `wss:`, and
    `https://libraries.excalidraw.com` for installing a shape library — read
    only, no websocket, nothing sent to it. Residual: LiveKit/TURN hosts are
    not in CSP until those secrets are configured; A/V degrades to 503 without
    them.
- Promote the CSP from report-only to enforced once violations are observed
  to be clean against a real Excalidraw session.
  - Evidence: independent verifier APPROVE. Enforced CSP header; Report-Only
    mutant killed the requestGuard test. Residual: no live CSP crawl;
    `connect-src` hostname allowlist is platform. The end-to-end suite runs the board, calls and every drawing tool under the enforced CSP, and the headers were verified live on 2026-09-13.
- Set `Cache-Control: no-store` and appropriate `Vary` on room, presence,
  grant, and request responses.
  - Evidence: every non-HTML response gets `Cache-Control: no-store` and
    `Vary: Cookie, Origin`, appended to any existing `Vary` rather than replacing
    it. Mutation-tested.
- Add `X-Robots-Tag: noindex` to room pages.
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

- Return only self status and the minimum approved-user fields by default;
  expose queue/request PII only to the creator.
  - Evidence: presence GET requires a granted role, so anonymous and pending
    callers get `403` and no user list; the waiting queue is attached to the
    payload only for the owner (`callerSeesWaitingQueue`); the requests list
    with emails is owner-only (`handleRequestsGet`); the active-user list
    carries display fields only (peer label, name, color, host flag) — no
    email or account id.
- Return generic 5xx bodies and log structured, redacted server details.
  - Evidence: independent verifier APPROVE. Handler catches use
    `internalErrorResponse`; clients get `{ error: "Internal server error" }`;
    logs are one JSON line with email/JWT/Bearer/`elements` redaction.
    Re-verified `npm test` 234/234, typecheck clean. Residual: JWT regex
    needs `eyJ`; nested board arrays can leak later ids in logs. Accepted: every JWT begins `eyJ`, and element ids are not personal data.
- Add security-event logging for auth failures, grant changes, revocation,
  rate limiting, and abnormal socket closure with retention/alert thresholds.
  - Evidence: independent verifier APPROVE for emit paths: `auth_failure`,
    kick/suspend `revocation`, approve `grant_change`, 429 `rate_limit`,
    1008/1009/4401 `socket_close`. Mutants skip kick log / skip rate emit /
    skip `logAuthEvent` in `logSocketClose` were killed. Residual: no
    retention/alert thresholds. Retention windows are now recorded in `SECURITY_DATA_PROTECTION.md`; alert rules are owner action 3.

**Acceptance tests:** anonymous/pending/viewer responses contain no board,
queue, email, token, or unnecessary identity data; induced SQL/storage errors
never reveal internals; logs contain no raw credentials or board content.

### SEC-014 — remove configuration and debug escape hatches

**Evidence:** signaling URL policy and debug globals are verified locally
below. y-webrtc P2P sync itself is unchanged (Phase 3).

- In production allow only same-origin or explicitly allowlisted `wss:`
  signaling endpoints; reject credentials, fragments, insecure schemes, and
  unexpected paths.
  - Evidence: independent verifier APPROVE. Configured
    `NEXT_PUBLIC_YWEBRTC_SIGNALING_URL` entries are sanitized; if all are
    unsafe the list is empty (no fallback). Production requires `wss:` and
    page host or `NEXT_PUBLIC_YWEBRTC_SIGNALING_ALLOWED_HOSTS`. 16
    `ywebrtcProvider` tests passed.
- Expose debug globals only behind an explicit development/E2E build flag.
  - Evidence: independent verifier APPROVE. `__whiteboardStore` /
    `__whiteboardCollab` attach only when `NODE_ENV !== 'production'` or
    `NEXT_PUBLIC_WHITEBOARD_DEBUG=1` or `NEXT_PUBLIC_E2E=1`. Residual:
    a production E2E build still exposes them. The production deploy build sets neither flag, so production carries no debug globals.
- Keep Cloudflare and any retained Node deployment configuration/security
  behavior identical or remove the unsupported path.
  - Evidence: the Node/Docker path was already removed (Phase 0 / SEC-009);
    Cloudflare Worker plus Durable Objects is the only supported deployment.

**Acceptance tests:** unsafe/misconfigured signaling URLs fail closed; production
builds contain no debug globals; parity tests exercise the same authorization,
headers, limits, and error behavior on every supported deployment.


### SEC-016 — account lifecycle, erasure, and data-subject rights

**Status:** implemented as below. The application stores identity PII (names, emails, provider subjects), board
content, and audit trails for teachers and students — a population that in most
jurisdictions carries data-subject rights (GDPR-style erasure/export) and
heightened duties for minors (FERPA/COPPA-like rules depending on market).
Retention TTLs (SEC-007) bound how long data lives; this section is about what
happens when a *person* asks for their data or its removal, or stops being a
user.

- Record the lawful-basis and data-inventory decision: what personal data is
  held, where (identity store, room tables, audit log, logs), for whom
  (teacher vs student), and who the controller is. This decides every item
  below and belongs to the product owner.
  - Evidence: independent verifier APPROVE. `SECURITY_DATA_PROTECTION.md`.
- Implement account deletion: a verified request removes or anonymizes the
  account row, its provider subjects, sessions, grants, presence/waiting rows,
  and display names embedded in other accounts' rooms, within a documented
  deadline.
  - Evidence: `DELETE /auth/account` (fresh session) → IdentityDO lists owned
    rooms, disables the account, drops subjects, pseudonymizes audit, returns
    `{ ok, roomIds }`. Worker POSTs `/room/erasure` per room: owners tombstone
    the room; members lose membership/presence/waiting. Independent verifier
    APPROVE for identity slice; RoomDO fan-out mutation-tested. Residual:
    Cloudflare/log vendor stores are not in-app (SEC-016 operational bullet). Now covered by the erasure windows and the R2 erasure receipt.
- Resolve the audit-trail tension explicitly: security audit records may be
  retained on legitimate-interest grounds, but then must be pseudonymized on
  erasure (keep the event, drop the direct identifiers) — decide and document,
  do not leave it implicit.
  - Evidence: independent verifier APPROVE. Pseudonymize `authorization_audit`;
    delete board content on erasure.
- Implement data export for an account's own data in a portable format.
  - Evidence: independent verifier APPROVE. `GET /auth/account/export`
    (Access + session). JSON is caller `accountId`, session hashes, Access
    subjects — no raw tokens, no other accounts. Mutant skip IdentityDO
    session 401 → 200 vs 401. Residual: RoomDO board/presence not in dump. By design (D-21).
- Decide and document the minors policy: what identity data students may
  enter at all (a display name may be enough — email is already optional),
  whether student emails should be refused rather than stored, and who consents
  on a student's behalf.
  - Evidence: independent verifier APPROVE. Minors heading mutation-tested.
- Propagate erasure to operational stores: logs, error reports, analytics,
  and backups (document the backup-erasure window rather than pretending
  backups can be rewritten instantly).
  - Resolution (2026-09-13): Erasure windows per store are recorded in
    `SECURITY_DATA_PROTECTION.md` (DO backups 30 days, Workers Logs 3-7 days,
    Access logs 24 hours-30 days, R2 immediate; no analytics or error-reporting
    vendor exists). Logs carry opaque ids with emails and tokens redacted. Each
    erasure writes a receipt to R2 so a backup restore cannot silently bring an
    account back (`ad8fa43`, `SECURITY_OPERATIONS.md` §5).

**Acceptance tests:** after erasure, no table, log fixture, or export contains
the account's identifiers; an export contains the account's own data and nobody
else's; a deleted account's sessions and live sockets are closed; audit rows
survive erasure only in pseudonymized form.

### SEC-017 — impersonation and classroom abuse resistance

**Status:** implemented as below. Display names are client-chosen free text
(`userName`), rendered to every participant in the presence panel, waiting
queue, and cursors. Authorization no longer trusts them (SEC-004), but humans
do: in a classroom, a student naming themselves after the teacher — or after
another student — is a working social-engineering attack on the *owner's
moderation decisions* (approve/kick target selection), and abusive names or
board content are a duty-of-care problem, not just a UX one.

- Visually distinguish the room owner in every participant list and cursor
  by server-verified role, never by display name, so a name collision cannot
  imitate the teacher's authority.
  Evidence: `PresencePanel` / `RemoteCursorOverlay` gate the Host badge on
  `user.isHost` (`grant_role === 'owner'`). Unit tests cover name collision.
  Mutation: `isHostUser = user.userName === 'Teacher'` killed
  `does not label a non-owner who uses the owner display name`. E2E:
  `presence list labels only the server-verified owner as Host`
  (`waiting-room.spec.ts`). Duplicate-name / churn items below remain open.
- Disambiguate duplicate display names in owner-facing moderation UI (queue
  and kick targets) with a stable server-side discriminator, so the owner
  always acts on the account they intend.
  - Evidence: independent verifier APPROVE. Owner list shows
    `whiteboard-user-disc-{peerId}` (last 4 hex of `accountId`) on name
    collisions. Viewer presence JSON omits `accountId`. Mutant always
    sending `accountId` killed `omits accountId from presence users for a
    non-owner GET`.
- Bound and normalize display names and room names: strip control and
  zero-width characters, collapse confusable whitespace, and enforce the
  existing length caps at the server (SEC-005 covers length; this adds
  normalization so "Teacher" and "Teacher\u200b" are not two identities).
  - Evidence: independent verifier APPROVE. `stripAsciiControls` +
    `normalizedNameBase` strip controls and U+200B/C/D/FEFF, collapse
    whitespace, cap 100. Mutant dropped U+200B; `Teacher\u200b` tests
    failed.
- Give the owner a low-friction abuse response: kick/ban already exists;
  add clearing another participant's strokes and, if boards can be shared
  beyond the live room, a report path with an accountable recipient.
  - Resolution (2026-09-13): Kick (ban), suspend, admit-as-viewer, clear board,
    delete any element, and now mute, stop camera and screen-share control on
    calls. Per-participant stroke clearing is not built (D-11). Boards are never
    shared beyond admitted participants; the accountable report path is in-app
    Contact support.
- Rate-limit join/name-change churn per account so cycling names cannot
  flood the queue or the presence panel (shares the SEC-005 quota mechanism).
  - Evidence: independent verifier APPROVE. `POST .../presence` 30/min per
    account (join/heartbeat/kick share the cap) → 429. Mutant skip `take()`
    killed the presence 429 test (200 vs 429).

**Acceptance tests:** a participant with the owner's exact display name is
never rendered with owner affordances; moderation actions resolve to the
intended `account_id` under duplicate names; control/zero-width characters are
gone from stored names; name-churn beyond the limit returns `429` and leaves
the queue stable.

### SEC-015 — keep paid membership and payments outside the trust boundary

**Status (2026-09-13):** built. Stripe-hosted Checkout and Customer Portal, a signature-verified
and attested webhook, an audited entitlement writer, grace and dispute holds, a daily
reconcile, and corporate seats are implemented and tested. Billing is not yet charging
in production: the price variables and Stripe secrets are unset (owner action 8).
Each contract item below carries its evidence.

**Why it came last:** payments add a new external trust boundary (the processor),
a new class of privileged state (entitlements), and a new category of PII
(billing identity). None of that was safe to add while room authorization,
revocation, and the real-time boundary were still open, because an entitlement is
only as trustworthy as the account it hangs off.

**Threats specific to this surface:** paying nothing and being entitled anyway
(client-declared plan, tampered price, forged or replayed webhook, checkout
redirect treated as proof of payment); entitlement outliving payment (cancel,
refund, chargeback, or failed renewal that never reaches live sessions); one
account's billing data reachable by another; and a classroom application
accidentally collecting payment or billing identity from minors.

- Never let card data touch this application. Use the processor's hosted
  checkout or hosted fields so the deployment stays in the lowest PCI DSS
  self-assessment scope, and record which SAQ level that is.
  - Resolution (2026-09-13): Stripe Checkout and Customer Portal only; no card
    field exists in the application, which stores only Stripe identifiers. PCI
    DSS scope: SAQ A (D-10).
- Treat entitlement as server-owned state keyed by local `account_id`, in the
  identity store next to `accounts`. Never accept plan, tier, seat count, price,
  amount, currency, coupon, or trial eligibility from the client; the server
  selects the price identifier.
  - Resolution (2026-09-13): Entitlements live in IdentityDO keyed by
    `(account_id, source)`; checkout resolves the price server-side and ignores
    any client price, amount or URL (`worker.billing.workers.test.ts` › checkout
    resolves the price server-side).
- Never grant entitlement from a checkout success redirect, a client callback,
  or a `session_id` in a URL. Grant only from server-side verification: a
  signature-verified webhook or an authoritative read back from the processor.
  - Resolution (2026-09-13): Entitlement changes only through the webhook apply
    (signature-verified, attested) or the reconcile reading Stripe; the success
    URL grants nothing (`billing.workers.test.ts`).
- Verify every webhook: exact signature over the raw body, freshness window,
  and per-event-ID deduplication so a replayed or retried delivery cannot apply
  twice. Handle out-of-order delivery by reconciling against processor state
  rather than trusting event order.
  - Resolution (2026-09-13): HMAC over the raw body via `crypto.subtle.verify`,
    300 s tolerance, event-id dedupe, ordering watermark for out-of-order
    delivery, body read with a 1 MiB cap, 120/min per IP (`b24ff41`), served on
    the marketing host where Stripe can reach it (`49ee509`).
- Make entitlement changes idempotent and audited. Reuse the existing
  `authorization_audit` pattern: actor, reason, before/after, written in the same
  transaction as the change.
  - Resolution (2026-09-13): One entitlement writer; exactly one
    `entitlement_audit` row per changed subject per cause, in the same
    transaction (`entitlementWriter` tests).
- Propagate downgrade, cancellation, non-payment, refund, and chargeback by
  boundary-time re-evaluation: the effective-plan resolver runs with the
  request's `now` at every boundary, so an expired grace period stops
  entitling with no background job and no client asking. Entitlement changes
  never bump the authorization epoch and never close an in-progress lesson;
  account-level revocation keeps the existing epoch mechanism and its
  documented socket bound.
  - Resolution (2026-09-13): `resolveEffectivePlan` runs with the request time
    at every boundary; grace expiry needs no job; disputes hold entitlement;
    entitlement writes never bump the authorization epoch
    (`effectivePlan.test.ts`, `billing.workers.test.ts`).
- Enforce plan limits (rooms, seats, participants, retention) server-side at
  the same boundary as the authorization matrix, not in the UI.
  - Resolution (2026-09-13): Owned rooms in IdentityDO from the plan catalog;
    participants at RoomDO admission from the owner's plan, proved by room
    ownership (`78998cc`); seats in the company routes.
- Scope billing routes to the owning account only. Reading or changing another
  account's plan, invoices, or payment method must fail closed, and admin
  overrides must be audited.
  - Resolution (2026-09-13): Checkout and portal use the caller's session
    entitlement and ignore client customer ids; the plan route proves the
    account (`78998cc`); company routes read membership from the session;
    operator actions are allowlisted and audited.
- Bill teachers only. Students must never reach a payment flow or have billing
  identity stored, and the design must state how it keeps minors out of that
  path.
  - Resolution (2026-09-13): Students join through the guest host, where billing
    routes answer 404, and guest accounts cannot hold entitlements; the privacy
    page states that students never pay.
- Store only processor identifiers (customer, subscription, invoice) plus
  what is legally required. No PAN, no full billing address unless tax rules
  demand it. Document the conflict between invoice retention duties and erasure
  requests, and which wins.
  - Resolution (2026-09-13): Only Stripe identifiers and plan state are stored;
    the retention-versus-erasure decision is recorded in
    `SECURITY_DATA_PROTECTION.md` (statutory retention wins for billing
    identifiers only, D-19).
- Rate-limit and bound abuse of free tiers: one trial per account, coupon
  redemption limits, and creation limits that survive account churn.
  - Resolution (2026-09-13): No trials are offered and promotion codes are never
    taken from the client (D-9). Referral codes are validated server-side; tutor
    accounts are one per Access identity and capped at 50.
- Meter the Free tier by distinct students, not rooms. A room count alone
  is trivially gamed: delete-and-recreate (churn) or wiping one board between
  students (reuse) serves unlimited students inside a 2-room limit. The
  enforceable unit is the thing students cannot fake here — their verified
  account:
  - Count distinct student `account_id`s *approved into* any of a tutor's
    rooms over a rolling 30-day window, stored per tutor account in the
    identity store, so deleting rooms or boards never resets it (pairs with
    the SEC-007 tombstone work).
  - Enforce at the admission decision (waiting-room approve / request grant),
    server-side, with the distinct "over plan limit" status from Phase 7 —
    admitting a returning student stays free, admitting a third *new* one
    prompts the upgrade.
  - Count only owner approvals, never requests: otherwise strangers knocking
    at a room would burn the tutor's quota (a denial-of-service on the meter).
  - Do not meter or restrict the student side in any way, and never lock a
    tutor out of rooms with already-admitted students — the cap gates *new*
    admissions only, so no lesson in progress ever breaks.
  - Residual, accepted: several children sharing one student account (bounded
    by the catalog Free per-room cap, `FREE_MAX_USERS = 2`), and tutors making
    multiple tutor accounts (bounded by one-Access-identity-per-account
    friction, the enforced `TUTOR_ACCOUNT_CAP`, and the per-identity trial
    limit above; monitored, not blocked, because stronger identity proofing is
    disproportionate for this product).
  - Product note: the meter aligns the paid tier with the product's own value
    rather than fighting the user — churn destroys the "board remembers"
    retention that is the reason to use the product at all, so honest heavy
    use naturally lands on Tutor Pro rather than on workarounds.
  - Resolution (2026-09-13): Not metered by distinct student (D-8): students are
    room-scoped guest accounts, so such a meter would count nothing real. The
    Free tier is bounded by one owned room and two participants.
- Keep processor secrets (API key, webhook signing secret) in Worker secrets,
  never in code, client bundles, logs, or `wrangler.toml`; document rotation.
  - Resolution (2026-09-13): Worker secrets only; the CI secret scan blocks
    committed material; rotation in `SECRETS_ROTATION.md` §3.
- Add a reconciliation job that compares local entitlement against processor
  state and alerts on drift, so a missed webhook is detected rather than silently
  granting or denying access.
  - Resolution (2026-09-13): Daily reconcile implemented and tested, and now
    actually scheduled in production (`70485df`, `[env.prod.triggers]`).

**Acceptance tests:** a forged, replayed, stale, or wrong-signature webhook
changes nothing; a client-declared plan, tampered price, or self-granted
entitlement is ignored; a checkout redirect alone entitles nobody; cancel,
refund, chargeback, and failed renewal past grace remove entitlement from HTTP
and from **new** room activity at the next boundary, and from already-open
lessons at the session's next validity check; account-level revocation still
closes sockets within the 30 s alarm bound. A chargeback suspends billing per
D12. Tested bound: an open socket with no further HTTP activity is closed by
the RoomDO alarm at the session's idle expiry, because the alarm reads
`idle_expires_at` and never refreshes it; only HTTP session validation
refreshes it, so the 12 h absolute expiry is the ceiling only while HTTP
activity keeps refreshing idle. Accepted residual: a lapsed or disputed
account keeps its already-admitted participants in an open lesson until that
check. One account cannot read or modify another's billing state; plan limits
are enforced server-side against a raw client; duplicate webhook delivery
applies once; and induced processor errors or timeouts never leave
entitlement and payment in disagreement.

#### Membership structure (owner-approved 2026-09-11)

A concrete default so Phase 7 starts from a reviewable model instead of a blank
page. The product owner can amend any number here; the *shape* (server-owned
catalog, account-keyed entitlement, grace-then-downgrade, students never
billable) is the part SEC-015 depends on.

**Target market (owner decision, 2026-08-18; amended 2026-09-11).** Private
tutors doing 1-to-1 or small-group tuition (typically 1-3 students, rarely up
to a small class), with few sessions active at once. This is *not* a school
product: no student seats, no rosters, no LMS/SSO, no district billing, and no
administrative control over other tutors' rooms or content. A *corporate
account* is permitted only as a billing group of tutor accounts: a company may
hold tutor seats, assign/revoke them, and see its own consolidated invoice, but
it never sees or controls a member's boards, and students are never billable.
That decision resolves the "who pays" question — the tutor pays — and
permanently deprives the School tier of a reason to exist here. It also means
the Cloudflare Access free tier (50 users) is the authentication budget for
tutors: students join through the guest host, which has no Access application,
so the app caps active tutor accounts at 50 (`TUTOR_ACCOUNT_CAP`; see the
implementation spec §3.9).

**Who is billable.** Only tutors — the accounts that create and own rooms.
Students authenticate and join rooms but are never billable, never see payment
UI, and never have billing identity stored (SEC-016 minors policy). A room's
capabilities are decided by its *owner's* plan, so a student's experience
changes with the tutor's tier without the student ever touching billing.
One-to-one tuition with minors also sharpens the safeguarding duties: the
SEC-016 minors policy and the SEC-017 abuse items apply with more force in a
private 1:1 setting, not less.

**Tiers (proposed).** Sized for tutoring: a room per student (or per small
group), few concurrent sessions, value concentrated in retention, A/V, and —
later — recording and the content library, not in seat counts. Distinct-student
metering (see the Free-tier metering item below) remains a separate
workstream; until it ships, the Free tier is enforced by the catalog's
owned-room and per-room participant caps.

| | Free | Tutor Pro |
| --- | --- | --- |
| Active owned rooms | 1 | 20 |
| Participants per room | 2 (tutor + 1 student) | 10 (small group classes) |
| Room retention after last activity | 90 days | 90 days |
| Distinct students admitted (rolling 30 days) | metering deferred — separate workstream | metering deferred — separate workstream |
| Voice & video calling | yes | yes |
| Billing | — | monthly/annual, one price each |

No School tier. Student seats, rosters, SSO/LMS, district billing, and admin
consoles remain out of scope by owner decision; a corporate account is
permitted only as a billing group of tutor seats (see Target market above),
which also confirms the low priority of the scheduling/SSO/LMS block in
`MISSING_FEATURES.md`.

**Plan catalog lives in code, not the database.** A static, versioned map of
`plan_id -> limits` (max rooms, max participants, retention days) deployed with
the Worker. The database stores only which plan an account has. This keeps the
price/limit definition out of reach of SQL tampering and makes limit changes an
auditable code review.

**Entitlement data model (identity store, beside `accounts`).**

- `entitlements`: PK `(account_id, source)` with `source` in
  (`personal`, `company`); `plan_id`, `status` (`free` / `trialing` /
  `active` / `past_due` / `canceled`), `grace_until`, `collection_paused`,
  `company_id`, `current_period_end`, `processor_customer_id`,
  `processor_subscription_id`, `updated_at`. Absence of a row means Free.
  Company rows are materialized only by the entitlement writer after the
  company's first paid invoice. Entitlement writes never bump the account's
  authorization epoch: the effective-plan resolver re-evaluates at every
  request boundary, so a downgrade takes effect without touching sessions or
  live lessons (account revocation keeps the existing epoch mechanism). Every
  write goes through one writer and lands exactly one `entitlement_audit` row
  per changed subject per cause in the same transaction.
- `billing_events`: `event_id` (PK — the processor's event id, which is the
  dedupe key), `type`, `payload_hash`, `processed_at`. Webhook handling
  inserts-or-ignores here first; a duplicate insert means a replay and is
  dropped before any entitlement read.

**Entitlement state machine.**

`free -> trialing -> active` on server-verified checkout;
`active -> past_due` on `invoice.payment_failed` (grace: 7 days from the first
failure's event time, full access, dunning emails are the processor's job);
`past_due -> active` on recovery, or enforcement stops at `grace_until` when
grace lapses; `active|past_due -> canceled` on subscription deletion; a
chargeback opens a dispute hold that suspends collection and entitlement (D12),
resumes when no hold remains, and cancels on `lost`. Every transition is
webhook-driven or reconciliation-driven — never client-driven.

**Downgrade semantics — never destroy data on a billing event.** Dropping to
Free with more rooms than the Free quota archives the excess (owner-readable,
not writable, not joinable) rather than deleting it; retention deletion follows
the SEC-007 TTL machinery on the *Free* schedule from the downgrade timestamp,
so a lapsed card never silently erases a class's boards. Over-quota actions
return the distinct "over plan limit" status from Phase 7, which must not leak
whether other rooms exist.

**Processor (owner decision): Stripe, hosted surfaces only.** Stripe Checkout,
Stripe Customer Portal, and Stripe-issued invoices for approved corporate
plans — the application renders links and never a card field, keeping SAQ-A
scope (SEC-015). Webhooks consumed: `checkout.session.completed`,
`customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`,
`charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`;
ordering, dedupe, and the authoritative re-fetch are defined in the
implementation spec §7.1. A daily reconciliation job re-reads processor state
per stored subscription id and alerts on drift.

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
every authorization change appears exactly once in `authorization_audit`, and
every entitlement transition appears exactly once per cause in
`entitlement_audit` (with the processor event id where one exists).


## Decisions and accepted risks

Each decision is dated and names what would reopen it.

| ID | Decision | Why | Revisit when |
| --- | --- | --- | --- |
| D-1 | Access accepts **Google only**; no Facebook | Tutors sign in with Google; Facebook Login adds a consumer social identity nobody has asked for, and under a policy that admits any authenticated identity every added provider is another way to a tutor account | A tutor needs another provider |
| D-2 | The Access policy admits any authenticated identity; the product caps tutor accounts at 50 (`TUTOR_ACCOUNT_CAP`) | 50 is the Access free-plan seat count; students use the guest hostname, which has no Access and uses no seats. Accepted risk: the cap is the only barrier to creating a tutor account | The cap is raised or the plan changes |
| D-3 | No staging environment | Production invariants are held by Terraform, a blocking live `access:check` in CI, and probes; the billing staging run stays blocked until staging exists (owner action 8) | Before charging, or before a risky platform change |
| D-4 | Room ids are not signed | Signed ids would break every existing room link; the unauthenticated guest path checks the room registry instead, and a flood still costs the Worker invocation the edge and per-IP limits bound | A new unauthenticated room path is added |
| D-5 | No custom WAF rules; the one free rate-limit rule is on guest PIN submission | The Worker's host and route allowlist already refuses everything else; the edge rule is spent on the only unauthenticated write | Worker request volume approaches the plan limit |
| D-6 | HSTS `max-age=31536000; includeSubDomains`, **no preload** | Preload commits the whole `sen-tutor.co.uk` zone, including services outside this application, permanently; that is the zone owner's call | The zone owner decides to preload |
| D-7 | CSP `require-trusted-types-for 'script'` **not enforced** | The Next.js runtime, the Excalidraw fork and LiveKit write to DOM sinks that have not been audited as Trusted-Types clean, and enforcing blind would break the board. The nonce and `strict-dynamic` CSP, `base-uri` and `form-action`, and a single `dangerouslySetInnerHTML` of a build-time constant cover the injection classes | The fork is audited for DOM sinks |
| D-8 | The Free tier is not metered by distinct student | Students are room-scoped guest accounts with no durable identity; the tier is bounded by one owned room and two participants. The owner deferred metering on 2026-09-11 | Students gain durable accounts |
| D-9 | No trials; no client-supplied promotion codes | Removes trial-cycling and coupon-stacking entirely rather than limiting them | A trial or coupon campaign is planned |
| D-10 | PCI DSS scope is **SAQ A** | Only Stripe-hosted Checkout and Customer Portal pages; no card field, script-injected payment form, or card data anywhere in the application | A payment field is added to the application |
| D-11 | No per-participant stroke clearing | Board elements carry no server-verified author, and stamping authorship into the live sync path is a large change to the most critical code; kick, suspend, admit-as-viewer, clear board and deleting any element cover the abuse cases so far | Abuse reports show owners need it |
| D-12 | Third-party embeds are **off** | The scene guard deletes embed elements and the Web Embed tool is hidden (`ce41c95`); turning them on follows `SECURITY_FEATURE_REQUIREMENTS.md` | Embeds are requested |
| D-13 | Follow-me is a UX affordance, not a security control | It moves viewports only; frames are accepted only from the owner and change no authorization | Never treat it as a control |
| D-14 | In-Worker rate limiters are per isolate | They bound a single client's abuse cheaply; distributed floods are the edge rule's job; counts that must be exact (billing, referrals) use Durable Object counters | A limit must hold globally |
| D-15 | RoomDO's injectable LiveKit hooks stay public instance properties | Only this Worker's own code holds a Durable Object stub; they are not reachable from outside and let the Worker tests exercise real routes | The Durable Object is exposed over RPC |
| D-16 | The Stripe webhook is served on the marketing hostname | The teacher hostname is entirely behind Access with no Bypass policy, so Stripe could not reach it there; the request is authenticated by its signature (`49ee509`) | Access is removed from the teacher host |
| D-17 | A student's screen-share permission lasts one share within one call | The owner allows it per participant; stopping the share or rejoining the call takes it back (`3204e6f`, `0d0fdc5`) | A standing permission is requested |
| D-18 | Idle and distraction alerts are not built; if built, aggregate and ephemeral | No per-student attention history is stored | The feature is requested |
| D-19 | Statutory invoice retention wins over erasure for billing identifiers only | UK VAT and company records must be kept six years; the rows stay attached to a disabled account with no sign-in subjects | The retention law or processor changes |
| D-20 | Presence heartbeat and leave are bound per account, not per session | Two sessions of one account are the same principal: neither can do anything the other could not. Moderation acts on accounts, which is the boundary that matters | Accounts become shared between people |
| D-21 | Account export covers the account's identity, session, subject and billing data; board content is exported per room from the board | Board content belongs to the room and may be co-authored by students; the room owner exports it with the board's own export. Presence is ephemeral and not retained | A data-portability request needs boards in the account export |

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

## Post-billing security sweep — 2026-09-12

Scope: the current working tree after the Phase 7 billing slices
(`546dcdc`, `64fd1b8`, `1bc6006`, `15fe06e`). Type: static source review plus
a dependency audit; no staging deployment or live Stripe tenant was exercised.
Identifiers continue the `SEC-A` series defined in
`SECURITY_AUDIT_2026-09-10.md`, which ends at SEC-A16.

This sweep found **no unauthenticated authorization bypass, no SQL injection,
no hardcoded production secret, and no reachable XSS**. Every issue below is
either on the billing surface added after the 2026-09-10 audit, or a response
header that was never in scope for SEC-012.

| ID | Severity | Finding |
| --- | --- | --- |
| SEC-A17 | High | `STRIPE_API_BASE` is an unvalidated destination for the Stripe secret key, and a `workflow_dispatch` input feeds it |
| SEC-A18 | Medium | `billing_events.payload_hash` fingerprints the internal DO body, not Stripe's signed payload |
| SEC-A19 | Medium | `/billing/events/apply` trusts its caller completely; no signature or principal assertion inside the Durable Object |
| SEC-A20 | Medium | `/accounts/plan` authorizes on nothing and will disclose billing state for any `accountId` |
| SEC-A21 | Medium | Webhook body is fully buffered before the 1 MiB cap is enforced, on the only unauthenticated POST route |
| SEC-A22 | Medium | No `Strict-Transport-Security` on any of the three hostnames |
| SEC-A23 | Medium | CSP has no `form-action`; no `Cross-Origin-Opener-Policy` or `Cross-Origin-Resource-Policy` |
| SEC-A24 | Low | Stripe object ids are interpolated into API paths with no grammar check |
| SEC-A25 | Low | Two sources of truth for plan limits: `FREE_MAX_ROOMS` vs `PLAN_CATALOG[...].limits.maxOwnedRooms` |
| SEC-A26 | Low | `resolveEffectivePlan` indexes the catalog with an unvalidated `plan_id` from SQLite |
| SEC-A27 | Low | Checkout/portal builders accept unvalidated `successUrl`/`cancelUrl`/`returnUrl` — close before wiring the routes |
| SEC-A28 | Info | Secret-bearing `workflow_dispatch` workflows have no `environment:` reviewer gate |

**All twelve are resolved** (2026-09-13); each finding below carries its
resolution and the commit or test that shows it.

Original priority fix order: SEC-A17 (it puts a payment credential one dispatch away
from an attacker-named host), then SEC-A19 and SEC-A27 (both close a hole
before the route that opens it is written, which is the cheapest they will ever
be), then SEC-A18/A20/A21, then the header work in SEC-A22/A23.

### SEC-A17 — High — `STRIPE_API_BASE` is an unvalidated destination for the Stripe secret key

**Component:** `src/lib/billing/stripeConfig.ts`, `stripeRequest.ts`,
`stripeClient.ts`, `.github/workflows/billing-staging.yml`
**Status:** Verified by code trace; exploit path is latent, not live (see below)
**CWE:** CWE-15 (external control of system setting), CWE-522 (insufficiently
protected credentials), CWE-918 (SSRF)

`readBillingEnv` takes the Stripe API base straight from the environment with
no allowlist and no scheme/host check:

```ts
apiBaseUrl: env.STRIPE_API_BASE ?? DEFAULT_API_BASE_URL,   // stripeConfig.ts:30
```

Every request builder then attaches the live secret key to a request aimed at
that base — `stripeRequest.ts:24` and again at `stripeClient.ts:54`:

```ts
Authorization: `Bearer ${secretKey}`,
```

So whoever controls `STRIPE_API_BASE` controls where `STRIPE_SECRET_KEY` is
sent. The variable is not declared in `wrangler.toml [vars]`, so a production
Worker resolves the default — but nothing in the code enforces that, and
`.github/workflows/billing-staging.yml` wires the value to a free-text
`workflow_dispatch` input (lines 26-32) and hands it to the runner alongside
`secrets.STRIPE_SECRET_KEY` (lines 74-80), with `permissions: contents: read`
and **no `environment:` reviewer gate**. Anyone who can dispatch a workflow on
this repository can therefore name the host.

**Why this is not yet live:** `scripts/run-billing-staging.mjs` contains no
`fetch` at all and always terminates with `failBlocked(...)` or `exit(1)`
(line 113), so the key is materialised into the job environment but never
transmitted. The script's own header states the intent to "re-point this script
at it" once staging exists — the exfiltration path opens on that commit.

- Allowlist the base in `readBillingEnv`: accept `https://api.stripe.com`,
  and any other value only when an explicit non-production marker is set.
  Reject anything else by returning the default rather than throwing, so a
  misconfigured deployment talks to Stripe rather than failing open to a
  stranger.
  - Resolution (2026-09-13): `readBillingEnv` returns the default base and
    `apiBaseAllowed: false` for any other value unless a test key is paired with
    it (`stripeConfig.test.ts`).
- Refuse to pair a `sk_live_` key with a non-production base, and refuse a
  `sk_test_` key with the production base. Both are one string comparison and
  they make a mis-scoped secret loud instead of silent.
  - Resolution (2026-09-13): A non-default base is honoured only with an
    `sk_test_` key (`stripeConfig.test.ts`); the staging runner refuses anything
    but a test key bound for `https://api.stripe.com` (`09e3d61`).
- Put `billing-staging.yml` behind a protected GitHub `environment:` with
  required reviewers, so dispatching it with an attacker-named base needs a
  second person.
  - Resolution (2026-09-13): The job declares `environment: staging`; the
    required reviewer and branch rule on that environment are owner action 2.
- Add the base-URL assertion to `run-billing-staging.mjs` before the first
  `fetch` is ever written into it.
  - Resolution (2026-09-13): Added before any request exists:
    `stagingStripeTargetError` (`09e3d61`,
    `scripts/lib/stripeStagingGuard.test.ts`).

**Acceptance tests:** `readBillingEnv` returns the default for
`http://evil.example`, for `https://api.stripe.com.evil.example`, and for a
non-HTTPS scheme; a `sk_live_` key with a non-production base is refused; the
workflow cannot run without environment approval.

### SEC-A18 — Medium — `billing_events.payload_hash` does not fingerprint Stripe's signed payload

**Component:** `src/worker.ts`, `src/do/IdentityDO.ts`, `src/lib/billing/stripeSignature.ts`
**Status:** Verified by code trace
**CWE:** CWE-345 (insufficient verification of data authenticity)

`verifyStripeSignature` computes exactly the right value — the SHA-256 of the
raw body Stripe signed — and returns it (`stripeSignature.ts:109`). The Worker
then discards it: `handleStripeWebhook` uses only `verification.valid`
(`worker.ts:1218-1231`), and `webhookApplyBody` (`worker.ts:972-986`) does not
carry a hash into the Durable Object. `IdentityDO` recomputes one over its own
re-serialised `{event, objects}` body instead:

```ts
const payloadHash = await sha256Hex(parsed.raw);   // IdentityDO.ts:876
```

`verification.payloadHash` has no consumer anywhere in the tree. The column
therefore fingerprints a body this application constructed, which proves
nothing an auditor could not already read off the row — the one thing it was
meant to support, re-verifying a stored event against Stripe's signature after
the fact, is impossible.

- Thread `verification.payloadHash` through `webhookApplyBody` and into
  `BillingApplyInput.payloadHash`.
  - Resolution (2026-09-13): Done; the stored `payload_hash` is the SHA-256 of
    the raw signed body (`worker.billing.workers.test.ts` › stores the SHA-256
    of the raw signed body).
- Keep the internal-body hash if it is wanted for transport integrity, but
  store it in a separate column with a name that says so.
  - Resolution (2026-09-13): The event apply no longer hashes its internal body
    at all; the operation and settle routes keep a hash of their own request
    body for replay detection, stored as `request_hash`, a name that says what
    it is.

**Acceptance tests:** a captured webhook body plus the stored `payload_hash`
re-verifies against the recorded `Stripe-Signature`; changing one byte of the
`objects` the Worker derived does not change `payload_hash`.

### SEC-A19 — Medium — `/billing/events/apply` trusts its caller completely

**Component:** `src/do/IdentityDO.ts:868-895`
**Status:** Verified by code trace; not currently reachable with a forged body
**CWE:** CWE-306 (missing authentication for critical function), CWE-602
(client-side enforcement of server-side security)

The apply route performs no principal check, no signature check, and no
assertion that a signature was ever verified. It validates the body's *shape*
(`isBillingApplyBody`, line 376) and then mutates entitlements, payments,
dispute holds, company first-paid timestamps and collection desires inside one
transaction. Signature verification lives entirely in the Worker
(`worker.ts:1218`), one layer above.

This is safe today only because the Durable Object binding is private and
`handleStripeWebhook` is the sole caller. It is exactly the pattern the
authorization contract at the top of this document rules out — "the Durable
Object applies the matrix below to every operation" — and the failure mode is
forged paid entitlements, not a leak. The webhook path already has one
unauthenticated entry point (SEC-A21); a routing mistake there or in any future
billing route is the whole exploit.

- Pass the verified payload hash and an explicit `signatureVerified: true`
  from the Worker, and reject an apply that lacks them.
  - Resolution (2026-09-13): Done; an apply without `signatureVerified: true` or
    a well-formed hash writes nothing (`billing.workers.test.ts` ›
    verified-caller attestation).
- Re-assert `livemode` inside the Durable Object rather than relying on the
  Worker's check, so the "test events cannot mutate entitlements" property
  holds at the writer, not just at the edge.
  - Resolution (2026-09-13): Done; a livemode mismatch is recorded as ignored
    inside the writer (`billing.workers.test.ts` › records livemode mismatch as
    ignored).

**Acceptance tests:** a well-formed apply body with no verification marker is
rejected with no row written; a body whose hash does not match its event is
rejected; the existing replay/idempotency tests still pass.

### SEC-A20 — Medium — `/accounts/plan` authorizes on nothing

**Component:** `src/do/IdentityDO.ts:628-639`
**Status:** Verified by code trace; no reachable IDOR today
**CWE:** CWE-639 (authorization bypass through user-controlled key), CWE-359
(exposure of private information)

The route validates only the *length* of a caller-supplied `accountId`:

```ts
if (accountId === null || accountId.length < 1 || accountId.length > 128) {
  return Response.json({ error: 'Invalid accountId' }, { status: 400 });
}
```

and returns the full effective plan — `planId`, `status`, `source`,
`companyId`, `limits`. Its sibling routes in the same `fetch` all call
`parseSessionCookie` first; this one calls nothing. It is safe only because
both callers pass a server-derived id: `session.accountId` (`worker.ts:1776`)
and the room's owner row (`RoomDO.ts:1592`). One future route that forwards a
client-supplied `accountId` — the obvious shape of an admin or support view —
turns this into cross-account billing disclosure, including company membership.

- Require a session cookie and serve only the caller's own account, or
  require an explicit internal marker and keep the accountId server-derived.
  - Resolution (2026-09-13): Both, one per caller: a session proves only its own
    account, and room admission proves ownership of the room it names
    (`78998cc`).
- Add a negative test asserting the route refuses an `accountId` that does
  not belong to the caller.
  - Resolution (2026-09-13): Added: bare id 403, cross-account session 403,
    unowned room 403, no proof 401; three targeted mutants killed
    (`identityDO.workers.test.ts` › SEC-A20).

**Acceptance tests:** a request for another account's id returns 403 with no
plan body; the two existing callers are unaffected.

### SEC-A21 — Medium — Webhook body is buffered in full before the size cap applies

**Component:** `src/worker.ts:1203-1211`, `src/lib/worker/requestGuard.ts:218`
**Status:** Verified by code trace
**CWE:** CWE-770 (allocation without limits), CWE-400 (uncontrolled resource
consumption)

```ts
const declaredLength = request.headers.get('content-length');
if (declaredLength !== null && Number(declaredLength) > BILLING_WEBHOOK_MAX_BODY_BYTES) { ... }
const rawBody = await request.text();
if (new TextEncoder().encode(rawBody).byteLength > BILLING_WEBHOOK_MAX_BODY_BYTES) { ... }
```

The declared-length check is skipped when the header is absent and evaluates
`NaN > cap` (false) when it is unparseable. A chunked request therefore reaches
`request.text()` and is buffered whole before the 1 MiB cap is measured.

This is the one route on the teacher host that runs before Access and is
exempted from the origin guard (`requestGuard.ts:218` returns `false` for
`BILLING_WEBHOOK_PATH`) — correctly, since Stripe carries neither an Access JWT
nor an `Origin`. It is also not rate-limited. So an unauthenticated caller can
drive Worker memory and CPU with oversized, chunked, signature-failing bodies.
The cost per request is bounded (one HMAC over the body, no Durable Object
round trip until the signature verifies), which is why this is Medium and not
High.

- Reject a missing or unparseable `Content-Length` on this route, or read
  the body through a counting stream that aborts at `BILLING_WEBHOOK_MAX_BODY_BYTES`.
  - Resolution (2026-09-13): Both: an unparseable length is 400, and the body is
    read through a counting stream cancelled at 1 MiB; an 8 MiB chunked stream
    is pulled under 2 MiB (`b24ff41`).
- Add a per-IP rate limit on `/api/billing/webhook` sized above Stripe's
  real retry behaviour.
  - Resolution (2026-09-13): 120 deliveries a minute per client IP; Stripe
    retries a 429, so nothing is lost (`b24ff41`).

**Acceptance tests:** a chunked 8 MiB body is rejected without being buffered;
a request with no `Content-Length` is rejected; genuine Stripe deliveries and
their retries are unaffected.

### SEC-A22 — Medium — No `Strict-Transport-Security` on any hostname

**Component:** `src/lib/worker/requestGuard.ts:495-535` (`withSecurityHeaders`)
**Status:** Verified — the string appears nowhere in the tree
**CWE:** CWE-319 (cleartext transmission of sensitive information)

`withSecurityHeaders` sets `nosniff`, `Referrer-Policy`, `X-Frame-Options`,
`Permissions-Policy`, `Cache-Control`, and a full CSP on HTML — but no HSTS.
Session cookies are `Secure` (`sessionStore.ts:766,815`), so they are not sent
over a stripped connection, and Cloudflare terminates TLS. What remains exposed
is the *first* navigation to `app-playground.sen-tutor.co.uk` and every
navigation to the marketing host, which is where the sign-in link lives.

- Set `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  on every response from all three hostnames.
  - Resolution (2026-09-13): Set on every response from all three hostnames;
    verified live on the marketing and guest hosts.
- Decide on `preload` explicitly: `includeSubDomains` plus preload commits
  the whole `sen-tutor.co.uk` zone, which is a decision for the zone owner, not
  this Worker. Record the decision either way.
  - Resolution (2026-09-13): Decided: no preload (D-6).

**Acceptance tests:** the header is asserted on HTML, on API 2xx and 4xx, and
on all three host kinds.

### SEC-A23 — Medium — CSP has no `form-action`; no COOP or CORP

**Component:** `src/lib/worker/requestGuard.ts:513-533`
**Status:** Verified by reading the directive list
**CWE:** CWE-1021 (improper restriction of rendered UI layers), CWE-693
(protection mechanism failure)

The policy covers `default-src`, `frame-ancestors`, `object-src`, `base-uri`,
`connect-src`, `img-src`, `font-src`, `style-src` and a nonce'd `script-src`
with `strict-dynamic`. `form-action` is absent, so injected markup can still
POST the DOM to an external origin even though it cannot execute script —
`base-uri 'self'` is already present, and `form-action` is its sibling.

`Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` are also
absent. COOP matters specifically for Phase 7: Stripe Checkout and the Customer
Portal are cross-origin navigations away from and back into an authenticated
window, and COOP is what severs the opener relationship across them.

- Add `form-action 'self'` to the CSP.
  - Resolution (2026-09-13): Done; verified live.
- Add `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Resource-Policy: same-origin`. Verify against a real Excalidraw
  session and the LiveKit A/V panel before enforcing — COOP can break popup
  flows, which is the point, so the checkout return path must be a redirect and
  not a popup handshake.
  - Resolution (2026-09-13): Both set and verified live; the checkout return is
    a redirect, not a popup handshake, and the board and call panel run under
    them in the end-to-end suite.
- Consider `require-trusted-types-for 'script'` once the Excalidraw fork's
  DOM writes are known to be Trusted-Types clean; do not enforce it blind.
  - Resolution (2026-09-13): Considered and not enforced (D-7).

**Acceptance tests:** CSP unit tests assert `form-action`; an E2E run reports no
new CSP violations on a real board; the A/V panel still starts.

### SEC-A24 — Low — Stripe object ids are interpolated into API paths unchecked

**Component:** `src/lib/billing/stripeRequest.ts:44-95`
**Status:** Verified by code trace; bounded by URL resolution semantics
**CWE:** CWE-20 (improper input validation)

`eventsFetchMapRequest` splices the webhook's `objectId` straight into the path
(`/v1/subscriptions/${id}` and four siblings), and `collectionStateRequest`
does the same with `subscriptionId`. Neither validates a grammar.

The blast radius is small: `endpoint()` builds the URL as
`new URL(path, apiBaseUrl)` with a path that always begins `/v1/`, so the host
cannot be changed even by an id such as `//evil.example/x`, and the id is only
reached after signature verification. What an id containing `../` *can* do is
reshape the path within the Stripe API. Cheap to close, so close it.

- Assert `/^[A-Za-z0-9_]{1,255}$/` on every id before building a request.
  - Resolution (2026-09-13): Done: `STRIPE_ID_RE` / `assertStripeId` in
    `stripeRequest.ts`.
- Apply the same check to `referralCode` before it becomes
  `metadata[referrer_code]`, and to `promotionCodeId`.
  - Resolution (2026-09-13): Done for `referralCode` and `promotionCodeId`.

**Acceptance tests:** an id containing `../`, `/`, `?`, `#`, or a space is
rejected before any request is built.

### SEC-A25 — Low — Two sources of truth for plan limits

**Component:** `src/lib/plan/limits.ts:16-19`, `src/lib/plan/catalog.ts:10-15`
**Status:** Verified by code trace
**CWE:** CWE-710 (improper adherence to coding standards) — divergence risk

Occupancy is resolved through the plan catalog: `RoomDO.admitWithinOwnerPlan`
fetches `/accounts/plan` and reads `limits.maxUsersPerRoom`
(`RoomDO.ts:1596-1599`). Owned-room count is not:

```ts
export function canAddOwnedRoom(ownedCount: number, alreadyOwnsThisRoom: boolean): boolean {
  if (alreadyOwnsThisRoom) return true;
  return ownedCount < FREE_MAX_ROOMS;          // never reads maxOwnedRooms
}
```

`PLAN_CATALOG[...].limits.maxOwnedRooms` has no reader anywhere. Today this
errs safe — a paying tutor is capped at one room, which is a billing bug rather
than a security one — but two independent limit sources are how a cap ends up
enforced on one path and not the other once the paid tiers go live.

- Derive every cap from the resolved effective plan; keep `FREE_MAX_*` as
  the catalog's free-row values only.
  - Resolution (2026-09-13): Done: owned rooms read `limits.maxOwnedRooms` from
    the effective plan in IdentityDO; participants read the owner's plan at
    admission.
- Add a test asserting a `tutor_pro_*` account may own more than one room
  and a `free` account may not.
  - Resolution (2026-09-13): Covered by the IdentityDO plan and owned-room
    tests.

### SEC-A26 — Low — `resolveEffectivePlan` indexes the catalog with an unvalidated `plan_id`

**Component:** `src/lib/plan/effectivePlan.ts:60`, `src/lib/billing/apply.ts:310`
**Status:** Verified by code trace; fails closed today
**CWE:** CWE-754 (improper check for unusual conditions)

`applyClass1` reads the entitlement row and casts a TEXT column with no
validation (`apply.ts:310`: `planId: entitlement.plan_id as PlanId`), and
`resolveEffectivePlan` then indexes the catalog with it:

```ts
limits: PLAN_CATALOG[selected.planId].limits,   // effectivePlan.ts:60
```

An unrecognised `plan_id` — a row written by a newer deployment, a migration
mid-rollout, a manual repair — dereferences `undefined` and throws. The room
paths handle that safely: `RoomDO.admitWithinOwnerPlan` treats a non-OK plan
response as `forbidden()` and wraps the whole fetch in `try`/`catch`
(`RoomDO.ts:1586-1601`), and `resolvePlanMaxUsers` returns `null`. So the
outcome is denial, not a bypass — which is why this is Low, and why it should
still be made explicit rather than left to depend on two callers' error
handling.

- Validate `plan_id` against `PLAN_CATALOG` at the read boundary and fall
  back to the `free` row, logging the unknown value.
  - Resolution (2026-09-13): Done: `Object.hasOwn(PLAN_CATALOG, planId)` with an
    `unknown_plan_id` alert and a Free fallback (`effectivePlan.ts`).

### SEC-A27 — Low — Checkout and portal builders accept unvalidated return URLs

**Component:** `src/lib/billing/stripeRequest.ts:101-155`
**Status:** Verified — builders exist, no non-test caller
**CWE:** CWE-601 (open redirect)

`checkoutSessionRequest` and `portalSessionRequest` take `successUrl`,
`cancelUrl` and `returnUrl` as free strings and pass them to Stripe verbatim.
Neither function has a caller outside `stripeRequest.test.ts` — the last commit
added the builders, not the routes.

That is the reason to fix it now. When the routes land, any handler that reads
these from the request body hands an attacker an open redirect laundered
through `checkout.stripe.com`, which is a domain users are being trained to
trust with card details. SEC-A05 in the 2026-09-10 audit was the same class of
bug in `safeRedirectPath`; this is the chance to not write it twice.

- Build all three URLs server-side from `TEACHER_HOSTNAME` and a fixed
  path set. Never accept them from a request body.
  - Resolution (2026-09-13): Done: success, cancel and return URLs are built
    from the verified teacher host's origin and fixed paths; client URLs are
    ignored (`worker.billing.workers.test.ts` › SEC-A27).
- If a return path must vary, accept an opaque key and map it to a URL
  server-side; reuse `safeRedirectPath` only after confirming its backslash fix
  from SEC-A05 is in place.
  - Resolution (2026-09-13): Not needed: no return path varies.

**Acceptance tests:** a checkout request carrying `successUrl` in its body has
that field ignored; the built URL always has the teacher hostname.

### SEC-A28 — Info — Secret-bearing dispatch workflows have no environment gate

**Component:** `.github/workflows/billing-staging.yml`,
`.github/workflows/configure-livekit.yml`

Both are `workflow_dispatch` workflows that read repository secrets
(`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `E2E_STAGING_ACCESS_TOKEN`,
LiveKit credentials) and neither declares an `environment:`, so no protection
rule or reviewer stands between a dispatch and the secret. SEC-A08 already
recorded that the `prod` environment has no protection rules; this extends the
same gap to the manual workflows. It is the enabling condition for SEC-A17.

- Declare a protected `environment:` on every job that reads a secret, with
  required reviewers and a restricted branch list.
  - Resolution (2026-09-13): Every secret-reading job declares an environment,
    and all secrets are environment-scoped (the repository has none of its own).
    Reviewers and branch rules on those environments are owner action 2.

### Positive findings

These held up under the sweep and are worth not regressing:

- **No secret material in the repository.** `git ls-files` matching
  `.env|pem|key|p12|credentials|dev.vars|secret` returns only
  `.env.local.example`. `.gitignore` covers `.env*`, `.dev.vars*`, `*.pem`,
  `.data/`, `.wrangler/`. Every `sk_test_`/`whsec_` string in the tree is a test
  fixture.
- **`npm audit --audit-level=low` reports 0 vulnerabilities**, closing SEC-A06
  from the previous audit.
- **Supply chain.** Every GitHub Action is pinned to a full commit SHA with the
  version in a trailing comment; all four workflows declare
  `permissions: contents: read`; CI installs with `npm ci --ignore-scripts`;
  `package.json` declares no `preinstall`/`postinstall`/`prepare` hook.
- **Webhook signature verification is done correctly.** HMAC comparison goes
  through `crypto.subtle.verify` rather than a hand-rolled string compare
  (`stripeSignature.ts:52`), the signed message is `${t}.${body}` over the raw
  body, multiple `v1` values and multiple secrets are supported for rotation,
  and the 300 s tolerance is enforced on both sides.
- **Test-mode events cannot mutate entitlements.** `applyEvent` short-circuits
  a non-`livemode` event to `ignored: livemode_mismatch` before `processEvent`
  runs (`apply.ts:490-492`), and the Worker forwards such events with no fetched
  objects at all.
- **Plan enforcement fails closed.** `admitWithinOwnerPlan` returns `forbidden()`
  on a missing owner, a non-OK plan response, a non-integer cap, or any thrown
  error — there is no path where an unresolvable plan admits a user.
- **All billing SQL is parameterised.** Every statement in `apply.ts`,
  `operations.ts` and the entitlement writer uses `?` placeholders; no string
  concatenation into SQL anywhere in the billing surface.
- **Session cookies.** `__Host-` prefix with `Secure; HttpOnly; Path=/;
  SameSite=Lax`, backed by exact-`Origin` CSRF checks rather than relying on
  `SameSite` alone.
- **No credentials in browser storage.** `localStorage` holds display names,
  cursor colours, a device preference and a call-panel flag — no token, grant,
  or session material.
- **No CORS headers are emitted anywhere**, so no route is cross-origin
  readable by construction.
- **One `dangerouslySetInnerHTML` in the tree** (`src/app/layout.tsx:37`) and it
  interpolates a build-time constant through `JSON.stringify`, under a nonce'd
  `script-src`.
- **No LLM or AI dependency**, so the prompt-injection and model-output-execution
  classes do not apply to this codebase.

### Recommendations not tied to a single finding

- **Give the billing surface its own adversarial suite**, the way `/signaling`
  has `signalingAdversarial.workers.test.ts`. The webhook is now the only
  unauthenticated POST on the teacher host; it deserves the same treatment:
  forged signature, replayed signature, expired timestamp, truncated body,
  chunked oversized body, unknown event type, unknown `plan_id`, and an apply
  body submitted without a verification marker once SEC-A19 lands.
- **Add a secret-shape assertion to the deploy path.** SEC-A17 and SEC-A28 are
  both instances of the same missing control: nothing anywhere asserts which
  *mode* a credential is in. One helper that classifies a Stripe key as test or
  live, called at config read and in CI, closes the class rather than the
  instances.
- **Treat "verified at the edge, trusted at the writer" as a pattern to hunt.**
  SEC-A19 and SEC-A20 are the same shape: a Durable Object route whose safety
  rests on every current caller behaving. Walk the remaining `IdentityDO` and
  `RoomDO` routes and record, per route, what it asserts versus what it assumes
  — that inventory is now `SECURITY_ROUTE_REVIEW.md`.
- **Fold the response-header work into one change.** SEC-A22 and SEC-A23 both
  touch `withSecurityHeaders`; HSTS, `form-action`, COOP and CORP are one commit
  and one test file, and splitting them across releases means four separate
  verification passes against a real Excalidraw session.
- **Re-run this sweep when the checkout and portal routes land.** SEC-A27 is
  recorded against code that has no caller; the finding's whole value is that it
  is cheap to close now and expensive to notice later.

### SEC-A29 - Medium - Cross-tenant read of room error ring via public API (2026-09-22 audit)

**Component:** `src/worker.ts` ROOM_API subpath handling; `src/do/RoomDO.ts:568` `/room/errors`
**Status:** Fixed; verified by independent verifier APPROVE on `296beb2`
**CWE:** CWE-862 (missing authorization), CWE-284

The OPS-01 error-ring read was reachable through the public room API: subpath
`/errors` was not in the public refusal list, and the RoomDO branch served the
ring before any authorize/tombstone/roomExists check, so any session (teacher or
post-PIN guest) could read any room's internal failure log by id. The admin path
(`/api/admin/errors`, namespace binding) was always safe; only the front door
leaked.

- Resolution (2026-09-22): `/errors` added to the ROOM_API public refusal list
  (404 before forward); admin route proved unaffected.
  - Evidence: verifier APPROVE on `296beb2`; mutation-tested - deleting the
    refusal fails `refuses a cross-tenant read...` at
    `src/worker.access.workers.test.ts:1758` (killed by implementer, orchestrator
    and verifier independently).

### SEC-A30 - Medium - Email accepted on the access-request path against the privacy invariant (2026-09-22 audit)

**Component:** `src/lib/whiteboard/requestSchemas.ts`, `membership.ts`,
`handlers/requests.ts`, `roomSchema.ts`
**Status:** Fixed; verifier APPROVE on `296beb2`
**CWE:** CWE-359 (exposure of private personal information)

`public/privacy.html` promises no student email can be stored, but
`requestsPostSchema` accepted optional `email` and persisted it on
`room_members` for signed-in requesters. Field removed from schema, handler and
membership reads/writes; legacy DB column kept (additive-only migration
discipline), never written non-NULL, nulled on erasure.

- Resolution (2026-09-22): invariant tests assert absence of `email` at schema,
  handler, membership list and DO level.
  - Evidence: verifier APPROVE; mutation-tested - re-adding the field fails two
    invariant tests (killed by implementer and verifier).

### SEC-A31 - Medium - BAK-01 R2 backups never purged or expired (2026-09-22 audit)

**Component:** `src/worker.ts` purge paths; `src/lib/backup/backup.ts`;
`infra/cloudflare/r2.tf`
**Status:** Fixed; verifier APPROVE on `296beb2`
**CWE:** CWE-404 (improper resource shutdown), data-retention violation of the
privacy 30-day promise

Room delete and account erasure removed only `rooms/{id}/files/`; full-row
`backups/` dumps (emails, plaintext guest_pin) lived forever with no lifecycle
rule.

- Resolution (2026-09-22): `purgeRoomBackups` on room DELETE and
  `purgeIdentityBackups` on erasure; `cloudflare_r2_bucket_lifecycle` expires
  `backups/` at 30 days.
  - Evidence: verifier APPROVE; mutation-tested (erasure purge mutants fail
    `head(ownedKey)` tests). Note: `terraform fmt -check` not run locally
    (binary absent) - hand-formatted; CI/drift check confirms.

### SEC-A32 - Medium - LiveKit participant identity disclosed raw accountId (2026-09-22 audit)

**Component:** `src/lib/av/participantIdentity.ts`, `handleAvToken.ts`,
`livekitToken.ts`, `RoomDO.ts` mint path, `RoomClient.tsx` roster join
**Status:** Fixed; verifier APPROVE on `296beb2`
**CWE:** CWE-200 (information exposure)

The A/V layer contradicted the HTTP redaction boundary: presence strips
accountId from non-owner views, but every call participant saw every peer's
stable accountId as the LiveKit identity. Identity is now
HMAC-SHA256(apiSecret, [roomId, accountId]) truncated to 32 hex chars
(per-room pseudonym); roster/moderation join runs on a server-minted
`peerId` JWT metadata claim (looked up from `room_presence` inside RoomDO,
never client-supplied; accountId never appears in metadata).

- Resolution (2026-09-22): opaque identity + peerId metadata join; screen-share,
  mute and roster e2e green.
  - Evidence: verifier APPROVE (explicit review: no accountId in metadata, no
    client input into identity/metadata); mutation-tested - dropping the
    metadata claim fails `livekitToken.test.ts:168` (killed by implementer and
    verifier); Stryker zero survivors on changed lines.

### SEC-A33 - Low/Info - Throttling, origin-guard and supply-chain gaps (2026-09-22 audit)

**Component:** `src/worker.ts` limiters; `src/lib/worker/requestGuard.ts`;
`package.json`
**Status:** Fixed; verifier APPROVE on `296beb2`
**CWE:** CWE-770 (unrestricted resource allocation), CWE-352, CWE-1104

- `POST /auth/session`, `POST /api/av/token`, board-file PUT and
  `GET /auth/account/export` had no rate limiters - all four added per-account
  (10/min, 10/min, 60/min, 5/min).
- Origin guard listed exact `/auth/session` while the host allowlist admitted
  `/auth/session/*` - now prefix-guarded for future subpaths.
- Unused `y-webrtc` production dependency (dead branch in shipped bundle) -
  removed; `securityScan.test.ts` asserts its absence; build output confirmed
  clean.
- Operator routes skip local session by design (break-glass, Access-only) -
  reviewed, intentionally unchanged.
  - Evidence: verifier APPROVE; mutation-tested - all four limiter guards and
    the origin-guard prefix fail their tests when weakened (killed by
    implementer and verifier; requestGuard Stryker zero survivors on changed
    lines).
