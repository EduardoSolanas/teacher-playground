# Account-wide revocation bound (Phase 3)

This document records the **current** revocation behavior in `RoomDO`: which
paths close sockets synchronously with the request, what the Durable Object
alarm revalidates, and the **accepted maximum delay** that remains while
reliable active-room fan-out is not adopted.

Revocation is enforced at three points: the mutating HTTP request (kick,
suspend, waiting-queue reject, guest disable), the alarm's session/account/grant
revalidation for everything else, and the Worker's session check on the next
HTTP request. The alarm's polling is the mechanism; there is no push fan-out.

## In-room kick / suspend / ban (immediate)

On successful `POST /presence` with `action` `kick` or `suspend`:

1. `incrementGrantVersion` bumps the room grant version ([`roomSchema.ts`](src/lib/whiteboard/roomSchema.ts)).
2. [`closeAccountSockets`](src/do/RoomDO.ts) closes matching signaling sockets and schedules LiveKit `RemoveParticipant`.
3. Sockets close with code **4401** (`SOCKET_REVOKED_CLOSE_CODE`, reason `Session revoked`).

A waiting-queue **reject** is a ban and lands the same way: the handler returns
the banned account ([`waiting.ts`](src/lib/whiteboard/handlers/waiting.ts)), and
`RoomDO` bumps the grant version and closes that account's sockets before its
HTTP response returns ([`RoomDO.fetch`](src/do/RoomDO.ts)). Sockets that remain
are re-stamped with the new grant version so they are not treated as stale.

Hibernating sockets are closed by the same scan. On wake, [`webSocketMessage`](src/do/RoomDO.ts) re-checks grant version and room grant role; stale or banned attachments are closed the same way.

**Bound: 0 s** — revocation is synchronous with the owner’s HTTP response.

## Session logout / idle expiry / absolute expiry (alarm)

While any socket is open, [`scheduleRevocationCheck`](src/do/RoomDO.ts) keeps one
pending alarm. Each [`alarm`](src/do/RoomDO.ts) tick sends every open socket's
`{accountId, sessionId}` pair to IdentityDO `POST /accounts/authorizations`
([`IdentityDO.ts`](src/do/IdentityDO.ts)). IdentityDO answers with
`activeSessionHashes`, produced by
[`selectActiveSessionHashes`](src/lib/identity/sessionStore.ts): only sessions
that are not revoked, are before both the idle and the absolute TTL, and whose
account matches the pair are reported active. Unknown, revoked, and expired
hashes are omitted rather than reported active.

`RoomDO` closes a socket **4401** when its attachment `sessionId` is not in
`activeSessionHashes`, in addition to the pre-existing checks (account missing,
`state !== 'active'`, `authorizationEpoch` mismatch). Logout and both session
TTLs therefore end an already-open socket without a page reload.

One alarm checks at most `MAX_REVOCATION_SESSION_CHECKS` — **128** sessions
([`RoomDO.ts`](src/do/RoomDO.ts)). The room's own socket cap is far below this,
so a healthy room never truncates. If the cap is ever hit, sessions past it are
not revalidated and their sockets **fail closed** — they are closed like any
other unchecked session. A transient IdentityDO failure leaves sockets open and
retries at the next interval.

**Bound: the alarm interval** — production default **30 s**
(`REVOCATION_CHECK_INTERVAL_MS = 30_000`; overridable via
`REVOCATION_CHECK_INTERVAL_MS`, floor 50 ms). Tests use shorter intervals via
the same binding.

## Expired editor grants (alarm)

The same alarm tick re-checks each open socket's room role with `getGrantRole`
and closes **4401** when the account no longer holds a granted role
(`isGrantedRole`), covering editor grants that lapsed and were purged between
upgrades.

**Bound: the alarm interval** (30 s production default).

## Guest access disabled (immediate) / PIN rotation (new joins only)

- With guest access off, every guest HTTP section except the `guest-verify` PIN
  check returns **403** immediately, before role handling
  ([`RoomDO.fetch`](src/do/RoomDO.ts)); the same room-row gate refuses a guest
  signaling upgrade, so a guest whose socket was closed cannot simply reconnect.
- Turning `guestAccess` off closes live guest sockets within the owner’s
  settings request. [`closeGuestSockets`](src/do/RoomDO.ts) selects sockets by
  the `guest` marker on [`SocketIdentity`](src/do/RoomDO.ts) — stamped from the
  Worker's internal `guest=1` query, not from client input — and closes them
  **4401** synchronously.
- **Guest PIN rotation is intended to stop new joins only.** It does not eject
  guests who are already admitted, and no path treats it as an eject button.
  Existing guest access ends by disabling guest access, session TTL, kick, or
  room deletion.

**Bound: 0 s for disable** (synchronous with the owner’s request). Rotation
never revokes an existing grant by design.

## Account-wide disable / revoke-all / epoch bump (polling)

Open signaling sockets carry `authorizationEpoch` from upgrade. While any socket is open, [`scheduleRevocationCheck`](src/do/RoomDO.ts) ensures one pending alarm. [`alarm`](src/do/RoomDO.ts) runs every `checkIntervalMs`:

- Production default: **30 s** (`REVOCATION_CHECK_INTERVAL_MS = 30_000`; overridable via `REVOCATION_CHECK_INTERVAL_MS` env, floor 50 ms).
- Tests use shorter intervals via the same env binding.

Each [`alarm`](src/do/RoomDO.ts) tick POSTs open `accountIds` to IdentityDO `/accounts/authorizations` and closes sockets when the account is missing, `state !== 'active'`, or `authorizationEpoch` differs from the attachment. Closed via [`closeRevoked`](src/do/RoomDO.ts) → **4401**.

**Ping keepalives revalidate on wake:** application `{type:ping}` frames go through [`webSocketMessage`](src/do/RoomDO.ts), which checks grant version and room grant role before replying `{type:pong}`. Stale or revoked attachments close with **4401** on the first ping byte, not only on the alarm path.

**HTTP after disable:** the Worker re-validates the session on the next request; disabled accounts receive **401** (session cleared). No waiting for the room alarm.

## Chat and A/V

LiveKit eviction stays on kick/suspend ([`closeAccountSockets`](src/do/RoomDO.ts)
schedules `removeLiveKitParticipant`) and on the alarm, which schedules eviction
for each account whose socket it closes (account state/epoch, session expiry,
lapsed grant). Guest disable closes sockets through `closeGuestSockets`, which
does not itself schedule LiveKit eviction. Eviction is scheduled via
`waitUntil` and is best-effort: an HTTP kick still returns **200** if LiveKit is
down.

**Bound: same as sockets** — 0 s kick/suspend, ≤ alarm interval for the alarm
paths.

## Chosen policy

| Scope | Mechanism | Accepted maximum delay |
| --- | --- | --- |
| In-room kick / suspend / waiting-queue reject | Grant version + [`closeAccountSockets`](src/do/RoomDO.ts) | **0 s** (implemented) |
| Session logout / idle expiry / absolute expiry | Alarm `selectActiveSessionHashes` check via IdentityDO `/accounts/authorizations` + [`closeRevoked`](src/do/RoomDO.ts) | Alarm interval: **30 s** production default (test-overridable) |
| Expired editor grants | Alarm `getGrantRole` re-check on each open socket | Alarm interval |
| Guest access disabled | Guest HTTP `403` gate + [`closeGuestSockets`](src/do/RoomDO.ts) in the owner’s request | **0 s** (implemented) |
| Guest PIN rotation | New joins only (intended) | No bound — admitted guests keep access until TTL, kick, or disable |
| Account-wide disable / revoke-all / epoch | [`alarm`](src/do/RoomDO.ts) account state/epoch revalidation via IdentityDO | **30 s** until a later slice adds `alarm(0)` on disable, IdentityDO→room fan-out, or shorter forced reconnect |
| LiveKit A/V | `removeLiveKitParticipant` from kick/suspend (`closeAccountSockets`) and from alarm closes | Same bound as sockets (0 s kick, ≤ alarm interval); HTTP kick stays 200 if LiveKit is down |

## Recipient filtering complete; no fan-out

- Recipient filtering is complete for every broadcast path. The sanitized
  sync-diff fan-out and the raw relay path both check
  [`isGrantedRecipient`](src/do/RoomDO.ts) (same room, attached account, granted
  role) before sending, so a banned or lapsed peer stops receiving board and
  awareness frames between revocation checks. [`broadcastToRoom`](src/do/RoomDO.ts)
  — the last unfiltered path, used for server-generated cursor-sweep and
  clear-board updates — now applies the same check; the final verifier
  independently re-verified it `APPROVE`.
- Verifier sweep result: sync diff, awareness, presence, follow, call, publish,
  and the clear/cursor frames all filter their recipients. Handshake and
  sender-only sends are excepted because they carry no room fan-out: the
  upgrade's follow/call state goes to the just-authorized socket, and sync
  replies and `pong` go back only to the sender.
- We **do not** adopt reliable active-room fan-out. The measurable bound is the
  alarm's session/account/grant revalidation, with HTTP denied immediately on the
  next request.

Future improvements (optional, separate tasks): schedule `alarm(0)` when IdentityDO disables an account; push revocation to all active `RoomDO` instances.

## References

- [`src/do/RoomDO.ts`](src/do/RoomDO.ts) — `closeAccountSockets`, `closeGuestSockets`, `isGrantedRecipient`, `broadcastToRoom`, `broadcastPresence`, `broadcastFollow`, `broadcastCall`, `alarm`, `scheduleRevocationCheck`, `SOCKET_REVOKED_CLOSE_CODE`, `MAX_REVOCATION_SESSION_CHECKS`
- [`src/do/IdentityDO.ts`](src/do/IdentityDO.ts) — `/accounts/authorizations`, `activeSessionHashes`
- [`src/lib/identity/sessionStore.ts`](src/lib/identity/sessionStore.ts) — `selectActiveSessionHashes`
- [`security.md`](security.md) Phase 3 — “Choose and document account-wide revocation”
