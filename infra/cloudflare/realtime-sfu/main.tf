variable "account_id" {
  description = "Cloudflare account that owns the Teacher Playground Realtime app."
  type        = string
  nullable    = false
}

variable "api_token" {
  description = "Cloudflare API token with Calls SFU app permissions."
  type        = string
  sensitive   = true
  nullable    = false
}

resource "cloudflare_calls_sfu_app" "voice" {
  account_id = var.account_id
  name       = "teacher-playground-voice"

  lifecycle {
    prevent_destroy = true
  }
}
