# Everything this stack needs, read once from the manifest. No Cloudflare value
# is written twice in this directory: if it is not derived from `env` below, it
# does not belong here, and src/infra/environments.test.ts fails the build if one
# appears.
locals {
  manifest = jsondecode(file("${path.module}/../environments.json"))
  env      = local.manifest.environments[var.environment]

  account_id = local.env.accountId

  teacher_hostname   = local.env.hostnames.teacher
  guest_hostname     = local.env.hostnames.guest
  marketing_hostname = local.env.hostnames.marketing

  # The team domain that issues every Access JWT. ACCESS_ISSUER in the Worker is
  # this hostname with a scheme, and ACCESS_JWKS_URL is it with Cloudflare's
  # fixed certs path -- one value wearing three shapes. Deriving it here is what
  # stops the three drifting apart.
  #
  # That the manifest's issuer and jwksUrl agree is asserted by
  # src/infra/environments.test.ts, which runs on every commit rather than only
  # when someone plans.
  access_auth_domain = replace(local.env.access.issuer, "https://", "")
}

data "cloudflare_zone" "this" {
  filter = {
    name    = local.env.zone
    account = { id = local.account_id }
  }
}
