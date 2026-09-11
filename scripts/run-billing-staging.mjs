/**
 * Billing staging evidence runner (IMPLEMENTATION_SPEC.md §7.6 "Staging" row,
 * §13, §15.2; tests/e2e/billing-staging.spec.ts).
 *
 * Purpose: a named manual run that records the real test-mode round trip —
 * real Checkout -> webhook -> fetch -> apply -> paid badge, Portal cancel ->
 * downgrade, paid send_invoice -> members entitled, disputes won and lost, and
 * grace expiry via Test Clocks. Every §14 clause marked "staging" is
 * APPROVE-AS-BLOCKED until this run is recorded (§7.6 rules, §15.2).
 *
 * Fail-closed by design:
 *  - With E2E_STAGING_BASE_URL unset there is no staging environment
 *    (CLOUDFLARE_ACCESS_STAGING.md:114-126), so the run is blocked, never
 *    falsely green.
 *  - With the variables present this script STILL does not execute the spec
 *    today, and that is deliberate. The repo harness is local-only: run-e2e.mjs
 *    allocates ports, builds out/, boots a local wrangler dev worker and a
 *    local Access issuer, and probes loopback (scripts/run-e2e.mjs:133-269);
 *    playwright.config.ts throws without E2E_PORT / E2E_ACCESS_ISSUER /
 *    E2E_ACCESS_TOKEN and those values come from run-e2e.mjs (playwright.config.ts
 *    :5-14). There is no remote-target branch, and per AGENTS.md the repository
 *    "never invent[s] a Playwright config that skips scripts/run-e2e.mjs".
 *    Running `npx playwright test` directly would have to fabricate those
 *    local-only variables for a remote target — a fake run. Instead this script
 *    refuses, prints the blocker, and exits 2.
 *
 * To unlock: add a reversible, default-off remote-target branch to
 * scripts/run-e2e.mjs (guarded by an opt-in env flag) that maps
 * E2E_STAGING_BASE_URL/ACCESS_ISSUER/ACCESS_TOKEN onto the playwright run
 * without changing local behavior, then re-point this script at it.
 */

import { env, exit, stderr, stdout } from 'node:process';

const SPEC_15_2 =
  'IMPLEMENTATION_SPEC.md §7.6/§15.2 — staging does not exist yet ' +
  '(CLOUDFLARE_ACCESS_STAGING.md:114-126)';
const SPEC_13 =
  'IMPLEMENTATION_SPEC.md §13 — staging row: tests/e2e/billing-staging.spec.ts';

/** URL inputs come from workflow_dispatch inputs; credentials from secrets. */
const REQUIRED_ENV = [
  'E2E_STAGING_BASE_URL',
  'E2E_STAGING_ACCESS_ISSUER',
  'E2E_STAGING_ACCESS_TOKEN',
  'STRIPE_API_BASE',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
];

function failBlocked(lines) {
  const message = [
    'billing staging run blocked — no staging evidence was produced.',
    '',
    ...lines,
    '',
    `${SPEC_15_2} cements this: the §14 clauses marked "staging" are ` +
      'APPROVE-AS-BLOCKED (never APPROVE) until a staging environment exists ' +
      'and this run is recorded.',
    SPEC_13,
  ].join('\n');
  stderr.write(`\n${message}\n\n`);
  exit(2);
}

const baseUrl = env.E2E_STAGING_BASE_URL ?? '';

if (!baseUrl) {
  failBlocked([
    'E2E_STAGING_BASE_URL is not set.',
    '',
    'There is no staging environment to run against, so this is a blocker, not a',
    'green run. Provision a staging environment first (see',
    'CLOUDFLARE_ACCESS_STAGING.md), set the required variables, and re-run.',
  ]);
}

const missing = REQUIRED_ENV.filter((name) => !(env[name] ?? ''));
if (missing.length > 0) {
  failBlocked([
    `E2E_STAGING_BASE_URL is set (${baseUrl}) but these required variables are missing:`,
    '',
    missing.map((name) => `  - ${name}`),
    '',
    'Real Stripe test-mode keys are required for the staging row (§7.6):',
    'STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET for the api and webhook',
    'footprints, STRIPE_API_BASE for the api base, and the Access issuer and',
    'token for authenticating as staging tutors.',
  ]);
}

// All variables present, but there is still no honest way to run the spec:
// the only Playwright path in this repository is the local harness, and
// pointing it at a remote target would require fabricating local-only values.
failBlocked([
  'All staging variables are present, yet the spec cannot run from this repo yet.',
  '',
  'The repository harness is local-worker/local-issuer only:',
  '  - scripts/run-e2e.mjs boots a local wrangler dev worker, a local Access',
  '    issuer, and a local proxy; it has no remote-target branch.',
  '  - playwright.config.ts throws unless E2E_PORT / E2E_ACCESS_ISSUER /',
  '    E2E_ACCESS_TOKEN are set, and only run-e2e.mjs provides them.',
  '',
  'Running `npx playwright test tests/e2e/billing-staging.spec.ts` directly',
  'would have to fabricate those local-only variables and skip',
  'scripts/run-e2e.mjs — which AGENTS.md forbids. This runner refuses to fake',
  'a run. Wire the staging run through a default-off remote-target branch of',
  'scripts/run-e2e.mjs first, then dispatch this job again.',
]);

// Unreachable: failBlocked always exits 2.
stdout.write('unreachable\n');
exit(1);