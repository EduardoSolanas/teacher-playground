import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readManifest } from '../../scripts/lib/environments.mjs';
import { GUEST_AUTH_RATE_MAX } from '../lib/worker/rateLimits';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

/**
 * Why this file exists.
 *
 * `infra/environments.json` is the single source of truth for every
 * per-environment value, but three consumers cannot read a JSON file at the
 * moment they need it: Wrangler reads TOML at deploy time, Terraform reads its
 * own variables at plan time, and the S3 backend block cannot interpolate
 * anything at all. Each therefore holds a COPY.
 *
 * A copy with nothing checking it is drift with extra steps, and the drift here
 * is silent in the worst way. A `TEACHER_HOSTNAME` that disagrees with the
 * Access application's domain does not fail a build; it fails every teacher's
 * login, in production, after a green deploy. These tests turn that into a red
 * CI run instead.
 *
 * Every assertion below has the same shape: the manifest says X, so the copy
 * must say X. None of them decides what X should be.
 */

/** One `[header]` or `[[header]]` block of a TOML file. */
interface TomlSection {
  header: string;
  repeated: boolean;
  values: Map<string, string>;
}

/**
 * Enough of TOML to read wrangler.toml.
 *
 * Deliberately not a TOML library. This needs to see exactly the shapes
 * wrangler.toml uses -- string scalars in named tables and in arrays of tables
 * -- and a parser that silently coerced anything else would weaken the
 * comparison it exists to make. Anything it cannot read surfaces as a missing
 * key and a failing assertion, which is the right direction to fail in.
 */
function parseToml(toml: string): TomlSection[] {
  const sections: TomlSection[] = [{ header: '', repeated: false, values: new Map() }];

  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const arrayHeader = /^\[\[([^\]]+)\]\]$/.exec(line);
    if (arrayHeader) {
      sections.push({ header: arrayHeader[1].trim(), repeated: true, values: new Map() });
      continue;
    }

    const tableHeader = /^\[([^\]]+)\]$/.exec(line);
    if (tableHeader) {
      sections.push({ header: tableHeader[1].trim(), repeated: false, values: new Map() });
      continue;
    }

    const pair = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const value = pair[2].trim().replace(/\s*#.*$/, '');
    const quoted = /^"([^"]*)"$/.exec(value);
    sections[sections.length - 1].values.set(pair[1], quoted ? quoted[1] : value);
  }

  return sections;
}

function sectionsNamed(sections: TomlSection[], header: string): TomlSection[] {
  return sections.filter((section) => section.header === header);
}

function sectionNamed(sections: TomlSection[], header: string): TomlSection | undefined {
  return sectionsNamed(sections, header)[0];
}

const manifest = readManifest() as { environments: Record<string, any> };
const environments = Object.entries(manifest.environments);

describe('infra/environments.json is the single source of truth', () => {
  it('defines at least one environment', () => {
    expect(environments.length).toBeGreaterThan(0);
  });

  it('leaves no environment as an implicit default', () => {
    // Every environment names its own [env.<name>] block. An environment
    // configured at the top level instead would be the one a forgotten --env
    // silently selects, and "silently selects production" is the failure this
    // whole arrangement exists to make impossible.
    for (const [name, environment] of environments) {
      expect(environment.wranglerEnv, `${name}.wranglerEnv`).toBeTypeOf('string');
      expect(environment.wranglerEnv, `${name}.wranglerEnv`).not.toBe('');
    }

    // Two environments pointing at one wrangler block would deploy the same
    // bindings under two names.
    const blocks = environments.map(([, environment]) => environment.wranglerEnv);
    expect(new Set(blocks).size).toBe(blocks.length);
  });

  it('withholds a top-level entry point so a deploy cannot forget --env', () => {
    // Wrangler only WARNS when environments are defined and --env is omitted,
    // then goes on to publish. Because [env.prod] keeps the Worker's real name,
    // that publish lands on the live script with no routes, no vars and no
    // bindings. No top-level `main` turns the warning into an error.
    const topLevel = readRepositoryFile('wrangler.toml').split(/^\s*\[/m, 1)[0];
    expect(topLevel).not.toMatch(/^main\s*=/m);
  });

  it('passes --env on every wrangler invocation', () => {
    const sources: Record<string, string> = {
      'package.json': readRepositoryFile('package.json'),
      'deploy-cloudflare.yml': readRepositoryFile('.github/workflows/deploy-cloudflare.yml'),
      'configure-livekit.yml': readRepositoryFile('.github/workflows/configure-livekit.yml'),
    };
    const names = environments.map(([, environment]) => environment.wranglerEnv);

    for (const [label, source] of Object.entries(sources)) {
      // Every wrangler command line, up to the end of its line. Commands
      // against wrangler.local.toml are exempt: that config defines no
      // environments, and --env there would be an error.
      const commands = [...source.matchAll(/^.*wrangler (?:deploy|dev|secret).*$/gm)]
        .map((match) => match[0])
        .filter((command) => !command.includes('wrangler.local.toml'));

      for (const command of commands) {
        expect(command, `${label}: ${command.trim()}`).toMatch(/--env[ =]/);
        expect(
          names.some((name) => command.includes(`--env ${name}`) || command.includes(`--env=${name}`)),
          `${label}: ${command.trim()} names no known environment`,
        ).toBe(true);
      }
    }

    // The wrangler-action step passes the command as an input rather than a
    // shell line, so it is matched separately -- and it is the one that
    // actually publishes.
    expect(sources['deploy-cloudflare.yml']).toMatch(/^\s+command:\s+deploy --env prod\s*$/m);
  });

  it('carries no credential-shaped values', () => {
    // The manifest is tracked, and CI's secret scan reads every tracked file.
    // This is the cheaper, earlier signal: a key that looks like a secret is
    // rejected here by name, before anyone puts a value in it.
    const forbidden = /(secret|token|password|private[_-]?key|api[_-]?key)/i;
    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        if (key.startsWith('$comment')) continue;
        expect(forbidden.test(key), `${path}.${key} names a credential`).toBe(false);
        walk(entry, `${path}.${key}`);
      }
    };
    walk(manifest.environments, 'environments');
  });

  it.each(environments)('%s: hostnames are three distinct exact names', (_name, environment) => {
    const { teacher, guest, marketing } = environment.hostnames;
    expect(new Set([teacher, guest, marketing]).size).toBe(3);

    // A wildcard would make the Access application cover the guest hostname,
    // which breaks guest join outright, and would put a login in front of the
    // public landing page.
    for (const hostname of [teacher, guest, marketing]) {
      expect(hostname, hostname).not.toContain('*');
      expect(hostname, hostname).not.toContain('/');
    }
  });

  it.each(environments)('%s: the JWKS URL is derived from the issuer', (_name, environment) => {
    // The Worker verifies every Access token against these two. They are one
    // value in Cloudflare -- the team domain -- so a pair that disagrees is
    // always a typo, and the symptom is every teacher token rejected.
    expect(environment.access.issuer).toMatch(/^https:\/\//);
    expect(environment.access.jwksUrl).toBe(`${environment.access.issuer}/cdn-cgi/access/certs`);
  });

  it.each(environments)('%s: the asset origin is the origin of the asset base URL', (_name, environment) => {
    // assetBaseUrl is inlined into the static export at build time; assetOrigin
    // goes into the Worker's CSP font-src. If they name different hosts, fonts
    // are fetched from one and refused by the other, and the only symptom is a
    // console violation in a browser nobody opened.
    const { assetBaseUrl, assetOrigin } = environment.excalidraw;
    expect(new URL(assetBaseUrl).origin).toBe(assetOrigin);
  });

  it.each(environments)('%s: the edge rate limit stays looser than the in-Worker limit', (_name, environment) => {
    // GUEST_AUTH_RATE_MAX is 5 per IP per minute (src/lib/worker/rateLimits.ts).
    // The edge rule is the outer bound that sheds volumetric abuse; if it were
    // tighter, a legitimate client would meet an opaque edge block instead of
    // the Worker's considered 429, and the product limit would stop being the
    // thing that decides.
    //
    // Compared as RATES, not as raw counts. This first asserted the period was
    // 60, which was never the real invariant and was also wrong: the free plan
    // entitles a 10s period only, and the API refuses anything else. A test
    // pinning an incidental number fails when the number legitimately changes
    // and says nothing when the relationship it cared about breaks.
    const { requestsPerPeriod, periodSeconds } = environment.guestRateLimit;
    expect(periodSeconds).toBeGreaterThan(0);

    const edgePerSecond = requestsPerPeriod / periodSeconds;
    const workerPerSecond = GUEST_AUTH_RATE_MAX / 60;
    expect(edgePerSecond).toBeGreaterThan(workerPerSecond);
  });
});

describe('wrangler.toml matches the manifest', () => {
  const wrangler = parseToml(readRepositoryFile('wrangler.toml'));

  it.each(environments)('%s has a matching wrangler configuration', (_name, environment) => {
    const prefix = environment.wranglerEnv === null ? '' : `env.${environment.wranglerEnv}.`;
    const rootHeader = environment.wranglerEnv === null ? '' : `env.${environment.wranglerEnv}`;
    const root = sectionNamed(wrangler, rootHeader);

    expect(root, `wrangler.toml has no [${rootHeader || 'top level'}] section`).toBeDefined();

    // A named environment MUST set `name`. Wrangler otherwise appends the
    // environment to the top-level name and publishes a different Worker --
    // with different Durable Objects, so the rooms simply are not there.
    expect(root?.values.get('name')).toBe(environment.workerName);
    expect(root?.values.get('account_id')).toBe(environment.accountId);

    const vars = sectionNamed(wrangler, `${prefix}vars`);
    expect(vars, `wrangler.toml has no [${prefix}vars]`).toBeDefined();

    expect(vars?.values.get('TEACHER_HOSTNAME')).toBe(environment.hostnames.teacher);
    expect(vars?.values.get('GUEST_HOSTNAME')).toBe(environment.hostnames.guest);
    expect(vars?.values.get('MARKETING_HOSTNAME')).toBe(environment.hostnames.marketing);
    expect(vars?.values.get('ACCESS_ISSUER')).toBe(environment.access.issuer);
    expect(vars?.values.get('ACCESS_AUDIENCE')).toBe(environment.access.audience);
    expect(vars?.values.get('ACCESS_JWKS_URL')).toBe(environment.access.jwksUrl);
    expect(vars?.values.get('EXCALIDRAW_ASSET_ORIGIN')).toBe(environment.excalidraw.assetOrigin);

    // Numbers become strings crossing into a Worker binding, so the manifest
    // keeps the number and this is the one place the conversion happens.
    expect(vars?.values.get('TUTOR_ACCOUNT_CAP')).toBe(String(environment.limits.tutorAccountCap));

    const routes = sectionsNamed(wrangler, `${prefix}routes`);
    expect(routes.map((route) => route.values.get('pattern')).sort()).toEqual(
      [
        environment.hostnames.teacher,
        environment.hostnames.guest,
        environment.hostnames.marketing,
      ].sort(),
    );
    for (const route of routes) {
      // Without custom_domain the pattern is a zone route, which does not
      // create the hostname or its certificate.
      expect(route.values.get('custom_domain'), route.values.get('pattern')).toBe('true');
    }

    const buckets = sectionsNamed(wrangler, `${prefix}r2_buckets`);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].values.get('bucket_name')).toBe(environment.r2.boardFilesBucket);
    expect(buckets[0].values.get('binding')).toBe('BOARD_FILES');
  });
});

describe('the Terraform stack is wired for every environment', () => {
  it.each(environments)('%s has tfvars and a backend configuration', (name, environment) => {
    const tfvarsPath = `infra/cloudflare/environments/${name}.tfvars`;
    const backendPath = `infra/cloudflare/environments/${name}.backend.hcl`;

    expect(existsSync(resolve(repositoryRoot, tfvarsPath)), tfvarsPath).toBe(true);
    expect(existsSync(resolve(repositoryRoot, backendPath)), backendPath).toBe(true);

    // The tfvars must select THIS environment. A copied file that still names
    // the one it was copied from would plan production's resources under
    // another environment's state, which is the one Terraform mistake with no
    // cheap undo.
    expect(readRepositoryFile(tfvarsPath)).toMatch(
      new RegExp(`^environment\\s*=\\s*"${name}"\\s*$`, 'm'),
    );

    const backend = readRepositoryFile(backendPath);
    expect(backend).toMatch(new RegExp(`^key\\s*=\\s*"cloudflare/${name}\\.tfstate"\\s*$`, 'm'));

    // A backend block cannot interpolate, so the account id is the one value
    // that must be repeated there. This is what stops the repetition drifting.
    expect(backend).toContain(environment.accountId);
  });

  it('reads every Cloudflare value from the manifest and none from a literal', () => {
    // The point of the stack is that adding an environment is a manifest entry
    // plus two small files. A hostname, bucket name or account id written
    // directly into a .tf file would be a value a new environment silently
    // inherits from production.
    const terraform = [
      'locals.tf',
      'r2.tf',
      'access.tf',
      'ratelimit.tf',
      'branding.tf',
      'outputs.tf',
      'imports.tf',
      'variables.tf',
    ]
      .map((file) => readRepositoryFile(`infra/cloudflare/${file}`))
      .join('\n');

    for (const [, environment] of environments) {
      for (const literal of [
        environment.accountId,
        environment.hostnames.teacher,
        environment.hostnames.guest,
        environment.hostnames.marketing,
        environment.r2.boardFilesBucket,
        environment.zone,
      ]) {
        expect(terraform, `${literal} is hardcoded in the Terraform stack`)
          .not.toContain(literal);
      }
    }
  });
});
