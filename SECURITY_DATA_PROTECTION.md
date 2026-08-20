# Data protection policy (SEC-016)

This document records the **current** lawful-basis and data-inventory decisions,
minors policy, audit-vs-erasure rules, and operational-store boundaries for the
teacher-playground application. It is policy only — implementation of erasure,
export, and pseudonymization belongs to later SEC-016 tasks.

Last reviewed: 2026-08-18

## Lawful basis and data inventory

The product is a tutor-operated whiteboard and optional A/V room. The **data
controller** for classroom use is the tutor (or their organization); the
platform operator processes data on the tutor's instructions to provide the
service.

### Personal data held today

| Category | Where stored | For whom | Notes |
| --- | --- | --- | --- |
| Cloudflare Access `(issuer, subject)` | IdentityDO `access_subjects` | Teacher and student accounts | Authoritative social-identity lookup key; see [`SECURITY_IDENTITY_MODEL.md`](SECURITY_IDENTITY_MODEL.md). |
| Local `account_id` | IdentityDO `accounts`, room membership rows | All signed-in users | Opaque server identifier; not derived from email. |
| Session hash | IdentityDO `sessions.session_hash` | All signed-in users | SHA-256 of the session secret; not the raw cookie value. |
| Display names | RoomDO `room_presence.user_name`, `waiting_peers.user_name`, `room_members.display_name` | Participants in a room | Client-chosen labels for UI; authorization does not trust them. |
| Board strokes / scene | RoomDO `rooms.elements` (JSON) | Room participants | Whiteboard content for the live room. |
| Presence labels | RoomDO presence and waiting tables (`user_name`, `color`, `peer_id`) | Room participants | Shown in presence panel, cursors, and moderation UI. |
| Authorization audit | IdentityDO `authorization_audit` | Accounts subject to operator actions | Append-only security events (disable, enable, revoke-all). |

### Explicitly not collected in-tree

- **No card data.** Payment processing, when built (SEC-015), must use hosted
  checkout or hosted fields; PAN/CVV never touch this application.
- **No student billing identity.** Paid plans attach to the tutor's account only.
  Students must not be asked for billing details or stored as payers.

Email and profile fields from Access are optional audit/profile data where
present; they are not used to select or merge accounts.

## Minors policy

The product targets **tutor-paid 1:1 and small-group** sessions, not open social
classrooms.

- **Students should not receive independent social login** when the tutor can
  avoid it. Prefer tutor-provisioned or org-managed Access for student seats
  rather than students creating their own OAuth identities for the product.
- **Collect the minimum identity data.** A display name is sufficient for
  classroom participation; do not require student email or other PII beyond
  what Access already asserts for admission.
- **Guest join (when enabled)** collects only a self-chosen display name plus
  a disposable guest account bound to one room — no email, no OAuth subject, and
  no join PIN in URLs or logs (the PIN is typed, not linked). Guest accounts are
  purged when the room is deleted or guest sessions expire.
- **No extra PII fields** for students (no date of birth, school ID, or
  marketing capture in student-facing flows).
- **Transcripts and session recording are out of scope** until Phase 10 and
  must not be enabled without revisiting this policy and the SEC-016 erasure
  paths for stored audio/video and text.

Tutors remain responsible for obtaining any consent required in their
jurisdiction for minors they invite into a room.

## Audit trail and erasure

Account erasure and data-subject requests must be explicit, verified operations
(documented deadline and procedure are future implementation work). Until then,
this section fixes the **policy tension** between security audit retention and
the right to erasure.

### Board and room content

- Whiteboard scene data (`rooms.elements`), presence rows, waiting-queue rows,
  and room membership for an erased account are **deleted** when the account or
  room is erased — they are not retained for security audit.
- Room-scoped erasure uses the same scope as [`deleteRoomScopedData`](src/lib/whiteboard/roomSchema.ts)
  (all `ROOM_SCOPED_TABLES` for that `room_id`).

### Authorization audit

- `authorization_audit` is **deliberately not** `ON DELETE CASCADE` from
  `accounts`: security events may outlive the account row on **legitimate
  interest** grounds (abuse investigation, operator accountability).
- On account erasure, audit rows **must be pseudonymized**: keep the event,
  action, epoch transition, and timestamp; replace direct identifiers
  (`account_id`, and any actor/reason text that re-identifies the person) with
  a stable pseudonym or redacted placeholder so the trail remains useful without
  restoring the deleted identity.
- No other table should retain re-identifiable account data after erasure
  completes.

### Sessions and live connections

Erasure closes all sessions for the account and disconnects live signaling
sockets within the revocation bound in [`SECURITY_REVOCATION_BOUND.md`](SECURITY_REVOCATION_BOUND.md).

## Operational stores

### In-tree application

- **No third-party analytics SDKs or trackers** are present in this repository.
  Product telemetry, if added later, must be documented here and join SEC-016
  erasure.
- Error reporting and structured security-event logging (SEC-013) are not yet
  wired to external vendors in-tree.

### Platform and backups

- **Cloudflare Worker, Durable Object, and Access logs** are platform-operated
  diagnostic and security logs. They may contain request metadata, IP addresses,
  and session-related identifiers for a platform-defined retention window. They
  are not application tables and cannot be rewritten instantly on erasure;
  document the **backup and log erasure window** when export/erasure is
  implemented rather than implying immediate purge everywhere.
- LiveKit A/V metadata and media, when used, are governed by LiveKit/project
  retention settings outside this repo.

## References

- [`security.md`](security.md) — SEC-016 account lifecycle, erasure, and data-subject rights
- [`SECURITY_IDENTITY_MODEL.md`](SECURITY_IDENTITY_MODEL.md) — Access subject and `account_id` model
- [`src/lib/identity/identityStore.ts`](src/lib/identity/identityStore.ts) — identity and `authorization_audit` schema
- [`src/lib/whiteboard/roomSchema.ts`](src/lib/whiteboard/roomSchema.ts) — room-scoped data including board elements
