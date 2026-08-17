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
| Recovery leaves an audit record | **Not implemented** | — |
| Audited operator recovery workflow | **Not implemented** | — |

### Outstanding

There is no audit table and no audit write anywhere in the codebase, so the
recovery requirement above is only partly met: an operator can advance the
epoch, revoke sessions, and disconnect live sockets, but that action leaves no
durable record of who performed it, when, or why. Until that exists, subject
recovery must continue to mean creating a new account, and any epoch change
should be recorded outside the application.

Room authorization is still a separate bearer-token grant matrix
(`src/lib/whiteboard/access.ts`) that is not keyed to the local account. A local
session gates whether a request or socket is accepted at all; it does not yet
decide which room role the account holds.
