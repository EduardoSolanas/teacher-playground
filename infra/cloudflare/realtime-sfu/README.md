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

The token must have account-level Calls SFU app read/write permission. The
current playground asset deployment remains blocked because the R2 service is
not enabled; account activation is a prerequisite, as recorded in GitHub
Actions run `32680222826`. That R2 blocker is independent of this Realtime
control-plane workflow.

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
