# Terraform state for production, in a private R2 bucket in the same Cloudflare
# account this stack describes.
#
# Used as:  terraform init -backend-config=environments/prod.backend.hcl
#
# The bucket is bootstrapped once by hand -- it cannot hold its own state. See
# infra/README.md. It must never be given an r2.dev managed domain or a custom
# domain: state contains resource ids and configuration for the whole account.
#
# Credentials are R2 API tokens supplied through the environment as
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, never written here.

bucket = "teacher-playground-tfstate"
key    = "cloudflare/prod.tfstate"

# R2's S3-compatible endpoint. The account id is not a secret -- it is already
# in wrangler.toml -- but it is read from the manifest everywhere else, and a
# backend block cannot interpolate, which is the one place it must be repeated.
endpoints = { s3 = "https://365b447990677931f6b7876de299f62f.r2.cloudflarestorage.com" }
region    = "auto"

# R2 is S3-compatible, not S3. These switch off the AWS-only calls Terraform
# would otherwise make while resolving credentials and validating the bucket.
skip_credentials_validation = true
skip_region_validation      = true
skip_requesting_account_id  = true
skip_metadata_api_check     = true
skip_s3_checksum            = true

# R2 does not implement the DynamoDB-based locking the S3 backend prefers, and
# S3-native conditional-write locking is not available either. Concurrency is
# controlled instead by the `concurrency` group on the infra workflow, which
# serialises every apply through one runner.
use_lockfile = false
