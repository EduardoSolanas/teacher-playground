#!/usr/bin/env node
/**
 * R2 provisioning for the board file store.
 *
 * Board images cannot live in the whiteboard document: a Durable Object value
 * is capped at 2MB and the document is replayed to every peer that joins. They
 * go to R2 instead, under `rooms/<roomId>/files/<fileId>`, and the Worker
 * decides who may read them.
 *
 * ONE bucket per environment. Not one per teacher and not one per
 * room, for two reasons that are worth stating because the instinct is
 * otherwise:
 *
 *   1. A Worker reaches R2 through a *binding*, and bindings are fixed at
 *      deploy time. A bucket per room would need a redeploy for every room a
 *      teacher creates, which is not a design so much as an impossibility.
 *      Reaching arbitrary buckets at runtime instead would mean holding S3
 *      credentials in the Worker — strictly worse than the binding it replaced.
 *   2. Buckets are not the isolation primitive here; the room grant is. One
 *      room's images are unreachable from another because RoomDO refuses the
 *      request, not because the bytes sit in a different container. That check
 *      is what a test can hold, and there is one that does.
 *
 * The one axis that DOES deserve separate buckets is the environment. Staging
 * must not be able to read or overwrite production's images, and a bucket is
 * the cheapest hard line between them.
 *
 * Invariants this checks, none of which any test in this repository can prove
 * because they live in Cloudflare rather than in code:
 *
 *   1. The bucket named by infra/environments.json exists.
 *   2. It is NOT public. R2 can expose a bucket on an r2.dev URL or a custom
 *      domain, and either one would put every pupil's uploaded picture on the
 *      open internet behind a guessable path, bypassing the room grant
 *      entirely. Absence of public access is the design, not an oversight.
 *
 * Terraform (infra/cloudflare/r2.tf) declares the bucket. It cannot prove
 * invariant 2, which is an ABSENCE: Terraform creates no public domain for the
 * bucket, but it cannot see one enabled through the dashboard, because an
 * unmanaged resource is invisible to it. Reading the live bucket is the only
 * thing that settles that, which is what this script does.
 *
 * Usage:
 *   node scripts/cloudflare-r2.mjs check    # read-only (default)
 *   node scripts/cloudflare-r2.mjs apply    # create the bucket if absent
 *
 * The environment is chosen by TP_ENV, or is the only one
 * `infra/environments.json` defines. The bucket name and location come from
 * that manifest. This script used to regex-parse the first `[[r2_buckets]]`
 * block in wrangler.toml, which stops being correct the moment a second
 * environment adds its own: the first match would still be production's.
 *
 * Credentials come from the environment and are never written to disk:
 *   CLOUDFLARE_API_TOKEN   required; needs Workers R2 Storage: Edit
 *   CLOUDFLARE_ACCOUNT_ID  optional; overrides the manifest's accountId
 *
 * Store the token in `.dev.vars` (gitignored) or export it for one shell.
 * Never paste it into a file this repository tracks.
 */

import { readEnvironment, resolveEnvironmentName } from './lib/environments.mjs';

const API = 'https://api.cloudflare.com/client/v4';

function fail(message) {
  console.error(`\n  ERROR  ${message}\n`);
  process.exit(1);
}

/**
 * Where the bytes live, when Cloudflare offers a choice.
 *
 * Pupils' work is personal data and the product is sold in the UK, so the
 * bucket is hinted to western Europe rather than left to land wherever the
 * first write happens to originate. A hint is not a guarantee of residency —
 * it is the only control R2 exposes, and the alternative is no control at all.
 *
 * The manifest carries the Terraform provider's uppercase spelling; this REST
 * API takes the lowercase one, so the single stored value is lowered here
 * rather than written twice.
 */
function locationHint(environment) {
  return String(environment.r2?.locationHint ?? 'WEUR').toLowerCase();
}

function bucketNameFor(environment) {
  const name = environment.r2?.boardFilesBucket;
  if (!name) {
    fail('infra/environments.json has no r2.boardFilesBucket for this environment. '
      + 'The binding is what the Worker reaches R2 through; without a bucket the '
      + 'upload route finds env.BOARD_FILES undefined at runtime.');
  }
  return name;
}

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  // Read is enough to check; only `apply` creates a bucket.
  const write = (process.argv[2] ?? 'check') !== 'check';
  fail('CLOUDFLARE_API_TOKEN is not set. Create a token with Workers R2 '
    + `Storage: ${write ? 'Edit' : 'Read'} permission, then export it for this `
    + 'shell.');
}

async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok && body.success !== false, status: response.status, body };
}

async function apiOrFail(path, init = {}) {
  const result = await api(path, init);
  if (!result.ok) {
    const detail = (result.body.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ');
    fail(`${init.method ?? 'GET'} ${path} -> ${result.status}${detail ? ` (${detail})` : ''}`);
  }
  return result.body.result;
}

async function resolveAccountId(environment) {
  // Manifest ahead of discovery: a login that can see more than one account
  // must not be able to report a green against an account nothing is deployed
  // to.
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  if (environment.accountId) return environment.accountId;
  const accounts = await apiOrFail('/accounts');
  if (accounts.length !== 1) {
    fail(`Found ${accounts.length} accounts. Set CLOUDFLARE_ACCOUNT_ID to choose one:\n`
      + accounts.map((a) => `    ${a.id}  ${a.name}`).join('\n'));
  }
  return accounts[0].id;
}

async function findBucket(accountId, name) {
  const result = await api(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(name)}`);
  return result.ok ? (result.body.result ?? {}) : null;
}

/**
 * Whether R2 is serving this bucket to the internet directly.
 *
 * Both routes have to be checked. `r2.dev` is the one-click toggle, and a
 * custom domain is the deliberate version of the same exposure; either makes
 * the room grant irrelevant for anyone holding a URL.
 */
async function publicExposure(accountId, name) {
  const exposure = [];
  const managed = await api(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(name)}/domains/managed`);
  if (managed.ok && managed.body.result?.enabled) {
    exposure.push(`r2.dev managed domain enabled (${managed.body.result.domain ?? 'unknown host'})`);
  }
  const custom = await api(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(name)}/domains/custom`);
  if (custom.ok) {
    for (const domain of custom.body.result?.domains ?? []) {
      if (domain.enabled) exposure.push(`custom domain enabled (${domain.domain})`);
    }
  }
  return exposure;
}

async function check(accountId, name) {
  const bucket = await findBucket(accountId, name);
  if (!bucket) {
    console.log(`\n  MISSING  bucket "${name}" does not exist in account ${accountId}.`);
    console.log('           Run: node scripts/cloudflare-r2.mjs apply\n');
    process.exitCode = 1;
    return;
  }

  console.log(`\n  OK       bucket "${name}" exists`
    + (bucket.location ? ` (location ${bucket.location})` : ''));

  const exposure = await publicExposure(accountId, name);
  if (exposure.length > 0) {
    console.error('\n  ERROR    bucket is publicly reachable, which bypasses the room grant:');
    for (const line of exposure) console.error(`             - ${line}`);
    console.error('           Disable public access; the Worker is the only intended reader.\n');
    process.exitCode = 1;
    return;
  }
  console.log('  OK       no public access (r2.dev disabled, no enabled custom domain)\n');
}

async function apply(accountId, name, hint) {
  const existing = await findBucket(accountId, name);
  if (existing) {
    console.log(`\n  OK       bucket "${name}" already exists; nothing to create.\n`);
    return check(accountId, name);
  }

  await apiOrFail(`/accounts/${accountId}/r2/buckets`, {
    method: 'POST',
    body: JSON.stringify({ name, locationHint: hint }),
  });
  console.log(`\n  CREATED  bucket "${name}" (location hint ${hint})`);
  // Created private: R2 buckets expose nothing until a domain is turned on,
  // so this reports rather than configures, and fails if that ever changes.
  return check(accountId, name);
}

const command = process.argv[2] ?? 'check';
const environmentName = resolveEnvironmentName();
const environment = readEnvironment(environmentName);
const accountId = await resolveAccountId(environment);
const bucketName = bucketNameFor(environment);

console.log(`\n  environment  ${environmentName}`);

if (command === 'check') {
  await check(accountId, bucketName);
} else if (command === 'apply') {
  // Kept alongside Terraform for a brand-new environment where running one
  // script is cheaper than an init/plan/apply cycle. Terraform adopts what it
  // finds (infra/cloudflare/imports.tf), so the two do not fight.
  await apply(accountId, bucketName, locationHint(environment));
} else {
  fail(`Unknown command "${command}". Use "check" or "apply".`);
}
