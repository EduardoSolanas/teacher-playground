# Adoption of resources that already exist in Cloudflare.
#
# Production was provisioned by hand and by scripts/cloudflare-*.mjs before this
# stack existed, so the first run for production is an ADOPTION, not a creation.
# Running `terraform apply` against it without these set would try to create a
# second Access application covering the teacher hostname -- which
# `npm run access:check` reports as a failure -- and would fail outright on the
# taken bucket name.
#
# Each block is for_each'd over a map that is empty when its variable is unset,
# which is how an import block is made conditional. A brand-new environment
# leaves them all unset and Terraform creates everything.
#
# The id format is "<parent id>/<resource id>" -- the parent being the account,
# or the zone for a zone-scoped resource. NOT "accounts/<id>/<id>": the provider
# splits on "/" and builds the request path from the parts, so that prefix
# produced GET /accounts/accounts/r2/buckets/<account id> and a 404. Only a real
# plan against the real API could have found that, and it did.
#
# infra/README.md carries the runbook for reading each id.

import {
  for_each = var.adopt_access_application_id == null ? {} : { this = var.adopt_access_application_id }
  to       = cloudflare_zero_trust_access_application.teacher
  id       = "${local.account_id}/${each.value}"
}

import {
  for_each = var.adopt_access_policy_id == null ? {} : { this = var.adopt_access_policy_id }
  to       = cloudflare_zero_trust_access_policy.allow_teachers
  id       = "${local.account_id}/${each.value}"
}

# R2 takes a THIRD segment, the jurisdiction. "default" is the ordinary one; a
# bucket created under a jurisdiction (eu, fedramp) names that instead. The
# provider is explicit when it is wrong: expected urlencoded segments
# "<account_id>/<bucket_name>/<jurisdiction>".
import {
  for_each = var.adopt_r2_bucket ? { this = local.env.r2.boardFilesBucket } : {}
  to       = cloudflare_r2_bucket.board_files
  id       = "${local.account_id}/${each.value}/default"
}

import {
  for_each = var.adopt_guest_rate_limit_ruleset_id == null ? {} : { this = var.adopt_guest_rate_limit_ruleset_id }
  to       = cloudflare_ruleset.guest_auth_rate_limit
  id       = "${data.cloudflare_zone.this.id}/${each.value}"
}

# The Zero Trust organization is a singleton that always exists once Zero Trust
# is enabled, so it is imported by account id alone whenever this stack manages
# it -- there is no "create" case to fall back to.
import {
  for_each = var.manage_login_branding ? { this = local.account_id } : {}
  to       = cloudflare_zero_trust_organization.this[0]
  id       = each.value
}
