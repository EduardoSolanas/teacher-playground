# Independent security audit — teacher-playground

Date: 2026-09-10
Scope: current working tree (source, configuration, CI/CD, deployment wiring)
Type: static source review with targeted runtime probes where practical
Companion documents: `security.md` (remediation backlog), `SECURITY_*.md` (per-topic decisions)

> This is an independent review, not a production penetration test. No running
> Worker, staging deployment, or live Access tenant was exercised. Findings are
> verified against the current source with file/line references; where a control
> is already documented in `security.md`, that is noted rather than repeated.

## 1. Executive summary

The application has an unusually strong security baseline for a codebase of
this size: a Cloudflare Access + local-session hybrid boundary, a server-side
authorization matrix in `RoomDO`, origin/CSRF checks, hashed opaque sessions,
guest PIN lockout, redacted logging, and enforced CSP are all present and
largely correct. This audit found **no unauthenticated authorization bypass, no
SQL injection, and no reachable script-execution XSS in the production
configuration**.

What it did find is a small number of **control bypasses on routes added after
the original hardening pass**, plus configuration and documentation drift. The
most serious are a trivial aggregate-storage-quota tamper and a scene-validation
bypass on the live Yjs write path, both reachable by an ordinary admitted editor
(which is the default role for approved students).

| ID | Severity | Finding |
| --- | --- | --- |
| SEC-A01 | High | File-quota counter can be set to any value (negative/huge) through `/files/add-bytes/`; 250 MB cap and upload accounting defeated |
| SEC-A02 | High | Yjs/WebSocket write path skips scene validation: blocked element types (`iframe`, `embeddable`, `magicframe`, `image`) and arbitrary links persist and fan out; `MAX_ELEMENTS` and snapshot budget not enforced |
| SEC-A03 | Medium | Logout and session expiry do not revoke already-open sockets; stored `sessionId` is never revalidated, contradicting documented revocation semantics |
| SEC-A04 | Medium | `waiting` reject bans an account without closing sockets or bumping `grant_version`; passive/banned/expired-grant sockets keep receiving broadcasts |
| SEC-A05 | Medium | Open redirect in `safeRedirectPath` via backslash (`/\evil.example`); exploitable where `MARKETING_HOSTNAME` is unset and in local/test |
| SEC-A06 | Medium | `npm audit --audit-level=high` currently fails: 1 critical (`next` RCE advisories), 5 high, 2 moderate |
| SEC-A07 | Medium | Disabling guest access / rotating the PIN does not revoke existing guest sessions; an admitted guest keeps board + A/V access until session TTL or manual kick |
| SEC-A08 | Medium | Deploy workflow `workflow_run` has no event-origin guard, `prod` environment has no protection rules, and deploy-time e2e is commented out |
| SEC-A09 | Low | `DELETE /auth/account` is missing from the origin/CSRF guard list |
| SEC-A10 | Low | File-quota check-then-act race; counter desync on re-PUT and on ignored `add-bytes` failure |
| SEC-A11 | Low | Secret scanner cannot see `.dev.vars` or LiveKit credentials |
| SEC-A12 | Low | Sync-frame relay amplification with no recipient role filter; abuse episode resets on reconnect |
| SEC-A13 | Low | Session-rotation endpoint exists in `IdentityDO` but is unreachable from the Worker; wiring it would reset destructive-action freshness |
| SEC-A14 | Low | `DELETE /presence` is not rate-limited and always triggers a full-room presence broadcast |
| SEC-A15 | Low | Per-account/room socket caps count non-open sockets; kick cleanup is not exception-isolated |
| SEC-A16 | Info | Documentation drift: frame-size/fan-out claims, `DEPLOY.md`, `.dev.vars` guidance |

Priority fix order: SEC-A01 and SEC-A02 (both are single-guard failures on new
routes), then SEC-A03/A04/A07 (revocation semantics), then SEC-A05/A06/A08
(quick configuration hardening).

## 2. Findings

### SEC-A01 — High — Aggregate file quota can be overwritten with arbitrary bytes

**Component:** Worker routing + `RoomDO` files section
**Status:** Verified by code trace and routing regex probe
**CWE:** CWE-1284 (improper validation of specified quantity in input), CWE-770 (allocation without limits)

The Worker intercepts board-file traffic with two regexes (`src/worker.ts:81-82`):

```ts
const ROOM_API = /^\/api\/whiteboard\/room\/([^/]+)(\/.*)?$/;
const BOARD_FILE_API = /^\/api\/whiteboard\/room\/([^/]+)\/files\/([^/]+)$/;
```

`BOARD_FILE_API` is anchored and captures exactly one segment after `/files/`,
so the internal quota route is reachable by appending a trailing slash:
`/api/whiteboard/room/<id>/files/add-bytes/` matches `ROOM_API` (subpath
`/files/add-bytes/`) and is forwarded to the Durable Object. Verified:

```text
BOARD_FILE_API match: false
ROOM_API match: true subpath: "/files/add-bytes/"
```

In `RoomDO.authorize()` the files branch derives the action from the path and
only requires board-write (`src/do/RoomDO.ts:755-769`, especially line 767):

```ts
const action = url.pathname.split('/').filter(Boolean)[2] ?? '';
...
if (action === 'check-quota' || action === 'add-bytes') return canWriteBoard(role) ? null : forbidden();
```

The handler then applies the supplied number with **no validation**
(`src/do/RoomDO.ts:966-980`, `src/lib/whiteboard/roomSchema.ts:297-299`):

```ts
const body = await request.json() as { bytes?: number };
const bytes = body.bytes ?? 0;
addFileBytes(this.db, roomId, bytes);
```

```ts
db.prepare(`UPDATE rooms SET file_bytes_total = file_bytes_total + ? WHERE room_id = ?`).run(bytes, roomId);
```

**Impact.** Any admitted editor (the default role granted at
`src/lib/whiteboard/handlers/waiting.ts:143`) — including a guest editor — can:

1. set `file_bytes_total` massively negative
   (`{"bytes":-1000000000000}`), permanently disabling the 250 MB aggregate cap
   for that room; or
2. set it above the cap to lock the room's own uploads (integrity/self-DoS).

There is also no rate limit on the file `PUT` route
(`src/worker.ts:1079-1168`), no per-room object-count cap, and the per-object
cap is only 25 MB, so the bucket can grow without bound once the counter is
tampered with. `check-quota` likewise accepts an unvalidated `incomingSize`
(`src/do/RoomDO.ts:943-964`), so the read-side arithmetic can be made to pass.

**Reproduction (authorized context):**

```http
POST /api/whiteboard/room/<roomId>/files/add-bytes/ HTTP/1.1
Origin: https://<app-host>
Content-Type: application/json
Cookie: __Host-teacher-session=<valid editor session>

{"bytes":-1000000000000}
```

**Recommendation.**

- Validate `bytes`/`incomingSize` in `add-bytes` and `check-quota`:
  `Number.isSafeInteger`, `> 0`, and a sane maximum (e.g. `MAX_BOARD_FILE_BYTES`).
- Move quota accounting where it cannot be reached from a public route: have the
  Worker compute the stored size and pass it on a dedicated internal path, or
  deny `files/*` internal actions in the outer router for all suffixes.
- Add a per-account upload rate limit and a per-room object-count cap.
- Make `add-bytes` failure a hard failure rather than a logged warning
  (`src/worker.ts:1162-1165`).

### SEC-A02 — High — Scene validation is bypassed on the live Yjs write path

**Component:** `RoomDO.webSocketMessage` → `handleSyncFrame` → projection
**Status:** Verified by full-path trace
**CWE:** CWE-20 (input validation), CWE-79 (content injection, constrained by CSP)

The HTTP scene route validates elements with `roomSceneSchema`, which rejects
`iframe`, `embeddable`, `magicframe`, and `image` types and non-https/relative
links (`src/lib/whiteboard/requestSchemas.ts:21-26, 170-223`) at
`src/lib/whiteboard/handlers/room.ts:171`.

The board's **primary** write path is now the authenticated WebSocket, and it
does not use that schema at all. `RoomDO.webSocketMessage` relays the frame and
applies it directly to the server document (`src/do/RoomDO.ts:2112-2164`):

```ts
if (isRelayableFrame(bytes)) {
  for (const peer of this.ctx.getWebSockets()) { ... peer.send(bytes); ... }
}
...
const doc = await this.getRoomDoc(attachment.roomId);
const replies = handleSyncFrame(doc, bytes, ws);
```

`handleSyncFrame` calls `syncProtocol.readSyncMessage(...)` and applies the
client update (`src/lib/whiteboard/serverSync.ts:37-42`). The document is later
projected into `rooms.elements` (`src/do/RoomDO.ts:1464-1487`), and
`getElementsFromArray` performs no type filtering
(`src/lib/whiteboard/yjsDoc.ts:184-213`). `snapshotElements` only drops
`isDeleted` entries. `MAX_ELEMENTS` is never referenced outside
`requestSchemas.ts`.

**Impact.** Any admitted editor can persist and propagate elements the
application explicitly claims to block, plus arbitrary `link` values, to every
participant and every later HTTP reader. Concretely:

- `type:"iframe"` with attacker HTML in `customData.generationData.html`
  renders as a sandboxed `srcdoc` iframe in the Excalidraw fork (with
  `allow-scripts allow-forms allow-popups ...`). In production the enforced CSP
  (`script-src 'self' 'nonce-...' 'strict-dynamic'`) blocks script execution,
  but **form submission and popups are allowed** (`form-action` is unset), so a
  phishing surface remains. In local dev, where the Worker CSP is absent,
  injected script would execute.
- `type:"image"` and arbitrary external `link`s bypass the HTTP allowlist.
- Board integrity: an `iframe`/`embeddable` element is visible to the teacher
  and cannot be prevented by the HTTP schema.

The same path also bypasses resource bounds: `MAX_ELEMENTS` is not enforced on
sync frames, and `snapshotBudgetState` is **log-only** (`src/do/RoomDO.ts:1405-1414`),
so unbounded document growth is possible (storage, memory, join latency, DO
restart loops). Sync frames are explicitly never shed by the rate limiter
(`src/lib/worker/signalingBudget.ts:45-62`), and reconnect clears the abuse
episode (`src/do/RoomDO.ts:2249-2252`), so this is not rate-bound in practice.

**Recommendation.**

- Validate element maps server-side before relay/persist: run the existing
  `sceneElementSchema` (or a lightweight type/link/size projection) over
  `getElementsFromArray` output in `flushProjection` and reject/scrub disallowed
  types before storing or fanning out.
- Enforce a per-room element count and serialized-document budget on the sync
  path; treat `snapshotBudgetState !== 'fine'` as a write refusal, not a log.
- Consider `frame-src 'none'` in the CSP as defense in depth (breaks legitimate
  embeddables only, which this app already blocks on the HTTP path).

### SEC-A03 — Medium — Logout and session expiry do not revoke live sockets

**Component:** `RoomDO` socket attachment + IdentityDO session store
**Status:** Verified; contradicts `security.md` SEC-003/SEC-004 evidence and the
`SECURITY_REVOCATION_BOUND.md` claims referenced there

At upgrade, the Worker stamps the session hash and it is stored on the socket
attachment (`src/do/RoomDO.ts:1598-1644`):

```ts
const sessionId = url.searchParams.get('sessionId');
if (!accountId || !sessionId || ...) return new Response('Unauthorized', { status: 401 });
...
const identity: SocketIdentity = { accountId, sessionId, authorizationEpoch: epoch, roomId, grantVersion: ... };
```

`sessionId` is **never read again** (grep confirms only lines 261, 1599, 1601,
1639). The periodic revocation alarm checks only account state and epoch
(`src/do/RoomDO.ts:1852-1906`), and the per-message guard checks only grant
version and room role (`src/do/RoomDO.ts:1940-1950`). Session TTLs are not on
the attachment.

`logoutSession` revokes the session row but does not advance the account epoch
or notify room objects (`src/lib/identity/sessionStore.ts:579-592`). Account
state stays `active` and the epoch unchanged, so the alarm's comparison passes.

**Impact.** A socket opened before logout — including one opened with a copied
cookie — keeps read/write board access after `POST /auth/session/logout`, after
the 30-minute idle TTL, and after the 12-hour absolute TTL, until kick, account
disable, DO eviction, or client disconnect. This contradicts `security.md:265-271`,
which requires local logout to take effect on already-open real-time connections;
`SECURITY_REVOCATION_BOUND.md` documents in-room kick (0 s) and account-wide
disable (≤30 s) but leaves logout and session expiry unspecified.

**Recommendation.** Pick one:

- revalidate `attachment.sessionId` against IdentityDO in the alarm (batch by
  account), or
- carry the session's absolute expiry in the attachment and close on expiry,
  and bump the account epoch on logout (making logout equal to a soft
  revoke-all), or
- have IdentityDO fan out a close signal for the session hash.

### SEC-A04 — Medium — Waiting-reject bans do not close sockets or bump grants

**Component:** `handleWaitingPost` + `RoomDO` post-handler + binary relay
**Status:** Verified by code trace

`waiting` reject bans the target account and clears its peers
(`src/lib/whiteboard/handlers/waiting.ts:170-177`):

```ts
if (action === 'reject') {
  db.transaction(() => { banAccount(db, roomId, target.accountId); clearAccountPeers(db, roomId, target.accountId); })();
  return Response.json({ success: true });
}
```

Unlike the `presence` kick/suspend path, the `RoomDO` post-handler only
broadcasts presence for `waiting` POST — it does not call
`incrementGrantVersion`/`closeAccountSockets` (`src/do/RoomDO.ts:503-516` vs
`545-553`). `resolveModerationTarget` accepts any known account — including an
already-granted editor/viewer — so this path can ban a live participant
(`src/lib/whiteboard/membership.ts:456-505`).

Compounding this, the binary relay fans frames out to **every** socket without
a role filter (`src/do/RoomDO.ts:2123-2138`), and the alarm does not re-check
the room role (`src/do/RoomDO.ts:1852-1906`). The per-message guard only runs
when the socket *sends* (`src/do/RoomDO.ts:1940-1950`).

**Impact.** A banned account (and, on the same reasoning, an account whose
editor grant expired and was purged by `purgeExpiredGrants` at
`src/do/RoomDO.ts:1822-1824`) that remains passively connected keeps receiving
board and presence broadcasts. A viewer never sends, so it can stay live
indefinitely. This contradicts the documented "in-room ban 0 s" bound for this
path.

**Recommendation.** Make every ban path bump `grant_version` and close the
target account's sockets (share the existing kick logic in `RoomDO`); also
role-filter relay recipients or re-check `getGrantRole`/expiry in the alarm.

### SEC-A05 — Medium — Open redirect in `safeRedirectPath` (backslash)

**Component:** `/auth/access/logout` (and the client logout helper)
**Status:** Verified with a WHATWG URL probe
**CWE:** CWE-601 (open redirect)

```ts
// src/lib/access/accessLogoutUrl.ts:8-12
export function safeRedirectPath(path: string | null | undefined): string {
  if (!path || !path.startsWith('/') || path.startsWith('//')) return '/';
  if (path.includes('..')) return '/';
  return path;
}
```

The check does not reject backslashes or control characters. Browsers normalize
`\` to `/` when resolving a `Location` header, so `/\evil.example` becomes the
protocol-relative URL `//evil.example`:

```text
"/\\\\evil.example" -> "/\\\\evil.example" -> Location resolves to https://evil.example/
```

`?redirect=%2F%5Cevil.example` reaches `safeRedirectPath` decoded and is emitted
verbatim in `Location` by `accessLogoutResponse` (`src/worker.ts:833-860`).

**Impact.** The production branch currently replaces the target with the
marketing host when `MARKETING_HOSTNAME` is set (`src/worker.ts:855-858`, set in
`wrangler.toml`), so this is latent in production. It is exploitable in
`local-test` and in any deployment that unsets `MARKETING_HOSTNAME`; the client
helper `accessLogoutUrl` also propagates it. An open redirect on a
logout/auth-adjacent endpoint is a phishing primitive.

**Recommendation.** Reject anything outside a strict path charset (no `\`, no
`%00`, no control characters), or allowlist the known post-logout destinations.
Add the backslash/tab cases to `accessLogoutUrl.test.ts`.

### SEC-A06 — Medium — Dependency audit is currently failing

**Component:** `package.json` / `package-lock.json`
**Status:** Verified by `npm audit --audit-level=high` on this tree

```text
8 vulnerabilities (2 moderate, 5 high, 1 critical)
```

- **critical** `next@16.3.1` (fix ≥ 16.3.3): GHSA-p293-qw3h-jr36 unauthenticated
  RCE on Windows-hosted Next servers; GHSA-2xp9-vwfh-vxw4 RCE in the Image
  Optimization API (AVIF).
- **high** `js-yaml@4.3.1` (fix ≥ 4.3.2, dev tooling).
- **high** `sharp@0.35.3` via `miniflare`/`wrangler` (fix ≥ 0.35.4, dev/test).
- **moderate** `vitest@4.1.6` / `@vitest/mocker` (fix ≥ 4.1.11, dev only).

Production reachability is limited: the app is a static export
(`next.config.js`, `output: 'export'`, `images.unoptimized`) deployed as a
Cloudflare Worker, so no Next server or Image Optimization endpoint runs in
production. The critical Next advisory is still material for local Windows
development and for any future server-rendering work. Because
`.github/workflows/ci.yml` runs `npm audit --audit-level=high` as a blocking
step, CI itself is currently red until these are bumped.

**Recommendation.** Bump `next` ≥ 16.3.3, `js-yaml` ≥ 4.3.2, `vitest` ≥ 4.1.11,
and refresh `wrangler`/`miniflare` for `sharp`. Re-run both audit commands and
confirm CI is green.

### SEC-A07 — Medium — Guest access revocation does not revoke existing guest sessions

**Component:** guest PIN / guest session validation
**Status:** Verified; the "disabled" worker test covers a room that never
enabled guest access, not this transition

`revokeGuestAccess` sets `guest_access = 0` and nulls the PIN
(`src/lib/whiteboard/guestPin.ts:139-146`); `rotateGuestPin` only changes the
PIN (`src/lib/whiteboard/guestPin.ts:121-133`). Guest-session validation never
consults the room row:

```ts
// src/lib/identity/sessionStore.ts:767-791
const session = await validateSession(db, token, now);
...
if (!account || account.provenance !== 'guest' || account.guestRoomId !== roomId) return null;
return session;
```

The Worker even reuses an existing guest session before checking the PIN
(`src/worker.ts:315-327`). Because a granted guest holds an editor membership,
disabling guest access or rotating the PIN does not stop an already-admitted
guest from reading/writing the board, minting A/V tokens, or continuing an
open socket, until the session TTL (30 min idle / 4 h absolute) or a manual
kick.

**Recommendation.** Decide and document the intended semantics; if "disable"
should end access, revoke guest sessions/accounts bound to the room (or check
`rooms.guest_access` in `authorizeGuestSession`), and close their sockets. Add a
worker test for disable-after-admission and PIN-rotation-after-admission.

### SEC-A08 — Medium — Deploy workflow trust and gating gaps

**Component:** `.github/workflows/deploy-cloudflare.yml`
**Status:** Verified by reading the workflow

- The `workflow_run` trigger only filters `branches: [main]` and success
  (`deploy-cloudflare.yml:3-22`); it does not assert
  `github.event.workflow_run.event == 'push'` or
  `head_repository.full_name == github.repository`. The checkout defaults to the
  triggering run's head SHA, and the job receives the Cloudflare API token.
  GitHub security guidance recommends explicit event-origin verification for
  privileged `workflow_run` workflows.
- `environment: prod` is referenced (line 21) but the environment has no
  protection rules (no required reviewers or wait timer), so a green run
  deploys without human approval.
- Playwright e2e is commented out of the deploy pipeline
  (`deploy-cloudflare.yml:88-104`, "TEMP: e2e skipped"), so browser/HTTP/session
  changes can reach production without the e2e gate that `AGENTS.md` requires
  for such changes.

**Recommendation.** Add the event-origin conditions to the job `if:`, add
required reviewers on the `prod` environment, and restore (or make required)
the e2e job in the deploy path.

### SEC-A09 — Low — `DELETE /auth/account` missing from the origin/CSRF guard

`originGuard` covers `/auth/session`, `/auth/session/logout`,
`/auth/session/confirm`, `/auth/account/profile`, `/auth/guest`, all `/api/*`,
and `/signaling` (`src/worker.ts:244-261`). `ACCOUNT_ERASE = '/auth/account'`
(`src/worker.ts:90`, routed at `987-989`) is **not** in that list, so account
erasure is the one cookie-authenticated mutation without the exact-Origin
check. `__Host-teacher-session` is `SameSite=Lax` and HTML forms cannot send
`DELETE`, so modern browsers provide a compensating control; the documented
claim that the guard runs on every non-GET/HEAD path is nonetheless false.
**Fix:** add `ACCOUNT_ERASE` to the guarded set.

### SEC-A10 — Low — File-quota check-then-act race and counter desync

The upload flow reads the counter (`check-quota`), writes to R2, then increments
(`add-bytes`) across network awaits with no per-room serialization
(`src/worker.ts:1106-1166`). Concurrent PUTs can all pass the check and exceed
the aggregate cap by roughly (N−1) × 25 MB. Re-PUT of a content-addressed key
adds `stored.size` again although R2 storage did not grow, and an `add-bytes`
failure is only logged (`src/worker.ts:1162-1165`). The orphan sweep floors the
counter at zero (`roomSchema.ts:309-313`), so drift is contained but real.
**Fix:** reserve bytes before the R2 put (or reconcile from bucket listings),
and make the increment mandatory.

### SEC-A11 — Low — Secret scanner cannot detect `.dev.vars` or LiveKit keys

`scripts/security-scan.mjs` classifies only `.env*` files
(`isNonExampleEnvironmentFile`, lines 38-41), and its credential patterns
(lines 47-58) cover AWS/GitHub/Google/Slack/OpenAI/Cloudflare but not LiveKit.
A committed `.dev.vars` containing a live `LIVEKIT_API_SECRET` would pass
`npm run security:scan` and Semgrep (which respects `.gitignore`, so it is not
scanned either). No secret is currently tracked — `.dev.vars` exists locally and
is ignored via `.gitignore` (`.dev.vars*`) — but the detection gap remains.
**Fix:** match `.dev.vars`/`.dev.vars.*` in the filename rule and add
`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` assignment patterns (plus a regression
test).

### SEC-A12 — Low — Sync-frame relay amplification and abuse-episode reset

Sync (type 0) frames up to 32 MiB are relayed byte-for-byte to every other open
socket (up to 31 peers) and are never shed (`src/lib/whiteboard/signalingBudget.ts:45-62`,
`src/do/RoomDO.ts:2125-2138`). The abuse close requires a sustained episode
(`src/do/RoomDO.ts:1993-2040`), and the breach counter is deleted when the
flooding account's last socket closes (`src/do/RoomDO.ts:2249-2252`), so a
reconnect starts a fresh episode. This is bounded by client bandwidth but is a
real egress/memory amplifier for a hostile editor. **Fix:** cap per-frame relay
budget per room/window, and keep the breach state for a cooldown across
reconnects.

### SEC-A13 — Low — Unreachable session rotation; freshness semantics

`IdentityDO` exposes `/sessions/rotate` (`src/do/IdentityDO.ts:57, 364-378`),
but the Worker defines no route for it, so sessions never rotate despite
`security.md` evidence citing rotation. Separately, `rotateSession` inserts the
replacement with `createdAt = now` (`src/lib/identity/sessionStore.ts:187-220,
371-406`), and `sessionAllowsDestructiveAction` treats a session younger than
5 minutes as fresh. If rotation is ever wired to the public API, rotating would
reset the destructive-action step-up clock. **Fix:** either remove the unused
endpoint or preserve the original issue timestamp across rotation and expose it
as an explicit re-authentication step only.

### SEC-A14 — Low — `DELETE /presence` is unthrottled and always broadcasts

The presence limiter applies only to `POST /presence`
(`src/worker.ts:1266-1269`); `DELETE /presence` always triggers
`broadcastPresence`, which rebuilds and sends a per-recipient payload to every
socket (`src/do/RoomDO.ts:540-543, 1519-1564`). A granted account can loop
leave requests for a small HTTP→WebSocket amplification. **Fix:** share the
presence rate limit with DELETE and skip the broadcast when no row changed.

### SEC-A15 — Low — Socket caps count non-open sockets; kick cleanup not isolated

`countAccountSockets` counts every socket returned by `getWebSockets()` without
filtering `readyState === OPEN` (`src/do/RoomDO.ts:1509-1516`), and the upgrade
cap checks use the raw list (`src/do/RoomDO.ts:1623-1631`). If workerd returns
closed-but-not-reaped sockets, connection churn can transiently exhaust the
per-account (4) or per-room (32) caps. `closeAccountSockets`
(`src/do/RoomDO.ts:1015-1023`) also calls `deserializeAttachment()` without a
per-socket try/catch, unlike the other loops, so one bad attachment can abort
the close loop. These are defense-in-depth observations, not confirmed
exploits.

### SEC-A16 — Info — Documentation drift

- `security.md` SEC-003 still says "Frame size 1 MiB" and "message rate 60/s";
  the code is `MAX_WS_FRAME_BYTES = 32 * 1024 * 1024`
  (`src/lib/worker/requestGuard.ts:217`) and
  `SIGNALING_MAX_MESSAGES_PER_WINDOW = 120` (`requestGuard.ts:236`).
- `security.md` says binary fan-out reaches "only `canWriteBoard` peers"; the
  binary relay is unfiltered (see SEC-A04), while the JSON `publish` path does
  filter.
- `DEPLOY.md` says `wrangler.toml` declares no route/custom domain, but it
  declares three custom domains; the documented Excalidraw CDN release
  (`tp.6`) does not match the code/lockfile (`tp.11`).
- `security.md` cites session rotation as implemented; it is unreachable.
- `src/lib/whiteboard/sanitize.ts` `sanitizeHtml`/`sanitizeText` are unused
  dead code; `sanitizeHtml` uses `innerHTML` as an escaping primitive and is
  safe today but is a inviting base for future misuse.
- `src/app/layout.tsx:36-40` interpolates a build-time env value into an inline
  script via `JSON.stringify` without escaping `<`; only build-config control
  is required to exploit, but escaping `</script>` is cheap hardening.
- LiveKit `LIVEKIT_URL` is used to build admin fetch URLs without scheme/host
  validation (`src/lib/av/livekitRoomService.ts:17-28`,
  `src/lib/av/livekitToken.ts:175-182`); a malformed deployment value (e.g.
  `http://169.254.169.254`) would be fetched with an admin bearer token. This
  requires env control, so it is configuration hardening only.

## 3. Verified controls (spot-checked, no finding)

- Access JWT verification: RS256 pinned, exact issuer, audience containment,
  required `exp`/`nbf`/`iat`, `type=app`, service-token rejection, bounded
  rotation-aware JWKS, no algorithm confusion
  (`src/lib/access/accessVerifier.ts:161-329`).
- Sessions: `__Host-` Secure/HttpOnly/SameSite cookies, 256-bit tokens stored
  only as SHA-256 hashes, idle/absolute TTLs, revoke-all/disable bumping the
  account epoch, first-login convergence without email linking
  (`src/lib/identity/sessionStore.ts`, `identityStore.ts`).
- Worker→DO trust boundary: `forward()` overwrites `roomId`/`accountId`/
  `accountEpoch`/`sessionId`/`guest` and strips identity headers; DO is
  reachable only through the binding (`src/worker.ts:766-804`,
  `src/lib/worker/requestGuard.ts:246-269`).
- Authorization matrix: `RoomDO.authorize` covers every route; 401 vs 403
  semantics consistent; viewer writes answered read-only; kick/suspend bumps
  `grant_version` and closes sockets 4401 (`src/do/RoomDO.ts:606-772, 503-516`).
- SQL: all dynamic SQL identifiers resolve to hardcoded constants; user values
  are bound parameters. No injection found.
- XSS: no reachable script-execution sink in production; enforced CSP with
  nonces, `object-src 'none'`, `frame-ancestors 'none'`, no wildcard
  `connect-src`; Excalidraw link rendering is sanitized
  (`src/lib/worker/requestGuard.ts:428-487`).
- Guests: 6-digit CSPRNG PIN, constant-time compare, per-room lockout, per-IP
  join limit, identical generic failures, `/guest-verify` not publicly routable
  (`src/lib/whiteboard/guestPin.ts`, `src/worker.ts:1237-1240`).
- Destructive actions: `DELETE /room` and account erasure require recent
  re-confirmation (`sessionAllowsDestructiveAction`).
- LiveKit: HS256 tokens minted server-side only for granted roles, identity
  forced to the verified account, viewer cannot publish, secrets stay in Worker
  bindings, short TTLs.
- Logging: generic 5xx bodies; structured logs redact emails/JWT/Bearer/board
  elements.

## 4. Prioritized remediation plan

| Order | Action | Findings |
| --- | --- | --- |
| 1 | Validate quota numbers; close internal `files/*` routes to the public router; rate-limit uploads | SEC-A01, SEC-A10 |
| 2 | Validate Yjs element maps before relay/persist; enforce document budget on the sync path | SEC-A02, SEC-A12 |
| 3 | Revalidate session/grant state on open sockets; close on logout, ban, and expiry | SEC-A03, SEC-A04 |
| 4 | Hardening fixes: redirect charset, origin guard for `/auth/account`, guest revocation, secret-scan patterns | SEC-A05, SEC-A07, SEC-A09, SEC-A11 |
| 5 | Bump vulnerable dependencies; restore e2e in deploy; add workflow origin guard and environment protection | SEC-A06, SEC-A08 |
| 6 | Cleanup: rate-limit `DELETE /presence`, socket cap filtering, exception-isolated kick, remove or wire rotation, refresh docs | SEC-A13–A16 |

Every authorization/validation fix above should ship with a failing test first
(workers test under `src/do/*.workers.test.ts` for DO paths, browser e2e for the
UI) and one targeted mutation per new guard, per `AGENTS.md`.

## 5. Method, commands, and limitations

Activities performed for this review:

- Read `security.md`, all `SECURITY_*.md` decision documents, `AGENTS.md`,
  `package.json`, `wrangler.toml`, workflow files, and the core source paths
  (`src/worker.ts`, `src/do/RoomDO.ts`, `src/do/IdentityDO.ts`,
  `src/lib/identity/*`, `src/lib/access/*`, `src/lib/whiteboard/**`,
  `src/lib/worker/*`, `src/lib/av/*`).
- Routing-regex probe confirming the SEC-A01 path
  (`BOARD_FILE_API` false / `ROOM_API` true for `/files/add-bytes/`).
- WHATWG URL probe confirming the SEC-A05 open redirect
  (`/\evil.example` → `https://evil.example/`).
- `npm audit --audit-level=high` (via `npm.cmd`) for SEC-A06.
- GitHub REST query against the public repository confirming the `prod`
  environment currently has no protection rules (SEC-A08).
- File inspection confirming `.dev.vars` exists, is ignored by `.gitignore`,
  and is not detected by `scripts/security-scan.mjs`.

Limitations:

- No application test suite (`npm test`, `npm run test:workers`,
  `npm run test:e2e`), lint, or typecheck was run for this report; these are
  static findings and should be reproduced with tests before remediation is
  claimed complete.
- `git` is installed at `C:\Program Files\Git\cmd\git.exe` but is not on the
  shell `PATH`; it needs a `safe.directory` override for this checkout. History
  and branch checks ran with that override, and `git status`/`git diff --check`
  are runnable the same way.
- No live Worker, staging Access tenant, or browser session was exercised; no
  production penetration test was performed.
- Findings rely on the current working tree and may not reflect deployed state.

Remediation of any finding should follow `AGENTS.md` strict TDD: failing test
first, smallest fix, targeted mutation for each changed guard, then unit +
workers + typecheck, and e2e for browser/HTTP/session-reachable changes.

## 6. Remediation status (2026-09-10)

Added after the audit, the same day, to record which findings have been fixed
and independently verified. The findings above are the original evidence and
are not restated; where this section and a finding disagree, this section is
current.

Verification standard: every fix below started red — a failing test written
before the guard existed. Each new or changed guard was mutation-tested one
guard at a time (weaken the guard, require the protecting suite to fail against
the weakened guard, restore the guard, confirm green). A separate agent then
independently verified each fix in an isolated checkout; `APPROVE` below is
that verifier's verdict. SEC-A01/A10 were rejected twice and SEC-A02 once
before their final fixes were approved.

| ID | Status | Fix and regression tests | Verdict |
| --- | --- | --- | --- |
| SEC-A05 | Fixed | `safeRedirectPath` refuses backslashes and control characters (`src/lib/access/accessLogoutUrl.ts:13`); test `accessLogoutUrl.test.ts:23`. | APPROVE |
| SEC-A06 | Fixed | `next` 16.3.1→16.3.3, `vitest`/`@vitest/mocker` 4.1.6→4.1.11, `js-yaml` 4.3.1→4.3.2, and a `sharp` `^0.35.4` override (miniflare pinned 0.35.2) in `package.json`/`package-lock.json`. Scope checked: no git-tarball change, no downgrade, every tarball integrity-pinned. `npm audit --audit-level=high` and `--omit=dev` both report 0 vulnerabilities; `npm ci` reproduces. | APPROVE |
| SEC-A07 | Fixed | With guest access off, every guest HTTP section except `guest-verify` returns **403** before role handling (`src/do/RoomDO.ts:501-503`) and a guest signaling upgrade is refused (`src/do/RoomDO.ts:1822-1827`); turning `guestAccess` off closes live guest-stamped sockets in the owner's settings request (`src/do/RoomDO.ts:616-632`, `closeGuestSockets` at `1170-1182`). PIN rotation stays **new-joins-only** by design (`src/do/RoomDO.ts:622-631`). Tests `guestSignaling.workers.test.ts:254,276,308`. | APPROVE |
| SEC-A09 | Fixed | `isOriginGuardedPath` covers `/auth/account` and its subpaths (`src/lib/worker/requestGuard.ts:196-207`), wired at `src/worker.ts:247`; tests `requestGuard.test.ts:264`, `worker.access.workers.test.ts:209`. | APPROVE |
| SEC-A11 | Fixed | Scanner treats `.dev.vars*` as a non-example environment file and matches `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` assignments (`scripts/security-scan.mjs:42,60-61`); tests `securityScan.test.ts:125,148`. | APPROVE |
| SEC-A14 | Fixed | `POST` and `DELETE /presence` share the per-account limiter (`src/worker.ts:1326-1334`); DELETE broadcasts only when the roster signature changes (`src/do/RoomDO.ts:582-591`). Route matching now normalizes all empty path segments (`src/worker.ts:1280-1288`, canonical refusal `src/do/RoomDO.ts:1020-1022`), closing the trailing-slash/double-slash bypass class for the destructive-action re-auth gate and the create/requests limiters as well. Tests `worker.access.workers.test.ts:857,896,1494`, `roomDelete.workers.test.ts:577`, `roomPresenceSocket.workers.test.ts:155,215`. | APPROVE |
| SEC-A01, SEC-A10 | Fixed | Public `/files` subtree refused (`src/worker.ts:1294-1296`); internal actions are `reserve`/`settle` with validated safe integers and atomic per-room accounting (`src/do/RoomDO.ts:1010-1110`). Immutable-size overwrite policy — 409 on a different size, no replacement credits — removes the concurrency undercount; a same-size re-PUT is free (`src/worker.ts:1138-1156`), and a post-put size mismatch deletes the object and releases the reservation (`src/worker.ts:1204-1210`). Tests `roomFileQuota.workers.test.ts`, `worker.access.workers.test.ts:1447,1494,1588`. | APPROVE after two REJECT rounds |
| SEC-A02 | Fixed | `sanitizeSceneDoc` (`src/lib/whiteboard/sceneGuard.ts`) scrubs `iframe`/`embeddable`/`magicframe`, unsafe or non-string links, and non-map entries, and enforces `MAX_ELEMENTS`; `RoomDO` applies it to the server document and relays only the server-produced sanitized diff (`src/do/RoomDO.ts:2388-2427`). `image` intentionally remains allowed because room-scoped R2 board images depend on it; the MIME allowlist excludes SVG (`src/lib/whiteboard/boardFiles.ts:8-13`). Tests `sceneGuard.test.ts`. | APPROVE after one REJECT round |
| SEC-A03 | Fixed | The alarm sends each open socket's `{accountId, sessionId}` to IdentityDO `POST /accounts/authorizations` and closes **4401** when the session hash is absent (`src/do/RoomDO.ts:2135-2156`); IdentityDO answers with `activeSessionHashes` from `selectActiveSessionHashes`, which omits revoked, idle-expired, absolute-expired, and mismatched-pair sessions (`src/do/IdentityDO.ts:546-564`, `src/lib/identity/sessionStore.ts:309-337`). Tests `socketRevocation.workers.test.ts:90`, `identityDO.workers.test.ts:731,768`. | APPROVE |
| SEC-A04 | Fixed | A waiting-queue reject bumps `grant_version`, closes the banned account's sockets, and re-stamps the rest inside the owner's request (`src/do/RoomDO.ts:593-609`), and the alarm closes sockets whose editor grant has lapsed (`src/do/RoomDO.ts:2142-2156`). Every fan-out path filters recipients by attachment account plus granted role: presence (`src/do/RoomDO.ts:1714-1768`), follow/call (`1184-1210`), the sanitized sync diff (`2411-2424`), the raw awareness relay (`2437-2451`), and the server-generated cursor-sweep/clear frames via `broadcastToRoom` (`1396-1407`). Tests `socketRevocation.workers.test.ts:112,134,252,285,316,347`. | APPROVE; the `broadcastToRoom` residual was fixed and re-verified APPROVE |
| SEC-A12 | Fixed | Breach episode survives socket close (`src/do/RoomDO.ts:2248-2289`, `2555-2561`); stale entries are pruned in the alarm (`src/do/RoomDO.ts:2016,2521-2527`). Tests `roomDO.workers.test.ts:854,922`. | APPROVE |
| SEC-A08 | Partially fixed | Deploy job requires a same-repository, push-triggered successful CI run on the `workflow_run` path (`.github/workflows/deploy-cloudflare.yml:22`; test `src/deployment/deploymentPolicy.test.ts:480`), whose CI e2e job is blocking (`.github/workflows/ci.yml:60-96`); the workflow also accepts `workflow_dispatch` (`.github/workflows/deploy-cloudflare.yml:8`), which bypasses that CI gate. The GitHub `prod` environment protection rules still need repository settings and cannot be set from code. | APPROVE for the workflow guard |
| SEC-A13 | Fixed | `rotateSession` preserves the original `createdAt` and `absoluteExpiresAt` (`src/lib/identity/sessionStore.ts:429-457`); tests `sessionStore.test.ts:200,217`, `identityDO.workers.test.ts:329`. | APPROVE |
| SEC-A15 | Fixed | `countAccountSockets` counts only `readyState === OPEN` sockets (`src/do/RoomDO.ts:1668-1677`) and the upgrade caps filter to open sockets (`src/do/RoomDO.ts:1834-1845`). `closeAccountSockets` isolates each socket's `deserializeAttachment()` in its own `try`/`catch` (`src/do/RoomDO.ts:1148-1163`); that isolation is hardening without a dedicated regression test (untested). Tests for the counting fix: `socketRevocation.workers.test.ts:159-225`. | APPROVE |

Still open at this date: only the GitHub `prod` environment protection rules
required by SEC-A08, which no code change can set (repository settings task).
All other findings are fixed and independently verified `APPROVE`.

Final orchestrator run on the frozen tree (2026-09-10): `npm test` 1362/1362,
`npm run test:workers -- --no-file-parallelism` 442/442, `npm run typecheck`
clean, `npm run test:e2e` 158/158, `npm run security:scan` passed (481 files),
`npm audit --audit-level=high` and `--omit=dev` 0 vulnerabilities,
`git diff --check` clean. The orchestrator additionally re-killed one mutant per
fixed guard family (scene guard blocked-type, origin-guard `/auth/account`,
alarm session-hash revalidation) and restored each from byte backups.
