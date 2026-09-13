output "environment" {
  value       = var.environment
  description = "The infra/environments.json entry this state describes."
}

output "access_application_aud" {
  value = cloudflare_zero_trust_access_application.teacher.aud

  description = <<-DESC
    The application AUD the Worker must verify every Access JWT against.

    This is the one value that flows OUT of Terraform and back into the
    manifest: Cloudflare generates it, so `access.audience` in
    infra/environments.json cannot be its source. After an apply that creates or
    replaces the application, copy this into the manifest and redeploy. The
    Worker rejects every token while the two disagree, and
    `npm run access:check` compares them against the live application.
  DESC
}

output "access_auth_domain" {
  value       = local.access_auth_domain
  description = "Team domain that issues Access JWTs; must match ACCESS_ISSUER."
}

output "board_files_bucket" {
  value       = cloudflare_r2_bucket.board_files.name
  description = "R2 bucket behind the Worker's BOARD_FILES binding."
}

output "zone_id" {
  value       = data.cloudflare_zone.this.id
  description = "Zone that hosts all three Worker custom domains."
}
