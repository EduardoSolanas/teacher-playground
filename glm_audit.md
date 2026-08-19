# Security Audit — `glm_audit.md`

**Target:** `teacher-playground` (D:\new-projects\teacher-playground), branch `main` @ `64b2752`, **current working tree** (includes uncommitted guest-feature work in progress — see GLM-03).
**Date:** 2026-08-19
**Method:** Static source review per the security-research skill (attack-surface mapping, auth/data-isolation hunt, runtime/supply-chain hunt), cross-referenced against `security.md` (SEC-001–SEC-017 remediation ledger) and `SECURITY_INCIDENT_2026-08-17.md`. All findings are evidence-backed with file:line quotes. No dynamic exploitation was run (see *Residual risk*).

---

## Verdict

**PASS WITH FINDINGS** — no exploitable P0/P1 vulnerability found in the current tree. One new Medium hygiene finding (GLM-01), one new Low–Medium authorization-consistency finding (GLM-02), and one forward-looking finding on in-flight work (GLM-03). Everything else candidates-wise was falsified, downgraded, or is already tracked in `security.md` (cross-reference table below).

The core security architecture is unusually disciplined for this class of app: fail-closed RS256 Access JWT verification, a server-stamped principal on every internal DO hop, a per-route role matrix enforced before body parsing, per-account rate budgets, and mutation-tested guards with recorded evidence.

---

## Scope

- **Commands run:** `git status`, `git diff` (uncommitted guest feature), `git ls-files`, `git check-ignore .dev.vars`, `Test-Path` checks, full reads of `src/worker.ts`, `src/do/RoomDO.ts`, `src/do/IdentityDO.ts`, `src/lib/access/accessVerifier.ts`, `src/lib/identity/sessionStore.ts` (+uncommitted diff), `src/lib/worker/requestGuard.ts` (+diff), `src/lib/av/handleAvToken.ts`, `src/lib/av/livekitToken.ts`, `src/lib/whiteboard/membership.ts`, `src/lib/whiteboard/roomSchema.ts` (+diff), `wrangler.toml`, `.gitignore`, `scripts/local-access-issuer.mjs`, `security.md`, `guest_implementation.md`.
- **Not run:** test suites (the tree is being concurrently edited mid-TDD by other sessions — a suite run would measure their in-flight work, not a stable baseline), network calls, LiveKit/Cloudflare APIs, `npm audit` (offline).
- **Trust boundaries examined:** edge (marketing allowlist → Access JWT → origin guard → body caps → rate limits) → Worker→DO internal hop (query-stamp + header strip) → RoomDO role matrix → per-room SQLite; `/signaling` WebSocket upgrade + hibernation revalidation; IdentityDO session authority; LiveKit token minting; local dev issuer.

---

## Findings

| ID | Severity | Title | CWE | Exploitability | Impact | Fix effort |
|----|----------|-------|-----|----------------|--------|------------|
| GLM-01 | Medium | `.dev.vars` (documented LIVEKIT secret file) is not gitignored | CWE-798 (exposure path) | Any user following README §"Local smoke steps" then `git add .` | LiveKit API secret committed to history; persistent credential exposure | 1 line |
| GLM-02 | Low–Med | LiveKit join token grants full publish rights to read-only `viewer` role | CWE-284 | Any admitted viewer calls `POST /api/av/token`, connects, publishes audio/video/data | Contradicts the read-only grant; a "viewer" student can share camera/mic | Small |
| GLM-03 | Low (today) | In-flight guest-PIN feature: dormant-but-growing unauthenticated surface; wiring order and config are load-bearing | CWE-284 / CWE-668 | Requires future wiring (Task 8) to become reachable | Anonymous account minting if `/guests/issue` is ever routed without the RoomDO PIN check | Checklist |

### GLM-01 — `.dev.vars` is not gitignored while being the documented secret store

**Evidence:**
- `git check-ignore .dev.vars` → exit code **1** (not ignored). File does not currently exist (`Test-Path` → False) and is not tracked, so nothing is exposed *today*.
- `.gitignore` covers `.env*` and `!.env*.example` — this glob does **not** match `.dev.vars` (different prefix).
- `README.md` (A/V section): "Copy `.env.local.example` → `.dev.vars` … fill the three `LIVEKIT_*` values"; `security.md` §Running locally: "A/V needs `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` in `.dev.vars`".
- `security.md` SEC-008 claims "[x] Ignore `.wrangler/`, **non-example environment files** …" — that claim is verifiably incomplete for the wrangler-specific filename.

**Attack path:** developer follows the documented A/V setup → `.dev.vars` contains `LIVEKIT_API_SECRET` → any later `git add .` / `git add -A` stages the secret → push exposes the LiveKit project credential permanently (history rewrite required, cf. the 2026-08-17 `.data` incident this repo already went through).

**Severity rationale:** Medium — requires a human mistake, but the mistake *is* the documented workflow, secrets in git are persistent damage, and this exact class of incident already occurred in this repository once.

**Minimal fix:** append to `.gitignore`:
```
.dev.vars
.dev.vars.*
!.dev.vars.example
```
**Regression check:** extend `src/deployment/deploymentPolicy.test.ts` with an assertion that `git check-ignore .dev.vars` succeeds (same pattern the repo already uses to forbid `signaling-server.mjs` and `.data/` tracking).

### GLM-02 — Viewer-role LiveKit tokens carry full publish grants

**Evidence:** `src/lib/av/livekitToken.ts:79-84`:
```ts
const video: LiveKitGrant & { room: string } = {
  canPublish: input.grant?.canPublish ?? true,
  canSubscribe: input.grant?.canSubscribe ?? true,
  canPublishData: input.grant?.canPublishData ?? true,
  roomJoin: input.grant?.roomJoin ?? true,
  room: input.room,
};
```
`src/lib/av/handleAvToken.ts:81-87` calls `buildLiveKitToken` **without a `grant` override**, so every eligible role — including `viewer` — receives `canPublish: true`, `canPublishData: true`. Eligibility (`avEligible`) admits all granted roles; `RoomDO.authorize` (`av` section, `src/do/RoomDO.ts:385-388`) allows `isGrantedRole` → viewer included. Identity and room are correctly forced (verified, no finding).

**Attack path:** owner admits a participant as `viewer` (read-only board) → that participant POSTs `/api/av/token` (allowed) → joins LiveKit → publishes camera/mic/data-channel media to the room for the token TTL. The board's read-only boundary does not extend to media.

**Severity rationale:** Low–Medium — no data disclosure beyond what the viewer already receives, but it silently contradicts the authorization matrix's viewer semantics, matters doubly with minors (SEC-016/017 context), and partially overlaps the unchecked Phase-10 item "screen share is host-approved per instance" (which names screen share, not this general publish right).

**Minimal fix:** in `mintTokenResponse`, pass `grant: { canPublish: role !== 'viewer', canPublishData: role !== 'viewer', canSubscribe: true, roomJoin: true }` (role already resolved in `issueAvTokenResponse`).
**Regression check:** unit test in `livekitToken.test.ts`/`handleAvToken` tests asserting a decoded viewer token has `canPublish === false`; negative test that an editor token keeps it `true`.

### GLM-03 — Guest-PIN feature (uncommitted): sound threat model, load-bearing wiring and config

The uncommitted work implements `guest_implementation.md` (Tasks 1–7 partially landed: room schema columns, `guestPin.ts`, IdentityDO `/guests/*` handlers, guest sessions, `routeHostKind`). Assessment of the **current** delta:

**What holds today:**
- No edge route reaches any guest surface: `src/worker.ts` (786 lines, current) contains no `/auth/guest`, no `routeHostKind` call — `/guests/*` and `guest-verify` are unreachable without a valid teacher session (`worker.ts:633-637` requires a session for all `/api/*` before forwarding).
- `routeHostKind` (`requestGuard.ts`, uncommitted) fails closed when `GUEST_HOSTNAME` is unset; `authorizeGuestSession` (sessionStore diff) verifies provenance + room binding; account triggers enforce the provenance/guest_room_id invariant at the DB level.
- PIN design: 6-digit PIN (~20 bits) explicitly *not* treated as the boundary; per-room lockout (50 fails/10 min → 15 min) + 12 h expiry + constant-time compare + identical generic failures everywhere. The math holds: lockout yields ~7,200 guesses/day against a 10⁶ space.

**What must be true before Task 8 wires it in (checklist, not current bugs):**
1. **Ordering:** `/auth/guest` must always verify the PIN via RoomDO `guest-verify` **before** calling IdentityDO `/guests/issue` — the issue handler creates accounts+sessions with no PIN knowledge by design (internal trust). Any future path that forwards to `/guests/issue` without the PIN check mints accounts anonymously.
2. **Per-IP 5/min limiter** on `POST /auth/guest` (Task 8b) must land in the same change that makes the route reachable — the per-room lockout alone allows a distributed attacker 7,200/day, which the design itself calls out.
3. **`workers_dev = false`** (`wrangler.toml:5`, currently `true` behind a TODO): today survivable because every route demands an Access JWT; once an unauthenticated guest hostname exists, `*.workers.dev` becomes a working bypass of the zone's WAF and rate limiting. The spec correctly flags this as a **release blocker** — treat it as one.
4. **Guest-verify reachability drift:** the uncommitted `RoomDO.fetch` change (`section === 'guest-verify'` runs without `accountId`) is currently shielded by the Worker's session gate; once guest-host dispatch lands, re-verify that the *teacher* hostname cannot reach `/api/whiteboard/room/:id/guest-verify` without a session (per §6.1 it must 404/401).
5. The PIN is deliberately stored **plaintext** with the rationale recorded (owner read-back; online-guessing threat model) — reasoning is sound; keep the constant-time compare mutation tests.

**Severity rationale:** Low today (dormant); the design document is one of the stronger artifacts in the repo. Finding exists so the wiring PR gets reviewed against this checklist.

---

## Verified strengths (checked and held)

- **Access JWT verification** (`accessVerifier.ts`): RS256-only, `kid` required, strict JWKS parsing (RS256+sig only, byte-capped, rotation-aware with cooldown), exact `iss`/`aud`, `type === 'app'`, service tokens rejected, `iat`/`nbf`/`exp` with bounded skew, `ctx.access` identity cross-check, fail-closed on every malformed input. Local dev issuer binds loopback only with per-process ephemeral keys.
- **Worker→DO internal hop** (`worker.ts:509-544`): `forward()` **sets** (overwrites) `roomId`/`accountId`/`accountEpoch`/`sessionId` from the verified session — client-supplied values cannot survive; `stripForwardedIdentityHeaders` drops `Cookie`, `Authorization`, Access headers, `X-Account-Id`, etc.
- **Role matrix** (`RoomDO.authorize`): every section × method maps to owner/granted/none checks before sensitive reads; owner-only settings/waiting/requests/approval/deletion; viewer cannot write scenes or fan-out publish; `410` tombstones prevent recreate-with-old-grants.
- **Signaling** (`RoomDO.webSocketMessage`): per-message stale-grant revalidation (4401), 1 MiB frame cap (1009), 60 msg/s per account (1008), binary relay gated on `canWriteBoard`, JSON type whitelist, `publish` fan-out restricted to board-writers.
- **Sessions**: `__Host-teacher-session` (Secure, HttpOnly, SameSite=Lax), hash-only storage (32-byte tokens, SHA-256), idle+absolute TTLs, rotation, revoke-all, authorization epoch, destructive-action re-auth (5-min freshness).
- **Secrets in repo:** none found — `git ls-files` shows only `.env.local.example`; wrangler.toml carries only non-secret Access metadata; `.next/prerender-manifest.json` signing key is an untracked, gitignored build artifact.
- **Marketing exemption** (`isPublicPath`): GET/HEAD-only, exact-match, nothing under `/api/`, `/auth/`, `/whiteboard/`, `/signaling` inside it (tested per security.md).

## Already tracked in `security.md` (cross-reference, not re-reported)

| Item | Where tracked | Note from this audit |
|------|---------------|----------------------|
| `workers_dev = true` alternate origin | SEC-004 open item; Phase 1 APPROVE-AS-BLOCKED | Elevated to release blocker by guest feature (GLM-03.3) |
| `webSocketMessage` stale-grant close doesn't evict LiveKit; ban-without-kick alarm-only | Phase 10 residuals | Confirmed in source (`closeRevoked` at `RoomDO.ts:729-739` has no `scheduleLiveKitEviction`) |
| Rate limiters keyed per account, no IP key | SEC-005 residual | Confirmed (`createRateLimiter` takes `session.accountId`) |
| Per-session (vs per-account) peer binding granularity | SEC-004 residual | Unchanged |
| `NEXT_PUBLIC_E2E=1` production debug globals | SEC-014 residual | Unchanged |
| `.data` incident residuals (GitHub cached views, old-environment grant invalidation, downstream clones) | SEC-008 / Phase 0 | Open operational items, outside repo control |
| Staging logins, WAF rule, penetration test | Phase 1/5/6 gates | Platform-dependent, still open |

## Downgraded or rejected candidates

| Candidate | Reason |
|-----------|--------|
| `publish` fan-out resolves peer roles via the **sender's** `attachment.roomId` (`RoomDO.ts:833`) | One DO = one room; all sockets in `ctx.getWebSockets()` belong to this object, so sender and peer room ids are necessarily equal. Not exploitable. |
| `GET /room/access` leaks room existence to any authenticated account | Deliberate design (200 `{status:'none'}` for both missing rooms and strangers — no oracle); required by the create-429 flow. Documented in security.md. |
| `POST /room/guest-verify` enables anonymous PIN brute-force today | Not reachable: Worker requires a valid teacher session for all `/api/*` paths before forwarding. When guest-host dispatch lands, the per-room lockout + (pending) per-IP limiter govern. Re-test at wiring time (GLM-03.4). |
| Create-rollback `DELETE` bypasses destructive-action re-auth (`worker.ts:742-754`) | Internal compensating deletion of the *caller's own just-created* room when the identity slot reservation (room quota) fails. Not attacker-useful; actually quota enforcement. |
| `previewModeSigningKey` in `.next/prerender-manifest.json` | Build artifact; `.next/` gitignored, untracked. |
| Local issuer signs arbitrary tokens/subjects | Dev-only, binds `127.0.0.1`, ephemeral per-process keys, negative variants for tests; Worker verifies iss/aud/exp strictly. |

## Residual risk

1. **Methodology limits:** this was a static audit. The planned parallel hunter/PoC subagents stalled (3× 30-min timeouts, zero output), so candidate generation, falsification, and cross-checking were performed by a single auditor with direct source reads instead of independent reproduction. Dynamic PoCs (raw WebSocket clients, token forgery, lockout timing) were not executed. No CVSS scores are claimed.
2. **Moving tree:** the working tree changed *during* the audit (4 → 14 changed files; guest feature is mid-TDD under concurrent sessions). Findings are dated to the tree as of 2026-08-19; re-run the GLM-03 checklist when the guest feature's Task 8 lands.
3. **Not tested:** real Cloudflare Access staging (platform-gated), LiveKit server behavior (token grants inferred from code, not a live join), dependency vulnerability currency (`npm audit` needs network; last recorded clean in security.md/CI), e2e suites.
4. **Open platform items** (outside repo control) remain as listed in `security.md`: `workers.dev` origin closure, zone WAF/rate rule, staging penetration test, incident follow-ups.
