variable "account_id" {
  type        = string
  description = "Cloudflare account that owns the R2 bucket."
}

data "cloudflare_zone" "sen_tutor" {
  filter = {
    name    = "sen-tutor.co.uk"
    account = { id = var.account_id }
  }
}

resource "cloudflare_r2_bucket" "releases" {
  account_id    = var.account_id
  name          = "teacher-playground-excalidraw"
  storage_class = "Standard"

  lifecycle { prevent_destroy = true }
}

resource "cloudflare_r2_bucket_cors" "distribution" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.releases.name

  rules = [{
    id = "public-distribution-read"
    allowed = { methods = ["GET", "HEAD"], origins = ["*"] }
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }]
}

resource "cloudflare_r2_custom_domain" "distribution" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.releases.name
  domain      = "excalidraw-assets.sen-tutor.co.uk"
  enabled     = true
  min_tls     = "1.2"
  zone_id     = data.cloudflare_zone.sen_tutor.id

  lifecycle { prevent_destroy = true }
}
