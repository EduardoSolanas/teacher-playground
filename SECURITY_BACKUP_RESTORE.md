# Backup and restore for Durable Object SQLite state

This document records the **current** backup mechanisms, recovery-point
objectives (RPOs), restore procedures, and verification expectations for
classroom data held in Cloudflare SQLite-backed Durable Objects.

There are now **two** layers:

1. **Application-managed R2 export (BAK-01, automated)** — a daily cron exports
   each active RoomDO's SQLite rows to the private `BOARD_FILES` bucket and
   proves the restore path in CI (see below).
2. **Platform PITR (Cloudflare-managed)** — a rolling 30-day point-in-time
   recovery window per Durable Object, unchanged from the platform notes below.

Last reviewed: 2026-09-19

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

## Backup mechanism 1: scheduled R2 export (application-managed, BAK-01)

A daily cron drives the Worker's `scheduled()` handler, which runs
`runBackupCycle` (`src/lib/backup/backupCycle.ts`) after the billing reconcile:

- **Cadence:** cron `0 3 * * *` (03:00 UTC, outside UK lesson hours), plus the
  billing reconcile's `23 4 * * *`; both live in `[env.prod.triggers]`
  (`wrangler.toml`). Per Durable Object the effective cadence is 24h: the
  cycle exports a target only when `isBackupDue` says so.
- **Registry:** the IdentityDO holds `backup_registry (do_class, do_id,
  last_backup_at, last_activity_at)`. Room objects register themselves through
  the internal `/backup/register` route inside `touchOwnerRoomActivity`, so
  every room with board activity appears without a sweep. The cycle asks
  `/backup/due` (limit 50, oldest backup first): a target is due when it was
  never backed up or its last backup is ≥ 24h old, **and** its last activity is
  inside the 90-day room-idle retention window (`ROOM_IDLE_TTL_MS`) — rooms the
  retention sweep is about to drop are not worth exporting.
- **Export:** for each due `rooms` target, the Worker requests the internal
  `POST /room/backup/export` route on that room's Durable Object (addressed
  `ROOMS.idFromName(roomId)`, the same addressing as every other room call).
  The route serializes `rooms` + `ROOM_SCOPED_TABLES` row-wise (`serializeBackup`
  in `src/lib/backup/backup.ts`; workerd's `SqlStorage` has no native dump API).
  Rows are ordered by primary key, tables in list order, so a dump of unchanged
  data is byte-identical across runs.
- **Storage:** the JSON dump is written to the private `BOARD_FILES` R2 bucket
  (no public URL) at `backups/{doClass}/{doId}/{ISO timestamp}.json`, then the
  cycle records completion via `/backup/mark-done`. Per-target failures are
  logged (`backup_cycle_error`) and skipped; the cycle never throws.
- **Kill switch:** env var `BACKUPS_ENABLED` — `off`/`false`/`0` stops the
  cycle; unset, `on`/`true`/`1` and anything else enable it. This fails open on
  purpose, unlike `EMBEDDED_DOCUMENTS`' fail-closed: a mistyped value here costs
  R2 storage, while failing closed would silently leave classroom data with no
  application-managed export.
- **Public exposure:** the Worker refuses `/backup/*` subpaths on the public
  room API with 404 before forwarding, so the export route is reachable only
  through the namespace binding (tested in `src/backup.workers.test.ts`).

### Restore from an R2 export

`restoreBackup` (`src/lib/backup/backup.ts`) replays a dump into a
schema-applied database inside one `storage.transactionSync` transaction: each
covered table is emptied, then the dump's rows are inserted with explicit
column lists. NULL, integer, text and (via the documented `base64:` marker)
blob values round-trip losslessly; an unsupported dump version or unknown
table/column aborts the whole restore with the previous contents untouched.

The restore path is **rehearsed in CI**: `src/backup.workers.test.ts` ("exports
a due room to R2, marks it done, and restores with row parity") runs the real
cycle against real Durable Objects and the real (miniflare) bucket, then
replays the exported dump into a second, freshly-constructed RoomDO and
asserts row parity for every backed-up table.

## Backup mechanism 2: platform PITR

Cloudflare retains a durable change log for SQLite-backed Durable Objects and
exposes a **30-day PITR window**. Bookmarks represent object storage state at
a point in time within that window.

On the **Workers Free** plan, SQLite Durable Objects and their 30-day PITR API
are included (account storage is capped at **5 GB** total). PITR is the
platform's full-object rollback mechanism; the application-managed R2 export
above is the row-level complement.

PITR is **not available in local development** (`wrangler dev`, miniflare,
workerd tests). The durable log exists only on Cloudflare-managed production
infrastructure.

Official references:

- [SQLite-backed Durable Object storage — PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)
- [Access Durable Objects storage (SQLite + PITR overview)](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)

## Recovery-point objective (RPO)

| Layer | Metric | Value | Notes |
| --- | --- | --- | --- |
| R2 export | **RPO** | **≤ 24h + cron cadence** | Every active room's SQLite rows are exported at least once per 24h while it stays active; the daily cron bounds the gap between export opportunities. |
| R2 export | **RTO** | Minutes | `restoreBackup` replays a dump into a fresh RoomDO in one transaction; the rehearsal test exercises exactly this path. |
| Platform PITR | **RPO** | **30 days** (PITR window) | Data can be restored to any bookmark within the rolling 30-day window, not only the latest state. |
| Platform PITR | **RTO** | Operator-dependent | Per-object restore via dashboard or the Wrangler procedure below; not automated. |

The two layers are complementary: PITR covers full-object rollbacks (including
storage keys the R2 export does not copy — Yjs snapshots, board files),
while the R2 export provides per-room row-level recovery that survives even a
namespace-level loss, at row granularity, for every table in
`ROOM_SCOPED_TABLES`.

Finer-grained RPO (minutes or hours) is **not** guaranteed by this stack unless
operators schedule periodic bookmarks or more frequent exports in a future slice.

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

## Verification (CI rehearsal + staging drill)

The **R2 export restore path is verified in CI** (workerd): the rehearsal test
in `src/backup.workers.test.ts` exports a seeded room through the real cycle,
writes it to the bucket, restores it into a second RoomDO via `restoreBackup`,
and asserts row parity for every backed-up table. Registry exclusion rules
(24h cadence, retention window, due-list cap) and the public-API refusal are
covered in the same file and in `src/do/identityDO.workers.test.ts`.

Platform **PITR is not exercisable in CI** — local environments cannot reach
the durable log — so a PITR restore remains an operator **staging drill** at
least once per environment (or after material platform changes):

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

- The R2 export covers **rows in `ROOM_SCOPED_TABLES`** (scene rows, presence,
  waiting queue, kicks, membership, document manifests and jobs). It does not
  copy Durable Object storage keys — Yjs snapshot chunks, the element library,
  call state — or board image objects in `BOARD_FILES`. Full-object recovery
  for those is what PITR is for; the export's row dump is the durable,
  namespace-loss-tolerant copy of the relational state.
- `room_tombstones` rows are not exported (they carry no classroom content);
  a restored room that was tombstoned will not re-inherit that marker.
- The IdentityDO class is registered in the registry (and unit-covered) but
  its export route is a follow-up slice; the cycle logs and skips such targets
  rather than marking them done. Until that lands, IdentityDO state relies on
  PITR.
- Registry rows for deleted rooms linger harmlessly: their activity stamp
  ages past the retention window and the due list excludes them.
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

- [`src/lib/backup/backup.ts`](src/lib/backup/backup.ts) — dump/restore core
- [`src/lib/backup/backupCycle.ts`](src/lib/backup/backupCycle.ts) — cron cycle
- [`src/backup.workers.test.ts`](src/backup.workers.test.ts) — cycle + restore rehearsal evidence
- [`security.md`](security.md) — SEC-007 backup/restore task and Workers Free PITR note
- [`wrangler.toml`](wrangler.toml) — triggers, `RoomDO`/`IdentityDO` SQLite migrations, `BOARD_FILES`
- [`SECURITY_DATA_PROTECTION.md`](SECURITY_DATA_PROTECTION.md) — data inventory and platform log retention
- [Cloudflare DO SQLite PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)
