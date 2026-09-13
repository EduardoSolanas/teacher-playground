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
# The id format is PER RESOURCE, and the shapes are opposites. There is no rule
# to infer; each was learned from the provider refusing the other:
#
#   R2 bucket      "<account_id>/<bucket_name>/<jurisdiction>"
#   Access app     "accounts/<account_id>/<app_id>"
#   Access policy  "<account_id>/<policy_id>"
#   Ruleset        "zones/<zone_id>/<ruleset_id>"   (still unverified)
#
# Three different shapes across four resources, including two that sit in the
# same file and describe the same account. The application takes the
# discriminator; the policy right next to it does not.
#
# The application takes "accounts" or "zones" first because it can be scoped
# either way, and a missing one is reported as "invalid discriminator segment".
# R2 reads a leading "accounts" as the account id, which produced a 404 on
# /accounts/accounts/r2/buckets/<account id>. The policy rejects the prefix
# outright: expected urlencoded segments "<account_id>/<policy_id>".
#
# Only a real plan against the real API establishes any of this.
#
# infra/README.md carries the runbook for reading each id.

import {
  for_each = var.adopt_access_application_id == null ? {} : { this = var.adopt_access_application_id }
  to       = cloudflare_zero_trust_access_application.teacher
  id       = "accounts/${local.account_id}/${each.value}"
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
  id       = "zones/${data.cloudflare_zone.this.id}/${each.value}"
}

# The Zero Trust organization is a singleton that always exists once Zero Trust
# is enabled, so it is imported by account id alone whenever this stack manages
# it -- there is no "create" case to fall back to.
import {
  for_each = var.manage_login_branding ? { this = local.account_id } : {}
  to       = cloudflare_zero_trust_organization.this[0]
  id       = each.value
}
