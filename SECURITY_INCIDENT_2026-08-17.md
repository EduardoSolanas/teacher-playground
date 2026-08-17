# Public SQLite data exposure — 2026-08-17

## Status

Confirmed confidentiality incident. Containment is complete in the Git index and
in public history: the artifacts were purged from every public ref on
2026-08-17 and the removal was verified against a fresh clone of the remote.

Still outstanding: GitHub cached views and any downstream copies, and the
question of whether any rows are real classroom data. Until those are closed,
treat the exposed material as public.

This document intentionally contains aggregate evidence only. It must not copy
names, email addresses, room identifiers, board content, token hashes, or other
values from the database.

## Confirmed exposure boundary

- The GitHub repository is publicly readable and displays `.data/` on its
  default branch as of 2026-08-17.
- Git history contains `.data/whiteboard.db` from commit `da14803` dated
  2026-05-21 onward, with multiple later database/WAL/SHM snapshots.
- Commit `915870d` dated 2026-08-17 updated all three SQLite artifacts and is the
  current commit on the public `origin/cloudflare-workers-port` branch.
- The current local snapshot contains 3,258 room rows, 934 access-grant rows,
  248 access-request rows, and 196 waiting-peer rows.
- Populated sensitive fields include serialized board elements and viewports,
  usernames, email addresses, peer/host identifiers, and SHA-256 bearer-token
  hashes. The database appears substantially test-generated, but the available
  evidence does not prove that every record is synthetic. Treat all records as
  potentially real until a data owner confirms otherwise.

## Containment completed locally

- `.data/` is ignored.
- The database, WAL, and SHM files are removed from the Git index only; the local
  copies remain available for authorized incident analysis.
- Unit persistence tests use in-memory SQLite and Worker contract tests use
  fresh Durable Object SQLite state, so committed database fixtures are not
  required.
- At the time of exposure, the Docker build context excluded `.data/` and its
  Dockerfile created an empty runtime data directory rather than copying this
  snapshot. That Dockerfile and the unsupported Node deployment have now been
  removed from the current tree.

## Actions requiring external authority or coordination

- [ ] Restrict or temporarily disable public repository access while response
  work is coordinated.
- [ ] Identify repository clones, Actions artifacts, caches, forks, mirrors, and
  other downstream copies. Zero visible GitHub forks does not prove zero clones.
- [ ] Determine with the data owner whether any rows contain real classroom or
  personal data and apply the applicable notification/retention process.
- [ ] Invalidate every grant/session derived from these SQLite snapshots in any
  retained Node/SQLite deployment. If any data was migrated into another
  environment, invalidate the corresponding grants there as well.
- [ ] Treat exposed room IDs/share codes as public and rotate or retire any room
  that remains active.
- [x] Purge `.data/` objects from every public Git ref using an approved history
  rewrite, then force-update affected refs. Done on 2026-08-17 with
  `git filter-repo --invert-paths --path .data/` across all refs, then a forced
  push of `main`, `master`, `cloudflare-workers-port`, and
  `codex/whiteboard-realtime-ci`. Verified by cloning the remote fresh: zero
  commits touching `.data/`, zero objects under that path, and zero blobs
  beginning with the SQLite file magic. Every commit hash on every branch
  changed, so **collaborators must delete their clones and re-clone**; pushing
  from an old clone would reintroduce the removed objects. A pre-rewrite bundle
  of all refs is retained outside the repository for incident analysis.
- [ ] Request GitHub cached-view cleanup after the rewritten refs are published.
  The rewrite is published, so this is now actionable: GitHub can still serve
  the old objects through cached commit views and the API until it is asked to
  drop them. Until that is confirmed, treat the data as still exposed.
- [x] Run a full history scan after purge: no `.data/` paths, objects, or SQLite
  blobs remain on any public ref.
- [ ] Retain an evidence-only incident record outside public history.

## Rotation decision

Token hashes are not plaintext credentials, but their exposure still reveals
valid grant records and enables offline guessing if any source token was weak or
test-derived. Because token provenance and deployment lineage are unproven, the
safe decision is to invalidate all affected grants rather than attempt selective
rotation. This cannot be marked complete until deployment owners confirm every
affected store and active room has been addressed.

## Completion evidence required

- Public refs contain no `.data/` objects.
- Repository and cached public views no longer serve the artifacts.
- History scanning reports no remaining database, PII, or credential material.
- Deployment owners attest that affected grants/sessions and active room codes
  were invalidated or that the snapshot was proven synthetic and never deployed.
- Incident ownership, notification decision, and closure date are recorded.
