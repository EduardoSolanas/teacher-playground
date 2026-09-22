# Board files (images pasted into whiteboards).
#
# Board images cannot live in the whiteboard document: a Durable Object value is
# capped at 2MB and the document is replayed to every peer that joins. They go
# to R2 instead, under `rooms/<roomId>/files/<fileId>`, and the Worker decides
# who may read them.
#
# ONE bucket per environment. Not one per teacher and not one per room: a Worker
# reaches R2 through a binding, bindings are fixed at deploy time, and a bucket
# per room would need a redeploy for every room a teacher creates. Isolation
# comes from the room grant, which RoomDO enforces and a test can hold.
resource "cloudflare_r2_bucket" "board_files" {
  account_id = local.account_id
  name       = local.env.r2.boardFilesBucket

  # Pupils' work is personal data and the product is sold in the UK, so the
  # bucket is placed in western Europe rather than left to land wherever the
  # first write happens to originate. A location hint is not a guarantee of
  # residency -- it is the only control R2 exposes.
  location      = local.env.r2.locationHint
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true

    # `location` is honoured at creation and not returned as a mutable
    # attribute afterwards, so an adopted bucket would otherwise show a
    # permanent diff -- and a replacement here destroys every pupil's uploads.
    ignore_changes = [location]
  }
}

# Object lifecycle on the same bucket: backup dumps written under `backups/`
# (backupObjectKey in src/lib/backup/backup.ts) are restore points, not pupil
# uploads. Room deletion and account erasure purge the prefixes directly, but
# neither path catches dumps orphaned by a crashed cycle or an abandoned room,
# so the bucket itself expires them. 30 days matches the promise in
# public/privacy.html: copies in backups are "gone within 30 days".
#
# max_age is measured in seconds (provider v5 schema), so 30 days.
resource "cloudflare_r2_bucket_lifecycle" "backup_expiry" {
  account_id  = local.account_id
  bucket_name = cloudflare_r2_bucket.board_files.name

  rules = [
    {
      id      = "expire-backup-dumps-after-30-days"
      enabled = true
      conditions = {
        prefix = "backups/"
      }
      delete_objects_transition = {
        condition = {
          max_age = 30 * 24 * 60 * 60
          type    = "Age"
        }
      }
    },
  ]
}

# There is deliberately NO cloudflare_r2_managed_domain and NO
# cloudflare_r2_custom_domain for this bucket. Either one would serve every
# pupil's uploaded picture on the open internet behind a guessable path,
# bypassing the room grant entirely. Absence is the design, not an oversight.
#
# Terraform can only refuse to create those; it cannot prove nobody enabled one
# through the dashboard. `npm run r2:check` reads the live bucket and fails when
# either exposure route is on, and CI runs it.
