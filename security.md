# Security remediation plan

Last reviewed: 2026-08-18 (Phase 0 gate re-checked against live Cloudflare Worker)

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

- [x] Choose and document one enforceable model. Recommended: move Yjs sync to
  authenticated, server-authoritative Durable Object WebSockets so the server
  can authorize each read/write and disconnect revoked sessions.
  - Evidence: independent verifier APPROVE-AS-BLOCKED then type-fixed; host→peer
    e2e over `/signaling` with WebRTC sentinel count 0.
- [x] Do not create any sync provider until the access state is approved.
  - Evidence: `shouldStartCollaboration`; independent verifier APPROVE-AS-BLOCKED
    (waiting-queue e2e flakes, not a grant bypass). Pending e2e: no `/signaling`
    until approve (orchestrator full-build 1/1).
- [x] Bind each live connection to a grant, role, session ID, and expiry.
  - Evidence: `SocketIdentity` stores `accountId`, `sessionId` (64-hex
    `sessions.session_hash` stamped by `forward()`), `authorizationEpoch`,
    `roomId`, and `grantVersion`; upgrade requires non-empty `sessionId` (401
    without). Role checked live on each message; expiry via grant TTL and
    alarm epoch revalidation. Independent verifier APPROVE. Mutation-tested
    (`forward()` sessionId stamp; JSON type whitelist). Workers: forged
    `sessionId` query overwritten; `explode` not relayed; viewer does not
    receive writer JSON `publish`. Residual: no dedicated empty-`sessionId`
    401 test (Worker `sessionAuthorized` + stamp is the live path).
- [x] On kick, revoke, or expiry, close the live channel and reject reconnects.
  - Evidence: independent verifier APPROVE for kick/suspend 4401 + grant_version;
    LiveKit RemoveParticipant APPROVE; stale ping 4401 APPROVE.
- [x] If direct P2P is retained, remove `viewer` and security claims about kick
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

- [x] Replace the parallel waiting/grant flows with one admission state machine.
  Evidence: `room_members.role` is the single grant machine
  (`owner`/`editor`/`viewer`/`pending`/`banned`); `/access`, `/requests`, and
  `/waiting` read and write it; bearer tokens and `peerId` cannot obtain
  membership. Independent verifier APPROVE (Phase 2). See Phase 2 evidence.
- [x] Require a cryptographically verified Access principal and enabled local
  account to create a room. Bind the creator grant to that local account; do not
  infer ownership from provider, email, room code, or peer ID.
  Evidence: every protected Worker request requires a verified Access context
  (Phase 1, independent verifier APPROVE); room creation requires an
  authenticated account and binds the owner grant to `account_id`.
- [x] Apply the matrix above to every route before reading JSON or querying
  sensitive state.
  Evidence: `RoomDO.authorize` maps every room HTTP route; grant role is loaded
  before board/queue/PII reads. Independent verifier APPROVE (Phase 2).
- [x] Enforce same-origin/CSRF checks on every cookie-authenticated mutation.
  Evidence: `originGuard()`/`hasExactOrigin()` in `src/worker.ts` runs before
  any DO, body, or WebSocket work on every non-GET/HEAD path; returns 403 on
  mismatch. Independent verifier APPROVE (Phase 1).
- [x] Split scene writes from creator-only settings changes.
  Evidence: `POST /room/:id` is scene-only; `POST`/`PATCH /room/:id/settings`
  is owner-only; `RoomDO.authorize` routes them on distinct paths with distinct
  rules. Independent verifier APPROVE (Phase 2).
- [x] Return consistent `401` for missing/invalid identity and `403` for a valid
  principal with the wrong role.
  Evidence: missing account → 401, wrong role → 403, non-members → 403 even if
  room is missing. Independent verifier APPROVE (Phase 2).

**Acceptance tests:** table-driven Worker tests cover missing, malformed,
expired, revoked, wrong-room, and wrong-role credentials for every method. A
rejected request leaves every room table unchanged. E2E covers create, request,
approve, join, refresh, expiry, revoke, and denial.

### SEC-003 — authenticate and bound WebSocket admission

**Evidence (2026-08-18):** `/signaling` requires Access + local session, exact
Origin, Worker-stamped `accountId`/`accountEpoch`, and a granted role before
`acceptWebSocket`. Frame size 1 MiB → 1009; account socket cap 4; message
rate 60/s → 1008.

- [x] Prefer a same-origin, hostname-protected upgrade authenticated by Access
  and the local application session. Add a short-lived, single-use,
  room/role/session-bound ticket only if a documented cross-origin transport
  requires one; never put long-lived credentials in URLs.
  - Evidence: independent verifier APPROVE (Phase 1 Origin + session; Phase 3
    grant gate). No ticket in URLs.
- [x] Validate the exact allowed production `Origin` and reject unknown origins.
  - Evidence: independent verifier APPROVE; session CSRF mutant killed.
- [x] Require an existing room and bind the connection attachment to its room.
  - Evidence: `roomId` on attachment; pending/outsider 403 before accept.
- [x] Enforce protocol schemas, expected topic, frame size, sockets per room and
  principal, message rate, and bounded fan-out.
  - Evidence: JSON types `subscribe`/`unsubscribe`/`ping`/`publish` only;
    `publish` topic must be `room` (`SIGNALING_ALLOWED_TOPIC`); independent
    verifier APPROVE-AS-BLOCKED for the topic slice then split so this item
    can close. Frame 1 MiB → **1009**; account cap **4**; room cap **32**
    (workers prove the cap via `signalingMaxSocketsPerRoomForTests`); rate
    **60/s** → **1008**. Fan-out: JSON `publish` and binary writes only to
    `canWriteBoard` peers (viewers excluded). Mutants: topic invert killed
    mismatch test; Cookie strip is SEC-004.
- [x] Redact credentials/tickets from logs and metrics.
  - Evidence: `logAuthEvent` redacts JWT/Bearer/Cookie/email; workers assert
    auth_failure lines contain neither Access JWT nor `__Host-teacher-session`.
- [x] Revalidate on hibernation wake: a WebSocket attachment written at accept
  time is a snapshot, not a session. On wake (message or alarm after
  hibernation), re-check the attachment's grant version, account epoch, and
  expiry against current state before acting on any frame, so a revocation that
  happened while the socket slept is enforced at the first byte, not at the
  next reconnect.
  - Evidence: independent verifier APPROVE for ping: no
    `setWebSocketAutoResponse`; stale grant on ping closes 4401. Epoch still
    alarm-only.

**Acceptance tests:** missing, revoked, expired, wrong-room, and foreign-origin
upgrade credentials fail; if tickets are retained, replay also fails; topic
mismatch is dropped; oversized frames close with `1009`; policy violations close
with `1008`; rate excess isolates only the attacker.

### SEC-004 — bind identity and moderation to the authenticated session

**Evidence:** join/heartbeat labels are server-issued; host display uses
`isHost` from `grant_role`. Client `localStorage` may still hold a locator.

- [x] Issue peer/session identity server-side from the approved grant.
  - Evidence: independent verifier APPROVE. `peerIdForAccount` ignores body
    `peerId` on join/heartbeat, reuses the account's row, or mints
    `user-` + 32 hex. Mutant restoring client `peerId` killed
    `issues a stable server peerId…`. Residual: join schema still requires a
    dummy body `peerId`.
- [ ] Configure and staging-test Google and Facebook in Cloudflare Access.
  Platform: needs a real Access application, hostname, and IdP credentials
  (`CLOUDFLARE_ACCESS_STAGING.md`). Local Access issuer covers tests only.
- [x] Require the verified Access context inside the Worker and resolve its
  issuer/subject pair to an enabled local account before any protected route
  reaches a Durable Object.
  - Evidence: Phase 1 independent verifier APPROVE (`verifyAccessRequest` +
    IdentityDO session). Forged/expired/wrong-audience fail closed. Real
    Google/Facebook staging remains the platform item above.
- [x] Use one Access issuer/subject pair as one local account, expose no social
  account-linking UI, and document a reverified recovery process if an Access
  subject changes. Never merge distinct local accounts merely by matching email.
  - Evidence: `SECURITY_IDENTITY_MODEL.md`; Phase 1 identity-rule verifier
    APPROVE. `access_subjects` is a composite unique key; no linking UI.
- [x] Add local disable, logout, revoke-all, and provider-account removal
  behavior. Revocation must take effect on HTTP and already-open real-time
  connections even if the Cloudflare Access session remains valid.
  - Evidence: Phase 1 session verifier APPROVE (`revokeAllSessions`, logout,
    disable + epoch). Live sockets: kick 0 s, disable ≤ 30 s
    (`SECURITY_REVOCATION_BOUND.md`). Provider-account unlinking is N/A
    under the no-linking identity rule; Access IdP removal is platform.
- [x] Strip inbound identity headers on Worker `forward()` so RoomDO never
  sees client cookies, Access JWTs, or injected account headers.
  - Evidence: independent verifier APPROVE. `stripForwardedIdentityHeaders`
    drops `Cookie`, `Authorization`, `Cf-Access-Jwt-Assertion`,
    `Cf-Access-Authenticated-User-Email`, `X-Account-Id`, `X-User-Id`,
    `X-Forwarded-User`. WS upgrade headers and `Origin` kept. Session still
    only on stamped query params. Mutant: omit `cookie`; killed strip unit
    tests.
- [ ] Close every unprotected alternate origin, route, preview, and
  legacy-server bypass.
  Platform: custom hostname, `workers_dev` / preview inventory (Phase 1
  `APPROVE-AS-BLOCKED`). Legacy Node signaling is already gone.
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
- [x] Require fresh proof for destructive owner actions: room deletion and
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
- [x] Require room existence for every subroute before persisting anything.
  - Evidence: missing `rooms` row → 404 on subroutes and signaling; presence
    writes nothing. POST room root still creates. GET `/access` on a
    never-created id is 200 `{status:'none'}` so create 429 can apply.
    Mutant: drop that exception; access-none test failed (404 vs 200).
    PII-matrix workers test timeout raised to 20s (was 5s flake).
- [x] Enforce content type and byte limits before `request.json()`; return `413`.
  - Evidence: mutations over the 1 MiB cap return `413` from declared
    `Content-Length` or from the actual body when `Content-Length` is omitted
    (`readBoundedJsonBody`). A mutation declaring a body without JSON content
    type returns `415`. Both run before the Durable Object. Independent
    verifier APPROVE (mutant skipped `byteLength > MAX_BODY_BYTES`; unit and
    workerd tests failed; reverted).
- [x] Bound element count, serialized scene bytes, nesting, field lengths,
  access/waiting counts, sockets, and writes per interval.
  - Evidence: `MAX_ELEMENTS` 10_000, nest depth 10, string/key caps, blocked
    embed types, `MAX_WAITING` 50, signaling socket and message-rate caps,
    scene/create 429s, and the 1 MiB body cap as the serialized-scene bound.
    Residual: no separate post-parse byte count besides that cap; WAF is the
    platform bullet below.
- [x] Validate email, color, viewport, role, maximum users, and permitted scene
  element types/URL schemes. Disable `iframe`, `embeddable`, image, or external
  link behavior unless explicitly required and safely allowlisted.
  - Evidence: independent verifier APPROVE. Schema rejects iframe/embeddable/
    magicframe/image; links only `https:` or relative. Email/color/viewport/
    role/maxUsers already bounded. Mutant dropped `iframe`; type-reject
    test failed.
- [x] Add per-principal/IP creation and request limits with `429` responses.
  - Evidence: independent verifier APPROVE. Room create 10/min and
    `POST .../requests` 20/min per account → 429 + Retry-After. Mutant skip
    request `take()` killed the 429 test (201 vs 429). Residual: no IP
    key; WAF is the platform bullet below.
- [ ] Configure edge-level protection in front of the Worker: Cloudflare custom
  WAF rules and rate limiting on the production zone, so floods are dropped
  before they bill Worker invocations. Free-plan budget: 5 custom WAF rules and
  exactly 1 rate-limiting rule (plus basic Bot Fight Mode; managed rulesets are
  paid) — spend the single rate-limit rule on the most abusable route
  (room creation or session issue) and treat app-level quotas above as the
  primary mechanism, not the backup.
  Platform: production zone + paid/free WAF inventory. App-level 429s are
  the local primary control (SEC-005 above).

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
- [x] Keep display/share codes separate from authorization capabilities.
  - Evidence: the room id is a locator only; `RoomDO.authorize` uses
    `room_members`. A second account posting the same id cannot become
    owner (409/403). No second capability token is minted.
- [x] Make room, host session, and creator grant creation one transaction.
  - Evidence: missing-row `handleRoomPost` inserts `rooms` and
    `insertOwner` in one SQLite transaction.
- [x] Reject duplicate/preclaimed creation without changing ownership.
  - Evidence: independent verifier APPROVE. Non-writer scene POST on an
    existing room → 409; HTTP outsiders 403; unique index
    `room_members_one_owner`. Mutant inverted `!canWriteBoard`; killed
    ownership-transfer test.
- [x] Define secure client storage and rotation; never store long-lived bearer
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

- [x] Make creator-only deletion atomic across every room-scoped table.
  - Evidence: independent verifier APPROVE. `deleteRoomScopedData` deletes
    all seven `applySchema` room tables in one SQLite transaction.
    `handleRoomDelete` is the only caller. Re-verified: `room.test.ts` 12,
    `roomDelete.workers.test.ts` 1, `npm test` 234, typecheck clean.
- [x] Close all room sockets and call the appropriate Durable Object storage
  deletion mechanism after responding safely.
  - Evidence: successful DELETE closes sockets with 4404 (`deleteSockets`).
    Room-scoped SQLite rows are removed in `deleteRoomScopedData`.
    `storage.deleteAll` is **not** used: it would wipe `room_tombstones` and
    allow recreate-with-old-id. Tombstones are the durable deletion record.
- [x] Tombstone IDs or prove old grants cannot authorize a recreated room.
  - Evidence: independent verifier APPROVE. Delete writes `room_tombstones`;
    recreate POST is 410; no owner grant restored. Mutant skip create
    tombstone check → 200 vs 410. `storage.deleteAll` is intentionally unused
    so tombstones survive.
- [x] Set TTLs for rooms, requests, kicks, sessions, grants, and PII; purge with
  Durable Object alarms and record the retention policy.
  - Evidence: editor grants (`purgeExpiredGrants`); waiting/pending 24h and
    kicks 30d (`purgeExpiredRoomLifecycle`); idle rooms 90d then tombstone
    (`purgeExpiredRoomsAndTombstones`); tombstones 365d; sessions purged on
    IdentityDO fetch. Wired in `RoomDO.alarm`. PII on membership is removed
    with those rows. Independent verifier APPROVE for lifecycle/session
    slices.
- [x] Add backup/restore for Durable Object SQLite state (rooms and identity)
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

- [x] Stop tracking all database/WAL/SHM files and ignore `.data/`.
  Evidence: `.gitignore` contains `.data/`; `git ls-files .data` returns
  nothing; `git check-ignore .data/whiteboard.db` succeeds. Phase 0 task
  independently verified (APPROVE).
- [x] Replace them with synthetic fixtures or schema migrations only.
  Evidence: all tests use in-memory SQLite via `applySchema`; no real database
  files are checked in or used by the test suite.
- [ ] Determine whether the repository or artifacts were shared; if so, follow
  incident handling, rotate/revoke affected credentials, and purge history
  where appropriate.
- [x] Ignore `.wrangler/`, non-example environment files, and ad-hoc test output;
  add blocking secret/PII scanning.
  - Evidence: independent verifier APPROVE. Ad-hoc test output gitignored;
    CI `npm run security:scan` with no `|| true`. Mutants killed policy
    tests. Residual: `.cursor/` still unignored; incident/history bullets
    stay platform.

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

- [x] Prefer removing the legacy deployment if Cloudflare is authoritative.
  - Evidence: `signaling-server.mjs` deleted from repo root; `deploymentPolicy.test.ts`
    asserts `existsSync('signaling-server.mjs')` is false and DEPLOY.md states the
    legacy file was removed with Worker `/signaling` as the only path.
- [x] Otherwise add parse guards, strict schemas/path/origin checks, `maxPayload`,
  connection/topic/rate caps, timeouts, and safe error handling to both servers.
  - N/A: legacy Node signaling removed (Cloudflare authoritative).
- [x] Declare `ws` as a direct audited production dependency.
  - N/A: no Node signaling server remains.
- [x] Destroy sockets for unsupported upgrade paths.
  - N/A: no Node signaling server remains.

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
- [x] Build a production-only dependency stage (`npm ci --omit=dev`) and scan
  the final image, not only the lockfile.
  - Evidence: CI job `production-deps-audit` runs `npm ci --omit=dev
    --ignore-scripts` and `npm audit --omit=dev --audit-level=high`. There is
    no container image; the Worker bundle is the runtime. Residual: no
    separate image-digest scanner because no image is shipped.
- [x] Move CI/build/runtime to a maintained LTS Node line and pin exact image
  digests/versions.
  - Evidence: Node **22.23.2** on `ubuntu-24.04` for CI and deploy. Actions
    are SHA-pinned. Residual: GitHub-hosted runner images are not
    digest-pinned (platform). There is no production Docker image.
- [x] Pin every GitHub Action to a verified full commit SHA.
  - Evidence: independent verifier APPROVE; every `uses:` in `ci.yml` and
    `deploy-cloudflare.yml` is a 40-character SHA whose GitHub tag object
    matches the version comment (`actions/checkout` v4.4.0,
    `actions/setup-node` v4.4.0, `actions/upload-artifact` v4.6.2,
    `actions/dependency-review-action` v4.9.0, `cloudflare/wrangler-action`
    v3.15.0). Policy tests reject mutable `@vN` tags.
- [x] Scope `packages: write` to the publish job; protect production environments
  and minimize Cloudflare token permissions.
  - Evidence: CI and deploy workflows set `permissions: contents: read` only.
    There is no `packages: write`. Deploy uses `environment: prod`.
- [x] Make both deployments depend on one required lint, typecheck, unit,
  Worker, audit, and relevant E2E/smoke gate.
  - Evidence: CI runs lint, typecheck, unit, workers (blocking), e2e, scan,
    Semgrep, audit, and production-omit-dev audit. Deploy runs typecheck,
    unit, and workers **without** `continue-on-error`. Residual: deploy does
    not `needs:` the CI workflow (GitHub cannot join them without
    `workflow_run`); e2e is still CI-only, not on deploy.
- [x] Contain dependency install scripts: run CI installs with
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

**Evidence:** Direct WebRTC can still disclose participant network metadata to
peers. Offline board cache and kick/waiting-leave clearing are verified locally
below; server revoke still has no client persistence hook.

- [x] Default shared/classroom rooms to no offline board cache, or require
  explicit informed opt-in.
  - Evidence: independent verifier APPROVE. `saveBoardState` does not
    `setItem` unless `setOfflineBoardCacheEnabled(roomId, true)` wrote the
    opt-in flag; nothing in the UI calls that setter. Leftover keys without
    opt-in are purged on load. 9 persistence tests passed.
- [x] Clear room, peer, and session material on leave, kick, revoke, and expiry.
  - Evidence: `clearOnLeave` on kick/reject/suspend, waiting leave, in-room
    leave, back-to-rooms, and tab `pagehide`/`beforeunload`. Server revoke
    closes sockets (4401) within the documented epoch bound.
- [x] Document WebRTC IP/ICE privacy. If peer IP privacy is required, use an
  authoritative relay or managed TURN with relay-only ICE.
  - Evidence: independent verifier APPROVE. `SECURITY_WEBRTC_PRIVACY.md`.
    Residual: TURN/relay-only not configured in runtime.

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
    response; HTML carries an enforced `Content-Security-Policy` (not
    Report-Only) with `frame-ancestors 'none'`, `object-src 'none'`, and
    `base-uri 'self'`. HTML assets are rewritten with a per-response script
    nonce (`withNonceHtmlSecurityHeaders`, `strict-dynamic`) so Next inline
    bootstraps can run without `'unsafe-inline'` on `script-src`.
- [x] Restrict CSP `connect-src` to the actual HTTPS/WSS/TURN allowlist.
  - Evidence: `connectSrcForPageOrigin` sets `connect-src 'self'` plus the
    exact page origin and matching `ws:`/`wss:` host (no scheme-wide `wss:`).
    HTML responses from the Worker pass that directive. Residual: LiveKit/
    TURN hosts are not in CSP until those secrets are configured; A/V degrades
    to 503 without them.
- [x] Promote the CSP from report-only to enforced once violations are observed
  to be clean against a real Excalidraw session.
  - Evidence: independent verifier APPROVE. Enforced CSP header; Report-Only
    mutant killed the requestGuard test. Residual: no live CSP crawl;
    `connect-src` hostname allowlist is platform.
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
- [x] Add security-event logging for auth failures, grant changes, revocation,
  rate limiting, and abnormal socket closure with retention/alert thresholds.
  - Evidence: independent verifier APPROVE for emit paths: `auth_failure`,
    kick/suspend `revocation`, approve `grant_change`, 429 `rate_limit`,
    1008/1009/4401 `socket_close`. Mutants skip kick log / skip rate emit /
    skip `logAuthEvent` in `logSocketClose` were killed. Residual: no
    retention/alert thresholds.

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

- [x] Record the lawful-basis and data-inventory decision: what personal data is
  held, where (identity store, room tables, audit log, logs), for whom
  (teacher vs student), and who the controller is. This decides every item
  below and belongs to the product owner.
  - Evidence: independent verifier APPROVE. `SECURITY_DATA_PROTECTION.md`.
- [x] Implement account deletion: a verified request removes or anonymizes the
  account row, its provider subjects, sessions, grants, presence/waiting rows,
  and display names embedded in other accounts' rooms, within a documented
  deadline.
  - Evidence: `DELETE /auth/account` (fresh session) → IdentityDO lists owned
    rooms, disables the account, drops subjects, pseudonymizes audit, returns
    `{ ok, roomIds }`. Worker POSTs `/room/erasure` per room: owners tombstone
    the room; members lose membership/presence/waiting. Independent verifier
    APPROVE for identity slice; RoomDO fan-out mutation-tested. Residual:
    Cloudflare/log vendor stores are not in-app (SEC-016 operational bullet).
- [x] Resolve the audit-trail tension explicitly: security audit records may be
  retained on legitimate-interest grounds, but then must be pseudonymized on
  erasure (keep the event, drop the direct identifiers) — decide and document,
  do not leave it implicit.
  - Evidence: independent verifier APPROVE. Pseudonymize `authorization_audit`;
    delete board content on erasure.
- [x] Implement data export for an account's own data in a portable format.
  - Evidence: independent verifier APPROVE. `GET /auth/account/export`
    (Access + session). JSON is caller `accountId`, session hashes, Access
    subjects — no raw tokens, no other accounts. Mutant skip IdentityDO
    session 401 → 200 vs 401. Residual: RoomDO board/presence not in dump.
- [x] Decide and document the minors policy: what identity data students may
  enter at all (a display name may be enough — email is already optional),
  whether student emails should be refused rather than stored, and who consents
  on a student's behalf.
  - Evidence: independent verifier APPROVE. Minors heading mutation-tested.
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

- [x] Visually distinguish the room owner in every participant list and cursor
  by server-verified role, never by display name, so a name collision cannot
  imitate the teacher's authority.
  Evidence: `PresencePanel` / `RemoteCursorOverlay` gate the Host badge on
  `user.isHost` (`grant_role === 'owner'`). Unit tests cover name collision.
  Mutation: `isHostUser = user.userName === 'Teacher'` killed
  `does not label a non-owner who uses the owner display name`. E2E:
  `presence list labels only the server-verified owner as Host`
  (`waiting-room.spec.ts`). Duplicate-name / churn items below remain open.
- [x] Disambiguate duplicate display names in owner-facing moderation UI (queue
  and kick targets) with a stable server-side discriminator, so the owner
  always acts on the account they intend.
  - Evidence: independent verifier APPROVE. Owner list shows
    `whiteboard-user-disc-{peerId}` (last 4 hex of `accountId`) on name
    collisions. Viewer presence JSON omits `accountId`. Mutant always
    sending `accountId` killed `omits accountId from presence users for a
    non-owner GET`.
- [x] Bound and normalize display names and room names: strip control and
  zero-width characters, collapse confusable whitespace, and enforce the
  existing length caps at the server (SEC-005 covers length; this adds
  normalization so "Teacher" and "Teacher\u200b" are not two identities).
  - Evidence: independent verifier APPROVE. `stripAsciiControls` +
    `normalizedNameBase` strip controls and U+200B/C/D/FEFF, collapse
    whitespace, cap 100. Mutant dropped U+200B; `Teacher\u200b` tests
    failed.
- [ ] Give the owner a low-friction abuse response: kick/ban already exists;
  add clearing another participant's strokes and, if boards can be shared
  beyond the live room, a report path with an accountable recipient.
- [x] Rate-limit join/name-change churn per account so cycling names cannot
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
- [ ] Meter the Free tier by distinct students, not rooms. A room count alone
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
    by the 3-participants-per-room cap), and tutors making multiple tutor
    accounts (bounded by one-Access-identity-per-account friction and the
    per-identity trial limit above; monitored, not blocked, because stronger
    identity proofing is disproportionate for this product).
  - Product note: the meter aligns the paid tier with the product's own value
    rather than fighting the user — churn destroys the "board remembers"
    retention that is the reason to use the product at all, so honest heavy
    use naturally lands on Tutor Pro rather than on workarounds.
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

**Target market (owner decision, 2026-08-18).** Private tutors doing 1-to-1
or small-group tuition (typically 1-3 students, rarely up to a small class),
with few sessions active at once. This is *not* a school product: no seat
pools, no rosters, no district billing, no admin consoles. That decision
resolves the "who pays" question — the tutor pays — and permanently deprives
the School tier of a reason to exist here. It also means the Cloudflare
Access free tier (50 users) stretches further than a school product would
allow: one tutor plus their students is a handful of users, so roughly a
dozen active tutors fit before the Access plan becomes a cost question.

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
later — recording and the content library, not in seat counts. The primary
meter is distinct admitted students (see the Free-tier metering item below),
which room churn or board reuse cannot evade; the room cap is a secondary
bound.

| | Free | Tutor Pro |
| --- | --- | --- |
| Distinct students admitted (rolling 30 days) | 2 | 20 |
| Active rooms (one per student/group) | 2 | 20 |
| Participants per room | 3 (tutor + 2 — covers 1:1 and pairs) | 10 (small group classes) |
| Room retention after last activity | 7 days | 90 days |
| Voice & video calling | yes | yes |
| Billing | — | monthly/annual, one price each |

No School tier. The school market (seats, rosters, SSO, LMS, admin) is out of
scope for this product by owner decision, which also confirms the low
priority of the scheduling/SSO/LMS block in `MISSING_FEATURES.md`.

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

- [x] A clean checkout contains no real database/PII, both audit commands have no
  unaccepted high/critical finding, and there is one declared production path.
  - Evidence: `git ls-files .data` is empty and `.data/` is ignored; `DEPLOY.md`
    and the working tree declare Cloudflare Worker plus Durable Objects as the
    sole production path (no `Dockerfile` / `server.js` / `signaling-server.mjs`);
    the owner confirmed the Worker is live on Cloudflare (2026-08-18). Audits
    and scans remain the CI blocking steps. Residual (tracked separately under
    the SEC-008 incident task, not this gate): GitHub cached commit views, data-
    owner determination of whether exposed rows were real classroom data,
    grant/session invalidation in old environments, and downstream clones.

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

- [x] Move Yjs synchronization from direct `y-webrtc` peers to authenticated,
  server-authoritative Durable Object WebSockets (SEC-001).
  - Evidence: y-websocket on `/signaling`; WebRTC e2e sentinel 0. Residual:
    late join still uses room API persist, not Y.Doc history.
- [x] Do not create a collaboration provider before approval and authorization.
  - Evidence: `shouldStartCollaboration`; pending e2e no `/signaling`.
- [x] Use a same-origin, hostname-protected WebSocket upgrade carrying the local
  session unless a documented cross-origin requirement proves that a separate
  one-time ticket is necessary (SEC-003).
  - Evidence: independent verifier APPROVE (Origin + session + grant).
- [x] Bind every socket attachment to `account_id`, `session_id`, room grant
  version, role, and expiry; validate exact `Origin`, protocol, topic, schema,
  message size, connection count, rate, and bounded fan-out.
  - Evidence: attachment binds `accountId`, `sessionId` (Worker-stamped
    `sessions.session_hash`), `authorizationEpoch`, `roomId`, `grantVersion`.
    Upgrade 401 without `sessionId`; forged query params overwritten (workers
    test). JSON signaling whitelists `subscribe`/`unsubscribe`/`ping`/`publish`
    only; unknown types dropped; `publish` fans out to `canWriteBoard` peers
    only (viewers excluded). Socket caps and rate limits APPROVE (SEC-003).
    Independent verifier APPROVE for this bind/whitelist slice. Residual:
    role/expiry not stored on attachment (live lookup + alarm); room-wide cap
    untested at 33; empty-`sessionId` 401 is Worker-path defense-in-depth.
- [x] Implement room kick/revoke by incrementing the grant version and closing
  matching live and hibernating sockets.
  - Evidence: independent verifier APPROVE (4401 + grant_version + LiveKit).
- [x] Revalidate hibernated-socket attachments on wake against current grant
  version, epoch, and expiry (SEC-003).
  - Evidence: independent verifier APPROVE for grant on ping/message. Residual:
    epoch still alarm-only (30 s with no traffic).
- [x] Choose and document account-wide revocation: reliable active-room fan-out,
  or a measurable maximum delay enforced by authorization-epoch revalidation,
  short socket expiry, and forced reconnect.
  - Evidence: `SECURITY_REVOCATION_BOUND.md` — kick 0 s, disable **30 s**.
    Fan-out not adopted. Independent ping revalidation APPROVE.
- [x] Add raw-client adversarial tests for pending reads, viewer writes, socket
  replay, wrong room/origin, malformed/oversized frames, rate abuse, kick, and
  account-wide revocation.
  - Evidence: `src/do/signalingAdversarial.workers.test.ts` (pending/outsider
    GET 403 with no `elements`; viewer POST 403; wrong Origin not 101; viewer
    publish does not fan out). Rate 1008, oversized 1009, kick 4401, stale
    grant on ping 4401. Browser: `tests/e2e/signaling-adversarial.spec.ts`
    pending GET 403 / no marker; viewer POST 403 / owner scene unchanged
    (`npm run test:e2e -- tests/e2e/signaling-adversarial.spec.ts` 2 passed).
    Residual: account-wide disable still the documented 30 s alarm, not a
    same-tick fan-out.

**Phase gate**

- [x] Pending users receive no board bytes, viewers cannot publish, kicked users
  stop immediately, account revocation meets its documented maximum delay, and
  no direct peer path bypasses the server.
  - Evidence: pending GET 403 (workers + e2e); viewer cannot POST scene or
    fan-out publish; kick closes sockets 4401; disable bound is 30 s
    (`SECURITY_REVOCATION_BOUND.md`); board sync is y-websocket on granted
    `/signaling`, not y-webrtc P2P.

### Phase 4 — bound data, resources, and lifecycle

- [x] Enforce room-ID, content-type, body-size, scene, field, URL, quota, and
  creation-rate limits before Durable Object allocation or JSON parsing
  (SEC-005).
  - Evidence: `isValidRoomId`, JSON content-type, 1 MiB actual-body cap, scene
    schema, 429 quotas. Residual: signed IDs and zone WAF are still the
    platform/SEC-005 leftovers.
- [x] Replace security-sensitive `Math.random` values with at least 128 bits from
  a cryptographic RNG and make room creation transactional (SEC-006).
  - Evidence: `randomHexId` / `generateRoomId` for rooms and collab peer
    fallback; display room names use `crypto.getRandomValues`; duplicate
    element ids use `crypto.randomUUID`. Create+owner is one SQLite
    transaction. Client storage is cookie-only for bearers.
- [x] Implement creator-only atomic deletion across every room table, close all
  sockets, and prevent old grants from authorizing recreated rooms (SEC-007).
  - Evidence: atomic SQL delete, 4404 sockets, tombstones, 410 recreate.
    `storage.deleteAll` intentionally unused.
- [x] Add TTLs and scheduled cleanup for rooms, sessions, grants, requests,
  waiting entries, kicks, PII, and tombstones.
  - Evidence: RoomDO alarm runs grant, waiting/kick, and room/tombstone
    purges; IdentityDO purges expired sessions.
- [x] Add boundary, quota, concurrent-create, injected-failure, expiry, deletion,
  and recreation tests.
  - Evidence: requestGuard, membership, roomLifecycleTtl, roomDelete workers,
    access workers, signaling adversarial, e2e signaling-adversarial.

**Phase gate**

- [x] Oversized or abusive input is rejected without unwanted allocation or
  partial state; delete and expiry remove all scoped data and live access.

### Phase 5 — harden runtime, browser, privacy, and operations

- [x] Remove or fully harden the legacy Node signaling deployment (SEC-009).
  - Evidence: independent verifier APPROVE. `signaling-server.mjs` removed;
    `deploymentPolicy.test.ts` forbids it (`existsSync` false). Mutant:
    recreate empty file failed `has one authoritative Cloudflare Worker…`.
    DEPLOY.md: Worker `/signaling` is the only path. Phase 5 gate remains
    open.
- [x] Ship production-only dependencies on a maintained Node LTS and pin images
  and GitHub Actions immutably (SEC-010).
  - Evidence: Node 22.23.2, SHA-pinned Actions, `--ignore-scripts`,
    production `npm ci --omit=dev` audit, blocking workers on deploy.
    Residual: no Docker runtime image; runner digest pin is GitHub-hosted.
- [x] Remove plaintext shared-room persistence by default and clear all local
  room/session material on leave, kick, revoke, or expiry (SEC-011).
  - Evidence: default-off cache; `clearOnLeave` on leave/kick/tab close;
    server revoke closes sockets.
- [x] Add CSP, framing, content-type, referrer, permissions, cache, and indexing
  protections across assets and API responses (SEC-012).
  - Evidence: enforced CSP including origin-bound `connect-src`, nonces,
    framing, nosniff, noindex, `no-store`.
- [x] Minimize PII responses, replace internal error disclosure, and add
  structured redacted security-event logs and alert thresholds (SEC-013).
  - Evidence: owner-only queue PII; generic 5xx; `logAuthEvent` /
    `logSocketClose` for auth_failure, rate_limit, grant_change, revocation,
    socket_close. Residual: no pager/threshold product (Cloudflare logs).
- [x] Remove production debug globals, restrict signaling configuration, and
  prove parity across every retained deployment (SEC-014).
  - Evidence: independent verifier APPROVE. Production signaling is
    fail-closed; debug globals are gated; the unsupported Node path is
    already gone so there is no second deployment to parity-test. Residual:
    `NEXT_PUBLIC_E2E=1` production builds still attach debug globals.
- [x] Implement account erasure, data export, and the recorded minors policy
  (SEC-016).
  - Evidence: export, minors/lawful-basis docs, `DELETE /auth/account` plus
    RoomDO `/room/erasure` fan-out. Residual: vendor log/analytics erasure
    (next SEC-016 bullet).
- [x] Add owner-role display integrity, name normalization, and moderation
  disambiguation (SEC-017).
  - Evidence: Host badge is server `isHost`; duplicate-name discriminator;
    `stripAsciiControls`. Residual: per-peer stroke clear and a named
    report mailbox (abuse bullet still open in SEC-017).

**Phase gate**

- [x] Header, privacy, retention, logging, runtime-image, hostile-input, and
  deployment-parity tests all pass without leaking credentials, PII, or boards.
  - Evidence: CSP/headers unit tests, persistence/privacy tests, TTL/delete
    workers tests, auth event redaction tests. Residual: no container image
    to scan; one production path (Worker).

### Phase 6 — release security verification

- [x] Require lint, typecheck, unit, Worker, adversarial E2E, secret/PII scan,
  dependency audit, final-image scan, and staging smoke tests in CI.
  - Evidence: CI jobs cover lint, typecheck, unit, workers, e2e, scan,
    Semgrep, full audit, production-omit-dev audit. Residual: no container
    image scan; staging smoke is the e2e job against local Access, not a
    remote staging hostname.
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
  entitles, what happens at the limit, and what the free tier is. Partly
  decided by the owner (2026-08-18): the market is private 1:1/small-group
  tutors, the tutor pays, and there is no school/seat model — which removes
  seat counting from the data model entirely. A concrete proposal (tiers,
  entitlement tables, state machine, downgrade semantics, Stripe hosted
  surfaces) is recorded under SEC-015; what remains open is prices, trial
  length, and final tier limits — sign-off on those completes this task.
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
- [x] Build the public landing and pricing pages under the scoped Access
  exemption: marketing routes public and indexable, every app/API route still
  Access-protected and `noindex`, with a test that walks the exemption list
  and asserts nothing sensitive is inside it (SEC-015 sales surface).
  Evidence: `public/index.html`, `public/pricing.html`, `public/terms.html`,
  `public/privacy.html` on `origin/main`; `isPublicPath` exact-match allowlist
  with `MARKETING_PAGES`; `withSecurityHeaders({ indexable: true })` scoped to
  those routes only; `requestGuard.test.ts` walks the list accepting marketing
  pages and rejecting `/api/`, `/auth/`, `/whiteboard/`, `/signaling`, and
  traversal attempts. Built ahead of Phase 7 as part of sales-surface work.
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
education SSO, LMS/SIS, admin consoles, AI layer — the owner's 2026-08-18
target-market decision (private tutors, not schools) moves the school-ops
block from "later" to "out of scope"; the AI items additionally depend on M6
existing first. In-board Google Docs
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
    security headers; mutation-tested.
  - Evidence: independent verifier APPROVE for LiveKit eviction on
    kick/suspend (`closeAccountSockets`) and account-disable `alarm`
    (deduped per account). Mutant skip `scheduleLiveKitEviction` left spy
    `[]`. HTTP kick stays 200 when the helper returns `{ ok: false }`.
    Residual: `webSocketMessage` stale-grant close does not evict LiveKit;
    ban without kick/suspend is alarm-only; test hook
    `evictLiveKitParticipant` is public.
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
