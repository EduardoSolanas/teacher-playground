# Security requirements for features not yet built

These are the security contracts for product features that do not exist in this
codebase today. They are **requirements, not tasks**: nothing here is owed until
the feature is started, and then every item is part of the feature's definition
of done, not a follow-up. They were carried over from the Phase 8-11 plan in
`security.md` when that document was reduced to controls that exist.

A feature from this list may start only when its authorization rows, retention,
and erasure path are designed alongside it. Each new object type (history
entry, account library item, chat message, private board, recording,
transcript, imported file, embed) must be in the authorization matrix
(`SECURITY_ROUTE_REVIEW.md`), the retention schedule, and the erasure path
(`SECURITY_DATA_PROTECTION.md`) **before** its UI ships.

What already exists and is not repeated here: named persistent rooms owned by an
account, with a caller-only room list; the per-room shape library (owner-only,
size-capped, deleted with the room); raise hand as a schema-validated,
rate-limited presence action with no free text; follow-me as an owner-only frame
that moves viewports and never authorization; per-student edit rights through
`room_members.role` (editor or viewer); LiveKit voice and video bound to room
grants and dropped on revocation; host-controlled screen share; owner mute,
stop-camera and share controls acting on accounts. Their evidence is in
`security.md`.

## Board history and restore

- History has a bounded depth, and restore is owner-gated and audited.
- History inherits the room's retention clock (90 days after last use) rather than
  living forever, and is deleted with the room and on erasure.
- A history entry is never readable by anyone who could not read the room at the
  time it was written.

## Account-level content library

- Saved items are per account, size- and count-bounded, and never shared across
  accounts without an explicit grant.
- Cross-device sync rides the existing session; no new token or storage channel.
- Items join account erasure and export, and the backup and restore procedure.

## In-room chat

- Messages are bound to `account_id`, rendered with the existing display-name
  normalization and owner-role display integrity, bounded in length and rate on
  the server, and deletable by the owner.
- Retention is short by default and recorded in the data-protection policy.
  Student messages are personal data and join erasure and export **before**
  launch.
- A student cannot read another student's one-to-one chat by any raw-client
  request.

## Session timer, idle and connection alerts

- Timer and indicators travel as presence-channel events: schema-validated,
  rate-bounded, carrying no free text.
- Idle or distraction alerts are aggregate and ephemeral. No per-student browsing
  or attention history is stored; this is a deliberate privacy decision, not an
  omission.

## Private per-student boards and breakout rooms

- They are child rooms with their own grant rows: the owner sees all, a student
  sees only their own.
- The server's socket boundary enforces this for live sync, never the client.
- Moderation and permission changes resolve to accounts, and a forged follow-me
  or permission event moves nobody's authorization.

## Recording and transcripts

- Recording requires explicit, visible, per-session consent, an indicator every
  participant can see, and a recorded decision on who may start it (owner only by
  default).
- Recordings and transcripts are stored encrypted, owner-scoped, inside the
  declared storage region, on the room retention schedule, and in erasure and
  export.
- Transcripts of minors are the most sensitive data this product would hold:
  off by default; enabling is a per-room owner decision recorded with the consent
  trail.
- No recording exists without its consent trail.

## Teaching content imports (Drive, OneDrive, PDF annotation)

- The narrowest OAuth scope only: Google `drive.file` through the Picker (files the
  user explicitly picks) and the OneDrive picker equivalent. Broad Drive scopes
  are prohibited; adding any scope is a reviewed change to this document.
- Provider tokens never reach the client or persistent storage in plaintext.
  Prefer import-as-copy with no refresh token at all. If offline refresh is ever
  genuinely needed, tokens are encrypted at rest, per account, revocable from the
  account page, and covered by erasure.
- Imported files become this application's own stored objects: content-type
  allowlist, size caps, server-side re-encoding or sanitization for anything
  rendered (SVG and PDF can carry script), and storage that joins retention,
  erasure, export, plan quotas and backup.
- Students see imported content from this application's origin, never a proxied
  provider URL.
- Each integration records what data flows to the provider and joins the data
  inventory before launch.

## Third-party embeds

Today embeds are **off**: the server's scene guard deletes every `embeddable`,
`iframe` and `magicframe` element from the live document, and the Web Embed tool
is not offered. Turning embeds on requires all of:

- Sandboxed iframes without `allow-same-origin` toward this application, and a CSP
  `frame-src` listing exactly the vetted tool origins.
- A per-tool allowlist changed only by review; no `postMessage` handling without
  origin checks.
- The allowlist is owner-controlled per room and off by default, so a
  misbehaving tool can be cut off by configuration.
- Embedded tools never receive the session cookie, account ids, or roster data.
- Revoking an embed stops student access to it.
