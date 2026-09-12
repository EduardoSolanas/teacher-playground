# Production. Every Cloudflare value comes from infra/environments.json; the
# only settings here are which environment this is and how this stack should
# meet resources that already exist.

environment = "prod"

# Production predates this stack. Fill each id in from the runbook in
# infra/README.md before the first apply, then leave them set -- an import block
# whose resource is already in state is a no-op, so they are safe to keep.
#
# Applying with these unset would create a SECOND Access application covering
# the teacher hostname, which `npm run access:check` reports as a failure, and
# would fail outright on the taken bucket name.
adopt_access_application_id       = null
adopt_access_policy_id            = null
adopt_guest_rate_limit_ruleset_id = null

# The bucket exists: scripts/cloudflare-r2.mjs created it.
adopt_r2_bucket = true

# Off until access.organizationName is filled in. The Zero Trust organization is
# account-wide and its `name` is required, so managing it with a guessed name
# would rename the whole organization as a side effect of a branding change.
# `npm run access:branding` remains the interim path; it PUTs only login_design.
manage_login_branding = false
