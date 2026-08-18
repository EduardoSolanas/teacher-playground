# Account-wide revocation bound (Phase 3)

This document records the **current** revocation behavior in `RoomDO` and the
**accepted maximum delay** for account-wide disable until fan-out or push
notification exists. It is policy only — no new code in this slice.

## In-room kick / suspend / ban (immediate)

On successful `POST /presence` with `action` `kick` or `suspend`:

1. `incrementGrantVersion` bumps the room grant version ([`roomSchema.ts`](src/lib/whiteboard/roomSchema.ts)).
2. [`closeAccountSockets`](src/do/RoomDO.ts) closes matching signaling sockets and schedules LiveKit `RemoveParticipant`.
3. Sockets close with code **4401** (`SOCKET_REVOKED_CLOSE_CODE`, reason `Session revoked`).

Hibernating sockets are closed in step 2 (attachment scan). On wake, [`webSocketMessage`](src/do/RoomDO.ts) re-checks grant version and room grant role; stale or banned attachments are closed the same way.

**Bound: 0 s** — revocation is synchronous with the owner’s HTTP response.

## Account-wide disable / revoke-all / epoch bump (polling)

Open signaling sockets carry `authorizationEpoch` from upgrade. While any socket is open, [`scheduleRevocationCheck`](src/do/RoomDO.ts) ensures one pending alarm. [`alarm`](src/do/RoomDO.ts) runs every `checkIntervalMs`:

- Production default: **30 s** (`REVOCATION_CHECK_INTERVAL_MS = 30_000`; overridable via `REVOCATION_CHECK_INTERVAL_MS` env, floor 50 ms).
- Tests use shorter intervals via the same env binding.

Each [`alarm`](src/do/RoomDO.ts) tick POSTs open `accountIds` to IdentityDO `/accounts/authorizations` and closes sockets when the account is missing, `state !== 'active'`, or `authorizationEpoch` differs from the attachment. Closed via [`closeRevoked`](src/do/RoomDO.ts) → **4401**.

**Ping keepalives revalidate on wake:** application `{type:ping}` frames go through [`webSocketMessage`](src/do/RoomDO.ts), which checks grant version and room grant role before replying `{type:pong}`. Stale or revoked attachments close with **4401** on the first ping byte, not only on the alarm path.

**HTTP after disable:** the Worker re-validates the session on the next request; disabled accounts receive **401** (session cleared). No waiting for the room alarm.

## Chosen policy (target, not yet fully gated)

| Scope | Mechanism | Accepted maximum delay |
| --- | --- | --- |
| In-room kick / suspend / ban | Grant version + [`closeAccountSockets`](src/do/RoomDO.ts) | **0 s** (implemented) |
| Account-wide disable / revoke-all / epoch | [`alarm`](src/do/RoomDO.ts) epoch revalidation via IdentityDO | **30 s** until a later slice adds `alarm(0)` on disable, IdentityDO→room fan-out, or shorter forced reconnect |
| LiveKit A/V | `removeLiveKitParticipant` from kick/suspend (`closeAccountSockets`) and from the identity `alarm` loop | Same bound as sockets (0 s kick, ≤30 s disable); HTTP kick stays 200 if LiveKit is down |

We **do not** adopt reliable active-room fan-out in this slice. The measurable bound is authorization-epoch revalidation on the alarm interval, with HTTP denied immediately on the next request.

Future improvements (optional, separate tasks): schedule `alarm(0)` when IdentityDO disables an account; push revocation to all active `RoomDO` instances.

## References

- [`src/do/RoomDO.ts`](src/do/RoomDO.ts) — `closeAccountSockets`, `alarm`, `scheduleRevocationCheck`, `SOCKET_REVOKED_CLOSE_CODE`
- [`security.md`](security.md) Phase 3 — “Choose and document account-wide revocation”
