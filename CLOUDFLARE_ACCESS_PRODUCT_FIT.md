# Cloudflare Access product-fit decision

Last verified: 2026-08-17

## Decision status

Cloudflare Access is technically suitable for the planned coarse authentication
boundary and supports the required Google and Facebook identity providers. It
must not be made mandatory for production until the product owner records both:

1. the expected maximum number of distinct teachers and students who may
   authenticate; and
2. acceptance of the applicable Cloudflare One seat cost and support level.

The repository does not currently contain that rollout estimate or budget
decision, so commercial product fit is **blocked**, not approved.

## Current official limits and pricing

- Cloudflare's [Zero Trust pricing](https://www.cloudflare.com/plans/zero-trust-services/)
  lists Free at 50 users, Pay-as-you-go at USD 7 per user per month with no user
  limit, and Contract at custom annual per-user pricing.
- Cloudflare's [seat-management documentation](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/)
  says any Access authentication event consumes one seat. One identity consumes
  one seat regardless of application or login count, and keeps it until an
  administrator removes that user. Once all seats are consumed, additional
  users are blocked.
- Removing a Cloudflare seat is billing administration, not application
  authorization. The same documentation warns that removing a user does not by
  itself prevent future Access authentication. Local account disablement,
  session revocation, and room authorization therefore remain mandatory.
- Current [Access account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/)
  allow 500 Access applications, 50 identity providers, 500 reusable policies,
  and 50 domains per application by default. This project needs one application,
  two identity providers, and one hostname, so those configuration limits are
  not constraining.
- Cloudflare documents both [Google](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/)
  and [Facebook](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/facebook-login/)
  as supported Access identity providers. Apple is intentionally out of scope.

## Go/no-go thresholds

| Expected distinct authenticating people | Decision required |
| --- | --- |
| 1–50 total | Free is commercially plausible; accept community support and verify the actual account plan before rollout. |
| More than 50 | Do not launch on Free. Approve Pay-as-you-go cost (`users × USD 7/month`) or obtain a Contract quote before making Access mandatory. |
| Unknown or unbounded student population | No-go until a maximum seat forecast, funding owner, and over-capacity behavior are approved. |

Do not assume that room capacity is the Access seat count: seats are distinct
people authenticating across the account, not concurrent users in one room.
Do not rely on an education or student promotion as an Access-seat entitlement
unless Cloudflare confirms it in writing for this account.

## Evidence needed to close the Phase 1 task

- Product owner: expected peak distinct teacher identities: `TBD`.
- Product owner: expected peak distinct student identities: `TBD`.
- Billing owner: chosen Free, Pay-as-you-go, or Contract plan: `TBD`.
- Billing owner: accepted monthly/annual ceiling and support level: `TBD`.
- Cloudflare account owner: dashboard evidence that the selected plan has the
  required seats: `TBD`.

Until those fields are completed, later local authentication work may use the
documented architecture, but production Access configuration and the product-fit
checkbox remain unverified.
