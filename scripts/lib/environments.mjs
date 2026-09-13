/**
 * Reader for `infra/environments.json`, the single source of truth for every
 * per-environment value in this deployment.
 *
 * Three consumers share this module so that none of them re-derives an
 * environment from a different place:
 *
 *   - `scripts/cloudflare-access.mjs` and `scripts/cloudflare-r2.mjs`, which
 *     verify the live Cloudflare account against it;
 *   - `src/infra/environments.test.ts`, which fails when wrangler.toml or the
 *     Terraform tfvars drift from it;
 *   - anything added later that needs a hostname or a bucket name.
 *
 * The scripts previously regex-parsed wrangler.toml's top-level `[vars]`. That
 * was fine while one environment existed and silently wrong the moment a second
 * one did: a `[env.staging]` block's values do not appear at the top level, so
 * the scripts would have gone on checking production's hostnames while claiming
 * to check staging's.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MANIFEST_PATH = join(repositoryRoot, 'infra', 'environments.json');

/** Keys the manifest uses for prose. They document; they never configure. */
function isCommentKey(key) {
  return key.startsWith('$comment');
}

/** Strip the `$comment*` keys so a consumer sees configuration only. */
function withoutComments(value) {
  if (Array.isArray(value)) return value.map(withoutComments);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isCommentKey(key))
      .map(([key, entry]) => [key, withoutComments(entry)]),
  );
}

export function readManifest() {
  return withoutComments(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
}

export function environmentNames() {
  return Object.keys(readManifest().environments);
}

/**
 * One environment's configuration.
 *
 * The name is required rather than defaulted to `prod`. A default is exactly
 * the mistake this module exists to prevent: a script that silently checks
 * production when it was pointed at something else reports a green that means
 * nothing.
 */
export function readEnvironment(name) {
  const { environments } = readManifest();
  const environment = environments[name];
  if (!environment) {
    const known = Object.keys(environments).join(', ');
    throw new Error(`Unknown environment "${name}". infra/environments.json defines: ${known}.`);
  }
  return environment;
}

/**
 * The environment named by `TP_ENV`, or the single environment when only one is
 * defined.
 *
 * Falling back to "the only one" is safe in a way that falling back to "prod"
 * is not: it stops being available the moment a second environment exists, so
 * the ambiguity surfaces as an error at the point it first becomes real.
 */
export function resolveEnvironmentName(explicit = process.env.TP_ENV) {
  if (explicit) return explicit;
  const names = environmentNames();
  if (names.length === 1) return names[0];
  throw new Error(
    `infra/environments.json defines ${names.length} environments (${names.join(', ')}). `
    + 'Set TP_ENV to choose one.',
  );
}
