# Excalidraw release CDN

This Terraform is the declarative specification for the production R2 bucket
and custom domain. The deploy workflow uses the same `CLOUDFLARE_API_TOKEN`
secret and `CLOUDFLARE_ACCOUNT_ID` environment variable as the playground
Worker. `scripts/excalidraw-cdn.mjs reconcile` performs the idempotent live API
reconciliation, then the upload step publishes the installed fork release.

The application consumes the immutable base URL:

`https://excalidraw-assets.sen-tutor.co.uk/releases/0.18.1-tp.2/dist/prod/`

Use the default deploy workflow's manual `cdn` target to publish only this
release. It runs the repository gates, reconciles the bucket and custom domain,
uploads the immutable `dist/prod` objects plus root `latest.json`, and runs
`node scripts/excalidraw-cdn.mjs verify` against the public domain. The target
does not deploy the playground Worker; `full` remains the combined Worker and
CDN deployment.
