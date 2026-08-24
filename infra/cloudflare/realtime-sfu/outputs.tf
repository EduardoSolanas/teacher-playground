output "uid" {
  description = "Cloudflare Realtime SFU app UID used by the Worker."
  value       = cloudflare_calls_sfu_app.voice.uid
}

output "secret" {
  description = "One-time Cloudflare Realtime SFU app secret; store as a Worker secret."
  value       = cloudflare_calls_sfu_app.voice.secret
  sensitive   = true
}
