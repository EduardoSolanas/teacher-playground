# Security remediation plan

Last reviewed: 2026-08-17

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

**Evidence:** `/signaling` routes solely on `?room=` in
`src/worker.ts:35-42`; `src/do/RoomDO.ts:113-161` accepts any upgrade and
broadcasts any string `publish`. No `Origin`, room existence, credential,
message-size, connection-count, or publish-rate check exists.

- [ ] Prefer a same-origin, hostname-protected upgrade authenticated by Access
  and the local application session. Add a short-lived, single-use,
  room/role/session-bound ticket only if a documented cross-origin transport
  requires one; never put long-lived credentials in URLs.
- [ ] Validate the exact allowed production `Origin` and reject unknown origins.
- [ ] Require an existing room and bind the connection attachment to its room.
- [ ] Enforce protocol schemas, expected topic, frame size, sockets per room and
  principal, message rate, and bounded fan-out.
- [ ] Redact credentials/tickets from logs and metrics.

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
- [ ] Ignore client-supplied identity for authorization.
- [ ] Allow heartbeat and leave only for the caller's own session.
- [ ] Moderate and ban a grant/session, not a replaceable `peerId`.
- [ ] Remove the first-user host fallback and all client-side authorization.

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

- [ ] Define one server-side room-ID grammar/length and reject before DO lookup.
- [ ] Prefer signed or otherwise verifiable IDs so random invalid IDs do not
  allocate Durable Objects.
- [ ] Require room existence for every subroute before persisting anything.
- [ ] Enforce content type and byte limits before `request.json()`; return `413`.
- [ ] Bound element count, serialized scene bytes, nesting, field lengths,
  access/waiting counts, sockets, and writes per interval.
- [ ] Validate email, color, viewport, role, maximum users, and permitted scene
  element types/URL schemes. Disable `iframe`, `embeddable`, image, or external
  link behavior unless explicitly required and safely allowlisted.
- [ ] Add per-principal/IP creation and request limits with `429` responses.

**Acceptance tests:** malformed/oversized IDs never instantiate a DO;
nonexistent-room subroutes persist nothing; just-over-limit bodies return
`413`; quota overflow returns `429`; hostile scenes cannot trigger external
loads or crash clients.

### SEC-006 — use cryptographic room and capability creation

**Evidence:** room and peer identifiers use `Math.random` in
`src/app/whiteboard/page.tsx:14-20` and `src/lib/whiteboard/peerId.ts:1-3`.
Anonymous callers can pre-create a chosen room and optionally claim its creator
grant in `src/lib/whiteboard/handlers/room.ts:71-104`.

- [ ] Generate at least 128 bits of randomness with a cryptographic RNG.
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

- [ ] Make creator-only deletion atomic across every room-scoped table.
- [ ] Close all room sockets and call the appropriate Durable Object storage
  deletion mechanism after responding safely.
- [ ] Tombstone IDs or prove old grants cannot authorize a recreated room.
- [ ] Set TTLs for rooms, requests, kicks, sessions, grants, and PII; purge with
  Durable Object alarms and record the retention policy.

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
removed, while workflow/runtime hardening tasks below remain open. Workflows
use Node 20, which reached EOL on 2026-03-24 according to the
[official Node.js release schedule](https://nodejs.org/en/about/previous-releases).
Secret-bearing Actions use mutable major tags; GitHub states a
[full commit SHA is the immutable form](https://docs.github.com/en/actions/reference/security/secure-use).

- [ ] Remediate the complete dependency graph and make high/critical audit
  failures blocking; exceptions require an owner and expiry.
- [ ] Build a production-only dependency stage (`npm ci --omit=dev`) and scan
  the final image, not only the lockfile.
- [ ] Move CI/build/runtime to a maintained LTS Node line and pin exact image
  digests/versions.
- [ ] Pin every GitHub Action to a verified full commit SHA.
- [ ] Scope `packages: write` to the publish job; protect production environments
  and minimize Cloudflare token permissions.
- [ ] Make both deployments depend on one required lint, typecheck, unit,
  Worker, audit, and relevant E2E/smoke gate.

**Acceptance tests:** both audit commands exit zero at `--audit-level=high`;
runtime image contains no Vite, Vitest, ESLint, Playwright, Wrangler, or
`concurrently`; image scan has no high/critical finding; CI rejects mutable
Actions and prevents deploy when any required check fails.

## P2 — privacy and defense in depth

### SEC-011 — reduce browser and WebRTC privacy exposure

**Evidence:** board content is stored in origin-wide plaintext `localStorage`
for 24 hours in `src/lib/whiteboard/persistence.ts:16-91`; kick clears only the
username. Direct WebRTC can disclose participant network metadata to peers.

- [ ] Default shared/classroom rooms to no offline board cache, or require
  explicit informed opt-in.
- [ ] Clear room, peer, and session material on leave, kick, revoke, and expiry.
- [ ] Document WebRTC IP/ICE privacy. If peer IP privacy is required, use an
  authoritative relay or managed TURN with relay-only ICE.

**Acceptance tests:** leave/kick/revoke removes all room keys; a later local user
cannot recover board data; relay-only tests show host candidates are not shared.

### SEC-012 — add response, cache, framing, and indexing protections

**Evidence:** `src/worker.ts:51-59` returns asset responses directly and handlers
have no shared hardening. Sensitive JSON has no explicit `Cache-Control`.

- [ ] Add CSP (report-only first, then enforced), `frame-ancestors 'none'`,
  `object-src 'none'`, `base-uri`, `X-Content-Type-Options: nosniff`, strict
  referrer policy, and a minimal Permissions Policy.
- [ ] Restrict CSP `connect-src` to the actual HTTPS/WSS/TURN allowlist.
- [ ] Set `Cache-Control: no-store` and appropriate `Vary` on room, presence,
  grant, and request responses.
- [ ] Add `X-Robots-Tag: noindex` to room pages.

**Acceptance tests:** headers are asserted on HTML, JavaScript, API 2xx/4xx/5xx,
and room pages; CSP E2E reports no unexpected violations; sensitive responses
are never cacheable.

### SEC-013 — minimize PII and internal error disclosure

**Evidence:** anonymous presence/waiting responses expose names and queues in
`src/lib/whiteboard/handlers/presence.ts:6-16` and
`src/lib/whiteboard/handlers/waiting.ts:5-30`; handlers return raw exception
messages, for example `src/lib/whiteboard/handlers/room.ts:115-119`.

- [ ] Return only self status and the minimum approved-user fields by default;
  expose queue/request PII only to the creator.
- [ ] Return generic 5xx bodies and log structured, redacted server details.
- [ ] Add security-event logging for auth failures, grant changes, revocation,
  rate limiting, and abnormal socket closure with retention/alert thresholds.

**Acceptance tests:** anonymous/pending/viewer responses contain no board,
queue, email, token, or unnecessary identity data; induced SQL/storage errors
never reveal internals; logs contain no raw credentials or board content.

### SEC-014 — remove configuration and debug escape hatches

**Evidence:** `src/lib/whiteboard/ywebrtcProvider.ts:37-44` accepts arbitrary
configured signaling URLs; `src/app/whiteboard/[roomId]/RoomClient.tsx:85-92`
always exposes store/provider/cursor state on `window` in production.

- [ ] In production allow only same-origin or explicitly allowlisted `wss:`
  signaling endpoints; reject credentials, fragments, insecure schemes, and
  unexpected paths.
- [ ] Expose debug globals only behind an explicit development/E2E build flag.
- [ ] Keep Cloudflare and any retained Node deployment configuration/security
  behavior identical or remove the unsupported path.

**Acceptance tests:** unsafe/misconfigured signaling URLs fail closed; production
builds contain no debug globals; parity tests exercise the same authorization,
headers, limits, and error behavior on every supported deployment.

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
  - Evidence: confirmed public exposure is documented in
    `SECURITY_INCIDENT_2026-08-17.md`. Local future-commit containment is done;
    public-history purge, visibility/notification decisions, and deployed grant
    invalidation require explicit external authority and remain incomplete. An
    independent incident verifier returned `APPROVE-AS-BLOCKED` for this status.
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
  - Evidence: independent security-architect `APPROVE-AS-BLOCKED`; every local
    Phase 0 condition passes, including the blocking 693-file tracked-tree scan,
    zero-vulnerability audits, sole Worker/Durable Object deployment, 124 unit
    tests, and 27 real-workerd tests. The gate remains open because public Git
    history, external copies, incident decisions, and deployed grant/session
    invalidation require repository/data/deployment-owner authority.

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

- [ ] Replace the parallel waiting-room and access-grant flows with one state
  machine keyed by local `account_id` (SEC-002).
- [ ] Implement the authorization matrix for every HTTP method before body
  parsing or sensitive reads; use consistent `401`, `403`, and `404` behavior.
- [ ] Split canvas writes from creator-only room settings and lifecycle routes.
- [ ] Bind creator, viewer, editor, waiting, moderation, and ban state to local
  accounts/grants rather than email, bearer hash, or client `peerId` (SEC-004).
- [ ] Remove the first-user host fallback and permit heartbeat/leave only for the
  authenticated caller's session.
- [ ] Add the complete table-driven negative authorization suite and the
  create-request-approve-join-expire-revoke E2E flow.

**Phase gate**

- [ ] Every HTTP route is mapped to the matrix; rejected operations leave all
  tables unchanged; no anonymous or pending caller receives room data or PII.

### Phase 3 — replace the peer-to-peer security boundary

- [ ] Move Yjs synchronization from direct `y-webrtc` peers to authenticated,
  server-authoritative Durable Object WebSockets (SEC-001).
- [ ] Do not create a collaboration provider before approval and authorization.
- [ ] Use a same-origin, hostname-protected WebSocket upgrade carrying the local
  session unless a documented cross-origin requirement proves that a separate
  one-time ticket is necessary (SEC-003).
- [ ] Bind every socket attachment to `account_id`, `session_id`, room grant
  version, role, and expiry; validate exact `Origin`, protocol, topic, schema,
  message size, connection count, rate, and bounded fan-out.
- [ ] Implement room kick/revoke by incrementing the grant version and closing
  matching live and hibernating sockets.
- [ ] Choose and document account-wide revocation: reliable active-room fan-out,
  or a measurable maximum delay enforced by authorization-epoch revalidation,
  short socket expiry, and forced reconnect.
- [ ] Add raw-client adversarial tests for pending reads, viewer writes, socket
  replay, wrong room/origin, malformed/oversized frames, rate abuse, kick, and
  account-wide revocation.

**Phase gate**

- [ ] Pending users receive no board bytes, viewers cannot publish, kicked users
  stop immediately, account revocation meets its documented maximum delay, and
  no direct peer path bypasses the server.

### Phase 4 — bound data, resources, and lifecycle

- [ ] Enforce room-ID, content-type, body-size, scene, field, URL, quota, and
  creation-rate limits before Durable Object allocation or JSON parsing
  (SEC-005).
- [ ] Replace security-sensitive `Math.random` values with at least 128 bits from
  a cryptographic RNG and make room creation transactional (SEC-006).
- [ ] Implement creator-only atomic deletion across every room table, close all
  sockets, and prevent old grants from authorizing recreated rooms (SEC-007).
- [ ] Add TTLs and scheduled cleanup for rooms, sessions, grants, requests,
  waiting entries, kicks, PII, and tombstones.
- [ ] Add boundary, quota, concurrent-create, injected-failure, expiry, deletion,
  and recreation tests.

**Phase gate**

- [ ] Oversized or abusive input is rejected without unwanted allocation or
  partial state; delete and expiry remove all scoped data and live access.

### Phase 5 — harden runtime, browser, privacy, and operations

- [ ] Remove or fully harden the legacy Node signaling deployment (SEC-009).
- [ ] Ship production-only dependencies on a maintained Node LTS and pin images
  and GitHub Actions immutably (SEC-010).
- [ ] Remove plaintext shared-room persistence by default and clear all local
  room/session material on leave, kick, revoke, or expiry (SEC-011).
- [ ] Add CSP, framing, content-type, referrer, permissions, cache, and indexing
  protections across assets and API responses (SEC-012).
- [ ] Minimize PII responses, replace internal error disclosure, and add
  structured redacted security-event logs and alert thresholds (SEC-013).
- [ ] Remove production debug globals, restrict signaling configuration, and
  prove parity across every retained deployment (SEC-014).

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
