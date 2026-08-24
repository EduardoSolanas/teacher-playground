# Cloudflare Realtime SFU

This directory is the declarative Terraform specification for the single
Cloudflare Calls SFU app used by the future Teacher Playground voice feature.
It creates `teacher-playground-voice` in the account supplied by `account_id`
and protects it with `prevent_destroy`.

The app secret is returned only when Cloudflare creates the app. It is a
Worker secret, never a Worker variable or repository value. The dedicated
`provision-cloudflare-realtime.yml` workflow reconciles the named app first,
then stores its UID and (only on first creation) one-time secret using the same
production `CLOUDFLARE_API_TOKEN` secret and `CLOUDFLARE_ACCOUNT_ID` variable as
the playground deploy. Existing apps are never recreated and their secret is
never fetched or replaced.

The token must have effective account-level Calls SFU app read/write permission
(Calls Write/Edit), and it must be scoped to the correct Cloudflare account.
The playground asset deployment is complete; the CDN and R2 release path are
independent of this Realtime control-plane workflow.

GitHub Actions run `32783632121` exercised this reconciler after installation,
security scan, typecheck, 901 unit tests, static build, and 324 real Worker
tests passed. The first Calls list request returned HTTP 403/code 10000
(`Authentication error`), so the current production token still needs
effective Calls SFU Read and Calls Write/Edit permission in the correct account
scope. Cloudflare did not create an app; the UID and secret storage steps were
skipped.

Terraform state must be stored in an approved remote backend before using
`terraform apply` for production. Until then, use the idempotent workflow as
the live reconciler and keep the generated secret in Wrangler/Worker secret
storage only. If the first-run secret persistence step fails after app
creation, do not rerun the workflow immediately: an existing app deliberately
does not return its secret. Record the app UID from the workflow step, confirm
the app has not been used, delete that unused orphan through the Cloudflare
Calls API/dashboard, remove the partially written Worker secrets if present,
and rerun after fixing the Wrangler permission. If the app has been used, stop
and escalate to the Cloudflare account owner; the one-time secret cannot be
reconstructed by this repository.
