output "bucket_name" {
  value       = cloudflare_r2_bucket.releases.name
  description = "Immutable Excalidraw release bucket."
}

output "distribution_base_url" {
  value       = "https://${cloudflare_r2_custom_domain.distribution.domain}/releases/0.18.1-tp.2/dist/prod/"
  description = "Pinned Excalidraw release base URL."
}
