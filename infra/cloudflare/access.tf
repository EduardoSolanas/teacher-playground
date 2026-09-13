# Cloudflare Access for the split-hostname guest design.
#
# guest_implementation.md §6.5 states four invariants. Two of them are shapes
# this stack can hold, and two are absences it cannot prove:
#
#   1. The teacher hostname has exactly one Access application.   <- held here
#   2. That application is an EXACT hostname, never a wildcard.   <- held here
#      (asserted in locals.tf; a `*.<zone>` application would cover the guest
#      hostname and break guest join, and would put a login in front of the
#      public landing page.)
#   3. The guest hostname has NO Access application of any kind.  <- not held
#   4. No Bypass policy exists anywhere.                          <- not held
#
# Terraform can refuse to create 3 and 4; it cannot see an application or policy
# some other tool made. Proving an absence needs a read of the live account,
# which is what `npm run access:check` does, blocking, in CI. That script is not
# a leftover from before this stack -- it covers what this stack structurally
# cannot.

resource "cloudflare_zero_trust_access_policy" "allow_teachers" {
  account_id = local.account_id
  name       = "Allow signed-in teachers"
  decision   = "allow"

  # Anyone who completes one of the organization's configured identity providers.
  #
  # This is deliberate, and it moves the boundary rather than removing it.
  # Production ran an email allowlist of one address while the product was being
  # built; that is a closed front door, not a design. The application behind it
  # is built for open tutor sign-up: IdentityDO creates an account for whatever
  # Access subject appears, TUTOR_ACCOUNT_CAP refuses a BRAND-NEW account once
  # active accounts reach the cap (never an existing one), and the Worker serves
  # a "Tutor sign-ups are paused" page when it does. None of that machinery
  # means anything if a human has to add each address in the dashboard first.
  #
  # So Access answers "is this a real, authenticated person", and the product
  # answers "may this person have a tutor account" -- the cap, the plan, and
  # billing. Those are enforced in code, with tests, which the dashboard rule
  # never was.
  #
  # The consequence is worth stating plainly: with `everyone`, the cap is the
  # only thing between the internet and a tutor account. If the cap is ever
  # raised or bypassed, this rule is not a second line of defence.
  include = [{
    everyone = {}
  }]
}

resource "cloudflare_zero_trust_access_application" "teacher" {
  account_id = local.account_id
  name       = local.env.access.applicationName

  # EXACT hostname. Never a wildcard, never the guest or marketing hostname.
  domain = local.teacher_hostname
  type   = "self_hosted"

  session_duration = local.env.access.sessionDuration

  # Every attribute below is pinned to what the account already has, so adopting
  # this application changes only what was actually decided: the policy rule and
  # the rate-limit rule. An adoption that also flips half a dozen settings to
  # provider defaults is not an adoption, it is an unreviewed change wearing one.
  app_launcher_visible = true

  # Pinned, NOT empty. Empty means "every provider the organization has
  # configured", which is the same thing only while exactly one exists. With an
  # `everyone` policy in front, adding a second provider would silently open
  # another teacher door with no change to this repository.
  allowed_idps = local.env.access.allowedIdpIds

  # These three keep the application's current cookie and CORS behaviour.
  # http_only_cookie_attribute in particular would default to true, which is a
  # genuine improvement -- and a change to a live auth cookie, which
  # CLOUDFLARE_ACCESS_STAGING.md has a whole XHR checklist written against. It
  # deserves its own change and its own re-run of that checklist, not a ride
  # along with an import.
  http_only_cookie_attribute = false
  enable_binding_cookie      = false
  options_preflight_bypass   = false

  # The login page must offer the choice. Skipping straight to one provider
  # strands every teacher who used a different one.
  auto_redirect_to_identity = false

  policies = [{
    id         = cloudflare_zero_trust_access_policy.allow_teachers.id
    precedence = 1
  }]

  lifecycle {
    # Destroying this application removes the login in front of the teacher
    # surface. The Worker still verifies the Access JWT and would refuse every
    # request, so the failure is closed rather than open -- but it is a total
    # outage, and it must not happen as a side effect of some other change.
    prevent_destroy = true

    # Checked here rather than trusted from the manifest, because this is the
    # resource that would do the damage. A plan that would widen the
    # application's reach stops before it is a plan.
    precondition {
      condition     = !startswith(local.teacher_hostname, "*")
      error_message = "The Access application domain must be an exact hostname. A wildcard would cover the guest hostname and break guest join entirely, and would put a login in front of the public landing page."
    }

    precondition {
      condition     = local.teacher_hostname != local.guest_hostname
      error_message = "The teacher and guest hostnames must differ. Access in front of the guest hostname demands a login from every pupil joining with a class PIN."
    }

    precondition {
      condition     = local.teacher_hostname != local.marketing_hostname
      error_message = "The teacher and marketing hostnames must differ. The Access JWT arrives only on paths an Access application protects, so public pages cannot be public on a protected hostname."
    }
  }
}

# The guest hostname gets DNS and a Worker route and NOTHING here. Its absence
# from this file is the design: an Access application in front of it would
# demand a login from every pupil joining with a class PIN.
#
# The marketing hostname is likewise absent, and for a second reason: the Access
# JWT arrives only on paths an Access application protects, so public pages
# cannot be public on a protected hostname.
