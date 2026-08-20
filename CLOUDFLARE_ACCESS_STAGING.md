# Cloudflare Access staging boundary

Last reviewed: 2026-08-17

This is the observable configuration and verification contract for the staging
Access boundary. It is not evidence that the configuration has been applied.
Never add account tokens, OAuth client secrets, Access cookies, or JWTs here.

## Two hostnames (teacher + guest)

Both hostnames route to the same Worker. The edge boundary differs by hostname:

| Hostname | Access application | Serves |
| --- | --- | --- |
| Teacher (`TEACHER_HOSTNAME`) | **Yes** — one self-hosted application | Full app (teachers, Access-authenticated users) |
| Guest (`GUEST_HOSTNAME`) | **No — deliberately none** | Guest join surface only |

- **Teacher hostname:** keep exactly one **Self-hosted / public hostname**
  Access application scoped to that **exact hostname, never a wildcard**. A
  `*.<zone>` application would also match the guest hostname (for example
  `join.<zone>`) and silently break guest join.
- **Guest hostname:** DNS record and Worker route only — **no Access
  application of any kind**. Adding Access in front of the guest hostname breaks
  guest join; its absence is the design.
- **No `Bypass` policy anywhere.** This design does not need one, and a Bypass
  would disable Access request logging for whatever it covers.
- Record `TEACHER_HOSTNAME` and `GUEST_HOSTNAME` as Worker environment
  variables. If either is unset, the Worker treats **every** request as
  teacher-host (the guest surface does not exist); never the reverse.
- **`workers_dev = false`** in `wrangler.toml` is a **release blocker** once
  the guest surface exists: `*.workers.dev` is an unauthenticated entrance that
  bypasses the zone WAF and rate limiting.
- **Rate limiting:** the free plan allows exactly one rate-limiting rule. Spend
  it on `POST /auth/guest` on the guest hostname — the most abusable
  unauthenticated route once guests exist. Room creation stays account-gated with
  app-level quotas.

## Required application configuration (teacher hostname)

- Create exactly one **Self-hosted / public hostname** Access application for
  the complete **teacher** staging hostname, with no narrower path. Protecting
  the whole hostname covers the static site, `/api/*`, and the `/signaling`
  WebSocket upgrade under the same boundary. Do **not** scope this application
  as a zone wildcard.
- Enable only the Google and Facebook identity providers for this application.
  Apple and one-time PIN are out of scope.
- Attach an `Allow` policy restricted to the Google and Facebook login methods.
  Do not use `Include Everyone`, `Bypass`, or an all-valid-email/OTP rule.
- Do not create path-specific Access applications for APIs or signaling. A more
  specific path application would take precedence and could silently diverge
  from the hostname policy.
- Keep the application deny-by-default. Automated staging probes, if later
  required, must use an explicit, narrowly scoped Service Auth policy and must
  not weaken the human-user application policy.
- The Worker must still validate the expected Access application audience and
  human identity, then enforce local account/session/room authorization. Access
  is coarse authentication, not endpoint authorization.

Cloudflare's official documentation describes
[public-hostname self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/),
[whole-site versus path protection](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/),
and warns that [Bypass disables Access enforcement and logging](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).

## Evidence required before checking the Phase 1 configuration task

Retain a sanitized dashboard/API export showing:

- one application ID, the teacher staging hostname without a path, and its Access
  AUD;
- evidence that the guest staging hostname has **no** Access application;
- the application type is self-hosted/public-hostname;
- only Google and Facebook are selected login methods;
- every attached human policy is `Allow`, with no `Bypass`, OTP, `Everyone`, or
  alternate-path application;
- application and policy session durations;
- the Google and Facebook IdP connection tests both succeed.

Run staging-only probes and retain status/header evidence without cookies or
tokens:

- unauthenticated `GET /`, an API request, and a WebSocket upgrade cannot reach
  the Worker application behavior;
- a real Google login reaches the app and the Worker observes the expected
  Access context/audience;
- a real Facebook login does the same;
- a forged identity header and a direct alternate hostname fail closed;
- Access logs contain the permitted and denied attempts.

### Expired browser-session AJAX probe

Cloudflare documents that an Access-protected SPA must send
`X-Requested-With: XMLHttpRequest` on AJAX requests to receive a `401` when the
Access session has expired, rather than being sent an HTML login response. It
also documents `credentials: same-origin` for Fetch API requests that must carry
the Access cookie. See Cloudflare's official
[session-management AJAX guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#ajax)
and [Access troubleshooting guidance](https://developers.cloudflare.com/cloudflare-one/troubleshooting/access/).

This repository proves the client header, cookie credentials mode, JSON `401`,
and no-navigation behavior against the local cryptographic Access harness only.
Before checking the staging gate, repeat this separate staging-only checklist:

- sign in through each configured human IdP and load the SPA successfully;
- expire or revoke the real staging Access application session without changing
  application code or adding a bypass policy;
- trigger a migrated SPA `/api/*` action and capture the request showing exactly
  `X-Requested-With: XMLHttpRequest` with the Access cookie redacted;
- verify Cloudflare responds `401` with no HTML login document or redirect and
  the browser remains on the SPA origin while showing the expired-session UI;
- refresh or reauthenticate, then verify the same action succeeds with a new
  Access application token;
- retain sanitized HTTP and browser evidence. Do not store tokens or cookies.

No real Cloudflare edge or staging Access session was available during local
implementation, so this checklist is intentionally not marked verified.

## Current blocker

The repository does not contain—and must not contain—the required Cloudflare
account/zone, staging hostname, Access application authority, Google OAuth
client, or Facebook app credentials. No authenticated Cloudflare connection is
available in this task. The configuration and its real social-login evidence
therefore remain unapplied and unverified.

To unblock, an authorized owner must provide a non-production Cloudflare account
and zone, choose the teacher and guest staging hostnames, configure the Google
and Facebook OAuth applications with Cloudflare's callback, and authorize an
isolated staging deployment/configuration test. Production deployment is not
authorized.
