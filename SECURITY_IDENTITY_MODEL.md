# Local identity model

Last reviewed: 2026-08-17 (revocation bound and acceptance status updated)

## Authoritative key

One verified Cloudflare Access `(issuer, subject)` pair maps to exactly one local
account. The pair is the only social-identity lookup key used for authorization.

- `issuer` is the exact verified Access token issuer for the configured Zero
  Trust organization.
- `subject` is the non-empty verified Access token subject.
- The database must enforce a unique composite constraint on `(issuer, subject)`.
- Email, name, avatar, login provider label, and client-supplied identifiers are
  profile/audit data only. They never select, merge, or authorize an account.
- A Google identity and a Facebook identity are separate local accounts whenever
  Access presents different subjects, even if the human or email appears to be
  the same.
- There is no end-user account-linking, unlinking, or merge user interface.

This deliberately prefers duplicate accounts over an account-takeover path
through email matching or an incorrectly linked social identity.

## First login and concurrent login

After the Worker fully verifies the Access context, it transactionally looks up
the exact issuer/subject pair. If absent, it creates one account and one subject
mapping. Concurrent first logins must converge on the same row through the
database uniqueness constraint; a uniqueness race is retried as a lookup, not
as a second account.

Creating or finding the account does not grant room access. Local account state,
session state, and the room authorization matrix are evaluated separately.

## Subject-change recovery

An unexpected subject is treated as a new identity and receives no access to an
old account. Recovery is an explicit administrative operation, not an automatic
email-based merge:

1. An authorized operator independently verifies control of both the old local
   account and the newly authenticated identity.
2. In one transaction, the operator adds or rebinds the new issuer/subject
   mapping, removes or retires the superseded mapping according to the incident
   decision, increments the account authorization epoch, and records an audit
   event.
3. Every existing local session for the account is revoked and active room
   connections are closed within the revocation bound defined below.
4. Conflicting mappings fail closed; accounts are never silently merged.

## Revocation bound

Session revocation and account disablement take effect immediately for new
requests: `/api/*` and the `/signaling` upgrade re-authorize the local session
on every request, so a revoked session is refused at once.

An already-established signaling WebSocket is authorized only at upgrade time,
so it is re-checked on a timer instead. `RoomDO` records the verified account id
and authorization epoch on each socket and re-reads account state from the
identity object every `REVOCATION_CHECK_INTERVAL_MS`
(`src/do/RoomDO.ts`, currently **30 seconds**). A socket is closed with code
`4401` when its account is disabled, its authorization epoch has advanced, the
account is missing, or the socket carries no verified identity.

The worst-case bound for disconnecting a live collaborator is therefore one
check interval. Two deliberate choices narrow what that bound covers:

- The account id and epoch are written onto the internal request by the Worker
  after the session is verified, overwriting any client-supplied values, so a
  client cannot nominate its own identity to the room.
- If the identity object is unreachable, sockets stay open and the check is
  retried. A transient identity failure must not disconnect an entire class.
  This means the bound holds only while the identity object is reachable.

Until an audited operator workflow is implemented, recovery means creating a
new account. No database edit, email match, or support shortcut may bypass this
rule.

## Acceptance contract

Status is against automated tests in this repository only. Nothing here has been
verified against a real Cloudflare Access deployment; see
`CLOUDFLARE_ACCESS_STAGING.md`.

| Requirement | Status | Where proven |
| --- | --- | --- |
| Unique `(issuer, subject)` mapping, no email-based authority | Covered | `src/lib/identity/identityStore.test.ts` |
| Concurrent first login produces one account | Covered | `src/do/identityDO.workers.test.ts` |
| Same email under two subjects produces two accounts | Covered | `src/lib/identity/identityStore.test.ts` |
| Changed subject cannot reach the old account | Covered | `src/do/identityDO.workers.test.ts` |
| Revocation advances the epoch and revokes every session | Covered | `src/lib/identity/sessionStore.test.ts` |
| Revocation closes live room sockets | Covered | `src/do/roomDO.workers.test.ts` |
| Forged email, provider label, or client header cannot select an account | Covered | `src/lib/access/accessVerifier.test.ts`, `src/do/identityDO.workers.test.ts` |
| Room authorization is keyed to the local account | Covered | `src/do/roomDO.workers.test.ts`, `tests/e2e/room-authorization.spec.ts` |
| Recovery leaves an audit record | Covered | `src/lib/identity/sessionStore.test.ts`, `src/do/identityDO.workers.test.ts` |
| Audited operator recovery workflow | **Not implemented** | — |

## Room authorization

A verified session decides whether a request is accepted at all; membership
decides which room it may touch. Membership lives in `room_members`, keyed by
the local account id, and is enforced in one place — `RoomDO.authorize` — so
handler code cannot accidentally skip it.

| Operation | Requires |
| --- | --- |
| Create a room | any authenticated account; it becomes the owner |
| Request or check own admission | any authenticated account; banned accounts are refused |
| Read an existing board | granted viewer, editor, or owner |
| Write an existing board | editor or owner (not viewer) |
| Delete the room | owner |
| Moderate the waiting queue, kick, suspend | owner |
| Join, leave, read presence, leave the queue | any authenticated account |

Membership is granted by admission, never by client assertion or bearer token.
The room's creator becomes owner in the same transaction as the room row. A
queued account becomes `editor` or `viewer` when the owner approves it, and
`banned` when the owner rejects or kicks it. `room_presence` is a liveness view
pruned on a short timer, so it is deliberately not used to answer "may this
account open this board" — an idle granted account keeps access.

Two consequences worth knowing:

- A non-member receives `403` whether or not the room exists, so the API cannot
  be used to discover room ids.
- Peer ids are client-supplied and are never trusted for authorization. They are
  bound to the verified account on join so an approval can promote the right
  account.

## Audit trail

Every operator action that changes what an account may do — `revoke-all`,
`disable`, `enable` — writes a row to `authorization_audit` **inside the same
transaction** as the change, so an authorization change is never visible without
the record explaining it. Each row carries the actor, the reason, the previous
and next state, the previous and next epoch, how many sessions were revoked, and
when.

`actor` and `reason` are mandatory and are rejected when blank or oversized: an
audit log with an optional actor proves nothing. A change that names neither is
refused with `400` and alters no state.

The table is deliberately not `ON DELETE CASCADE`, so the record outlives the
account it describes.

### Outstanding

The audit trail records operator actions, but there is still no audited
*workflow* for subject recovery: nothing verifies that an operator independently
confirmed control of both identities before rebinding, and there is no
administrative interface for it. Subject recovery therefore still means creating
a new account.

The older bearer-token grant matrix (`src/lib/whiteboard/access.ts`) is gone.
`/access`, `/requests`, and `/waiting` read and write `room_members` only, keyed
by the Worker-stamped local account id. Leftover `room_access` /
`access_requests` tables are unused and are not consulted for authorization.
