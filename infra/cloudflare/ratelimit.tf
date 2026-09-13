# Edge rate limit on guest PIN submissions.
#
# The Worker already enforces the real product limit (GUEST_AUTH_RATE_MAX, 5 per
# IP per minute, src/lib/worker/rateLimits.ts). This rule is the outer bound: it
# sheds volumetric abuse at the edge, before a Worker invocation is billed and
# before IdentityDO is touched at all.
#
# The threshold is deliberately far looser than the in-Worker limiter, so a
# legitimate client always meets the Worker's considered 429 rather than an
# opaque edge block. This rule exists for the traffic that would never have been
# legitimate.
#
# The zone's free plan allows exactly one rate-limit rule, which DEPLOY.md
# reserves for this. Adding a second here will fail at apply time, not review
# time.
resource "cloudflare_ruleset" "guest_auth_rate_limit" {
  zone_id = data.cloudflare_zone.this.id
  name    = "Guest join rate limit"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules = [{
    ref         = "guest_auth_rate_limit"
    description = "Rate limit ${local.env.guestRateLimit.method} ${local.env.guestRateLimit.path} on the guest hostname"
    action      = "block"
    enabled     = true

    # Scoped to the guest hostname. The teacher hostname sits behind Access and
    # has no unauthenticated POST worth limiting here; the marketing hostname
    # serves static pages. Matching on host keeps the zone's single rule aimed
    # at the one unauthenticated write path in the product.
    expression = format(
      "(http.host eq \"%s\" and http.request.method eq \"%s\" and http.request.uri.path eq \"%s\")",
      local.guest_hostname,
      local.env.guestRateLimit.method,
      local.env.guestRateLimit.path,
    )

    ratelimit = {
      # Per client IP. A guest has no account and no session at this point --
      # the PIN submission is what creates one -- so the IP is the only
      # characteristic that exists yet.
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = local.env.guestRateLimit.periodSeconds
      requests_per_period = local.env.guestRateLimit.requestsPerPeriod
      mitigation_timeout  = local.env.guestRateLimit.mitigationTimeoutSeconds
    }
  }]
}
