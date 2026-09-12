variable "environment" {
  type        = string
  description = <<-DESC
    Which entry of infra/environments.json this run configures. Every other
    value is read from that file, so this is the only knob that selects an
    environment -- there is no second place to keep them in step.
  DESC

  validation {
    condition     = contains(keys(jsondecode(file("${path.module}/../environments.json")).environments), var.environment)
    error_message = "Unknown environment. Add it to infra/environments.json first."
  }
}

# ---------------------------------------------------------------------------
# Adoption switches.
#
# Production's Access application and R2 bucket already exist. Left null, this
# stack creates them -- correct for a brand-new environment, and wrong for
# production, where it would produce a SECOND Access application covering the
# teacher hostname (which scripts/cloudflare-access.mjs reports as a failure)
# or fail outright on the taken bucket name.
#
# Set these to the existing ids and the first plan adopts what is already there
# instead. infra/README.md explains where to read each id.
# ---------------------------------------------------------------------------

variable "adopt_access_application_id" {
  type        = string
  default     = null
  description = "Existing Cloudflare Access application UUID to adopt, or null to create one."
}

variable "adopt_access_policy_id" {
  type        = string
  default     = null
  description = "Existing Access policy UUID to adopt, or null to create one."
}

variable "adopt_r2_bucket" {
  type        = bool
  default     = false
  description = "True when the board-files bucket already exists and should be adopted rather than created."
}

variable "adopt_guest_rate_limit_ruleset_id" {
  type        = string
  default     = null
  description = "Existing http_ratelimit ruleset id to adopt, or null to create one."
}

variable "manage_login_branding" {
  type        = bool
  default     = true
  description = <<-DESC
    Whether this stack owns the Zero Trust organization's login page design.
    The organization is account-wide, not per-environment: if a second
    environment ever shares this Cloudflare account, exactly one of them may
    set this true, or the two will fight over the same object on every apply.
  DESC
}
