# The Zero Trust login page teachers see.
#
# This object is ACCOUNT-wide, not per-environment. If a second environment ever
# shares this Cloudflare account, exactly one of them may set
# manage_login_branding, or the two stacks will overwrite each other on every
# apply. That is why it is a variable rather than something this file assumes.
resource "cloudflare_zero_trust_organization" "this" {
  count = var.manage_login_branding ? 1 : 0

  account_id  = local.account_id
  auth_domain = local.access_auth_domain
  name        = local.env.access.organizationName

  login_design = {
    header_text      = "SEN Tutor"
    footer_text      = "Teachers sign in here. Students join with a class PIN."
    background_color = "#0f172a"
    text_color       = "#f8fafc"
  }

  lifecycle {
    # The auth domain is the hostname every Access redirect and every issued JWT
    # is bound to. Changing it invalidates ACCESS_ISSUER and ACCESS_JWKS_URL in
    # the Worker at the same moment, so it is never an incidental edit.
    prevent_destroy = true
  }
}
