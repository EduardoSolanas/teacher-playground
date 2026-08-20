#!/usr/bin/env node
/**
 * Cloudflare Access configuration for the split-hostname guest design.
 *
 * `guest_implementation.md` §6.5 states four invariants that no test in this
 * repository can prove, because they live in Cloudflare rather than in code:
 *
 *   1. The teacher hostname has exactly one Access application.
 *   2. That application is an EXACT hostname, never a wildcard — a
 *      `*.sen-tutor.co.uk` application would also cover the guest hostname and
 *      break guest join entirely.
 *   3. The guest hostname has NO Access application of any kind. Its absence is
 *      the design, not an oversight.
 *   4. No `Bypass` policy exists anywhere (it disables Access request logging).
 *
 * This script checks those invariants and can apply the teacher application.
 * It is the automated form of the manual evidence checklist in
 * `CLOUDFLARE_ACCESS_STAGING.md`.
 *
 * Usage:
 *   node scripts/cloudflare-access.mjs check          # read-only (default)
 *   node scripts/cloudflare-access.mjs apply-app      # create/update teacher app
 *   node scripts/cloudflare-access.mjs apply-branding # login page branding
 *
 * Credentials come from the environment and are never written to disk:
 *   CLOUDFLARE_API_TOKEN   required; needs Access: Apps + Orgs edit
 *   CLOUDFLARE_ACCOUNT_ID  optional; discovered when a single account exists
 *
 * Store the token in `.dev.vars` (gitignored) or export it for one shell.
 * Never paste it into a file this repository tracks.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.cloudflare.com/client/v4';

/**
 * Every `KEY = "value"` pair in a wrangler.toml, as a map.
 *
 * Deliberately one hardcoded regex rather than a pattern built per key: a
 * RegExp assembled from a variable trips semgrep's detect-non-literal-regexp
 * (ReDoS) rule, and there is no reason to construct one here.
 */
function tomlStringVars(toml) {
  const pair = /^[^\S\r\n]*([A-Za-z_][A-Za-z0-9_]*)[^\S\r\n]*=[^\S\r\n]*"([^"]*)"[^\S\r\n]*$/gm;
  const vars = new Map();
  for (const match of toml.matchAll(pair)) vars.set(match[1], match[2]);
  return vars;
}

/** wrangler.toml is the single source of truth for both hostnames. */
function hostnamesFromWrangler() {
  const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  const vars = tomlStringVars(toml);
  const read = (key) => vars.get(key) || null;
  const teacher = read('TEACHER_HOSTNAME');
  const guest = read('GUEST_HOSTNAME');
  if (!teacher || !guest) {
    fail('wrangler.toml must define both TEACHER_HOSTNAME and GUEST_HOSTNAME.');
  }
  if (teacher === guest) fail('TEACHER_HOSTNAME and GUEST_HOSTNAME must differ.');
  return { teacher, guest };
}

function fail(message) {
  console.error(`\n  ERROR  ${message}\n`);
  process.exit(1);
}

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  fail('CLOUDFLARE_API_TOKEN is not set. Create a token with Access: Apps and '
    + 'Access: Organizations edit permissions, then export it for this shell.');
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
  if (!response.ok || body.success === false) {
    const detail = (body.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ');
    fail(`${init.method ?? 'GET'} ${path} -> ${response.status}${detail ? ` (${detail})` : ''}`);
  }
  return body.result;
}

async function resolveAccountId() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const accounts = await api('/accounts');
  if (accounts.length !== 1) {
    fail(`Found ${accounts.length} accounts. Set CLOUDFLARE_ACCOUNT_ID to choose one:\n`
      + accounts.map((a) => `    ${a.id}  ${a.name}`).join('\n'));
  }
  return accounts[0].id;
}

/** An application covers a hostname if its domain matches exactly or by wildcard. */
function covers(appDomain, hostname) {
  const domain = String(appDomain ?? '').toLowerCase().split('/')[0];
  const host = hostname.toLowerCase();
  if (domain === host) return true;
  if (domain.startsWith('*.')) {
    // Cloudflare wildcards match exactly one label.
    const suffix = domain.slice(2);
    const rest = host.endsWith(`.${suffix}`) ? host.slice(0, -(suffix.length + 1)) : null;
    return rest !== null && rest.length > 0 && !rest.includes('.');
  }
  return false;
}

async function loadState(accountId, hosts) {
  const apps = await api(`/accounts/${accountId}/access/apps`);
  const annotated = [];
  for (const app of apps) {
    let policies = [];
    try {
      policies = await api(`/accounts/${accountId}/access/apps/${app.id}/policies`);
    } catch {
      policies = [];
    }
    annotated.push({ app, policies });
  }
  return {
    apps: annotated,
    teacherApps: annotated.filter((a) => covers(a.app.domain, hosts.teacher)),
    guestApps: annotated.filter((a) => covers(a.app.domain, hosts.guest)),
  };
}

function reportCheck(hosts, state) {
  const problems = [];
  const notes = [];

  console.log(`\n  teacher hostname  ${hosts.teacher}`);
  console.log(`  guest hostname    ${hosts.guest}\n`);
  console.log(`  ${state.apps.length} Access application(s) on this account:\n`);
  for (const { app, policies } of state.apps) {
    const decisions = policies.map((p) => p.decision).join(', ') || 'no policies';
    console.log(`    ${app.domain}`);
    console.log(`      aud ${app.aud}`);
    console.log(`      policies: ${decisions}`);
  }

  // Invariant 3 — the guest hostname must be uncovered.
  if (state.guestApps.length > 0) {
    problems.push(
      `${state.guestApps.length} application(s) cover the GUEST hostname ${hosts.guest}: `
      + state.guestApps.map((a) => a.app.domain).join(', ')
      + '. Guest join cannot work while Access sits in front of that hostname. '
      + 'Delete the application, or narrow it to an exact teacher hostname.',
    );
  }

  // Invariant 2 — no wildcard covering the teacher hostname.
  for (const { app } of state.teacherApps) {
    if (String(app.domain).startsWith('*.')) {
      problems.push(
        `Application ${app.domain} is a WILDCARD. It covers the guest hostname too. `
        + `Replace it with an exact application for ${hosts.teacher}.`,
      );
    }
  }

  // Invariant 1 — exactly one teacher application.
  if (state.teacherApps.length === 0) {
    notes.push(`No application covers ${hosts.teacher} yet. Run: apply-app`);
  } else if (state.teacherApps.length > 1) {
    problems.push(`${state.teacherApps.length} applications cover ${hosts.teacher}. Keep exactly one.`);
  }

  // Invariant 4 — no Bypass policy anywhere.
  for (const { app, policies } of state.apps) {
    for (const policy of policies) {
      if (policy.decision === 'bypass') {
        problems.push(
          `Application ${app.domain} has a BYPASS policy ("${policy.name}"). `
          + 'Bypass disables Access enforcement AND request logging. '
          + 'This design does not need one.',
        );
      }
    }
  }

  const teacherAud = state.teacherApps[0]?.app?.aud;
  if (teacherAud) {
    const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
    const configured = toml.match(/^\s*ACCESS_AUDIENCE\s*=\s*"([^"]+)"/m)?.[1];
    if (configured && configured !== teacherAud) {
      problems.push(
        `ACCESS_AUDIENCE in wrangler.toml (${configured}) does not match the `
        + `application AUD (${teacherAud}). The Worker will reject every token.`,
      );
    }
  }

  console.log('');
  for (const note of notes) console.log(`  NOTE   ${note}`);
  for (const problem of problems) console.log(`  FAIL   ${problem}`);
  if (problems.length === 0) {
    console.log('  OK     All §6.5 Access invariants hold.\n');
    return 0;
  }
  console.log('');
  return 1;
}

async function applyApp(accountId, hosts, state) {
  if (state.guestApps.length > 0) {
    fail('Refusing to apply: an Access application already covers the guest hostname. '
      + 'Remove it first — see the check output.');
  }
  const existing = state.teacherApps[0];
  const payload = {
    name: 'Teacher Playground (teachers)',
    domain: hosts.teacher,
    type: 'self_hosted',
    session_duration: '24h',
    app_launcher_visible: false,
    allowed_idps: [],
    auto_redirect_to_identity: false,
  };

  if (existing) {
    console.log(`\n  Updating existing application ${existing.app.domain} -> ${hosts.teacher}`);
    const updated = await api(`/accounts/${accountId}/access/apps/${existing.app.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    console.log(`  aud ${updated.aud}`);
    return updated;
  }

  console.log(`\n  Creating Access application for ${hosts.teacher}`);
  const created = await api(`/accounts/${accountId}/access/apps`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  await api(`/accounts/${accountId}/access/apps/${created.id}/policies`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Allow signed-in teachers',
      decision: 'allow',
      include: [{ login_method: { id: '' } }],
    }),
  });
  console.log(`  aud ${created.aud}`);
  console.log('\n  Set this in wrangler.toml as ACCESS_AUDIENCE, then redeploy.\n');
  return created;
}

async function applyBranding(accountId) {
  console.log('\n  Updating the Access login page branding.');
  const result = await api(`/accounts/${accountId}/access/organizations`, {
    method: 'PUT',
    body: JSON.stringify({
      login_design: {
        header_text: 'SEN Tutor',
        footer_text: 'Teachers sign in here. Students join with a class PIN.',
        background_color: '#0f172a',
        text_color: '#f8fafc',
      },
    }),
  });
  console.log(`  organization ${result.name} updated.\n`);
  return result;
}

const command = process.argv[2] ?? 'check';
const hosts = hostnamesFromWrangler();
const accountId = await resolveAccountId();
const state = await loadState(accountId, hosts);

if (command === 'check') {
  process.exit(reportCheck(hosts, state));
} else if (command === 'apply-app') {
  reportCheck(hosts, state);
  await applyApp(accountId, hosts, state);
  process.exit(reportCheck(hosts, await loadState(accountId, hosts)));
} else if (command === 'apply-branding') {
  await applyBranding(accountId);
} else {
  fail(`Unknown command "${command}". Use check, apply-app, or apply-branding.`);
}
