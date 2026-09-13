terraform {
  # >= 1.7 is required for `import` blocks with for_each, which is how this
  # stack adopts resources that already exist in Cloudflare (see imports.tf).
  # Adoption, not creation, is the normal first run: production was provisioned
  # by hand and by scripts/cloudflare-*.mjs long before this stack existed.
  required_version = ">= 1.7.0"

  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # v5 is a breaking rewrite of v4's schema (attributes replaced blocks).
      # Every resource here is written against v5.
      version = "~> 5.0"
    }
  }

  # State lives in a private R2 bucket over R2's S3-compatible endpoint, one
  # key per environment, so it never leaves the Cloudflare account it
  # describes. The bucket cannot hold its own state and is bootstrapped once by
  # hand -- see infra/README.md.
  #
  # Deliberately partial: bucket, key, and endpoint come from
  # environments/<env>.backend.hcl via `terraform init -backend-config=`, so one
  # root module serves every environment.
  backend "s3" {}
}

# Credentials come from CLOUDFLARE_API_TOKEN in the environment and are never
# written to a file this repository tracks.
provider "cloudflare" {}
