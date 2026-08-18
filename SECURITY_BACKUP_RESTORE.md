# Backup and restore for Durable Object SQLite state

This document records the **current** backup mechanism, recovery-point objective
(RPO), restore procedure, and verification expectations for classroom data held
in Cloudflare SQLite-backed Durable Objects. It is policy and operations guidance
only — no automated restore is implemented in this repository.

Last reviewed: 2026-08-18

## Scope

All application-persistent state lives in two SQLite-backed Durable Object
classes (see [`wrangler.toml`](wrangler.toml)):

| Binding | Class | What it holds |
| --- | --- | --- |
| `ROOMS` | **RoomDO** | Whiteboard scene, presence, waiting queue, room membership, grants |
| `IDENTITY` | **IdentityDO** | Accounts, Access subjects, sessions, authorization audit |

Both classes were created with `new_sqlite_classes` migrations and therefore use
the SQLite storage backend with platform-managed point-in-time recovery (PITR).

A storage incident or bad deploy can affect **both** namespaces independently.
Restore planning must cover **RoomDO and IdentityDO** — restoring only rooms
leaves accounts and sessions inconsistent; restoring only identity leaves board
and membership data stale.

## Backup mechanism (platform PITR)

Cloudflare retains a durable change log for SQLite-backed Durable Objects and
exposes a **30-day PITR window**. Bookmarks represent object storage state at
a point in time within that window.

On the **Workers Free** plan, SQLite Durable Objects and their 30-day PITR API
are included (account storage is capped at **5 GB** total). PITR is the primary
backup for in-tree classroom data; there is no separate application-managed
snapshot or export job.

PITR is **not available in local development** (`wrangler dev`, miniflare,
workerd tests). The durable log exists only on Cloudflare-managed production
infrastructure.

Official references:

- [SQLite-backed Durable Object storage — PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)
- [Access Durable Objects storage (SQLite + PITR overview)](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)

## Recovery-point objective (RPO)

| Metric | Value | Notes |
| --- | --- | --- |
| **RPO** | **30 days** (PITR window) | Data can be restored to any bookmark within the rolling 30-day window, not only the latest state. |
| **RTO** | Operator-dependent | Per-object restore requires identifying affected Durable Object IDs and running the restore procedure; not automated here. |

Finer-grained RPO (minutes or hours) is **not** guaranteed by this stack unless
operators schedule periodic bookmarks or external exports in a future slice.

## Restore procedure (dashboard and Wrangler-deployed path)

Restore is an **operational procedure**, not a product feature in this repo.
Use Cloudflare's documented PITR flow for each affected object instance.

### 1. Identify scope

- Determine whether the incident affects **RoomDO**, **IdentityDO**, or both.
- List the Durable Object IDs to restore (per room id for `RoomDO`; singleton
  or account-scoped ids for `IdentityDO` as deployed).
- Choose a target timestamp or bookmark **before** the bad write or deploy,
  within the 30-day window.

### 2. Dashboard (preferred for ad-hoc recovery)

When the Cloudflare dashboard exposes PITR for a namespace:

1. Open **Workers & Pages** → **Durable Objects** → select the namespace for
   `RoomDO` or `IdentityDO`.
2. Open the specific Durable Object instance (by id).
3. Use **PITR** / point-in-time recovery to select a bookmark in the
   **30-day window** and confirm restore.

Consult current dashboard docs if the navigation label differs; the platform
capability is the same 30-day SQLite PITR described in the API docs above.

### 3. Wrangler / Worker path (programmatic restore)

When dashboard restore is unavailable or bulk recovery is needed, deploy a
one-off or maintenance Worker that calls the PITR API on the target object,
following Cloudflare's documented sequence:

1. `ctx.storage.getBookmarkForTime(timestamp)` — resolve a bookmark for the
   desired recovery time.
2. `ctx.storage.onNextSessionRestoreBookmark(bookmark)` — schedule restore on
   the next session start.
3. `ctx.storage.getCurrentBookmark()` — capture a pre-restore bookmark if
   rollback of the restore itself may be needed.
4. `ctx.abort()` — restart the object so the restore completes.

Route the maintenance Worker to the same bindings (`ROOMS` / `IDENTITY`) as
production. Deploy with `wrangler deploy` (or the project's
[`deploy-cloudflare.yml`](.github/workflows/deploy-cloudflare.yml) pipeline on
a staging environment first).

Repeat for **each** Durable Object instance that must be rolled back. PITR
restores **one object's** embedded SQLite database atomically; it does not
restore an entire namespace in one action.

## Verification (staging drill, not CI)

This repository does **not** automate PITR restore in unit, worker, or e2e
tests — local environments cannot exercise the durable log.

**Tested restore path** means an operator **staging drill** at least once per
environment (or after material platform changes):

1. Seed representative data in a **staging** Worker (both `RoomDO` and
   `IdentityDO`).
2. Record a bookmark or note a timestamp.
3. Apply a deliberate destructive change (or simulate a bad deploy).
4. Restore via dashboard or the Wrangler-deployed PITR procedure above.
5. Verify board content, membership, sessions, and authorization state match
   the pre-incident baseline.

Record the drill date, operator, environment, and outcome in the team's runbook;
do not commit production object ids or bookmarks to git.

## Limitations

- PITR restores **full object SQLite state** at the chosen bookmark. Writes
  after that bookmark on the same object are lost.
- **Cross-object consistency** (e.g. room membership in `RoomDO` vs account rows
  in `IdentityDO`) is not transactional across namespaces. Prefer restoring
  both to bookmarks from the **same wall-clock window** and reconcile manually
  if needed.
- Platform logs and Access audit trails have their own retention; see
  [`SECURITY_DATA_PROTECTION.md`](SECURITY_DATA_PROTECTION.md) for erasure vs
  backup windows.

## References

- [`security.md`](security.md) — SEC-007 backup/restore task and Workers Free PITR note
- [`wrangler.toml`](wrangler.toml) — `RoomDO` and `IdentityDO` SQLite migrations
- [`SECURITY_DATA_PROTECTION.md`](SECURITY_DATA_PROTECTION.md) — data inventory and platform log retention
- [Cloudflare DO SQLite PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)
