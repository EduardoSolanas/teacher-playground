#!/usr/bin/env node

import { appendFileSync } from 'node:fs';

/**
 * Idempotent Cloudflare Calls SFU app reconciliation.
 *
 * Cloudflare returns the app secret only when an app is created. The existing
 * app path deliberately never asks for, prints, or replaces that secret.
 */

export const REALTIME_APP_NAME = 'teacher-playground-voice';
const API_BASE = 'https://api.cloudflare.com/client/v4';

export function realtimeAppsPath(accountId) {
  return `/accounts/${accountId}/calls/apps`;
}

function requiredEnvironment() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required.');
  }
  return { token, accountId };
}

function assertSafeOutputValue(name, value) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`Cloudflare Realtime ${name} is not a safe workflow output.`);
  }
}

function defaultWriteOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const lines = [];
  for (const [name, value] of Object.entries(outputs)) {
    assertSafeOutputValue(name, value);
    lines.push(`${name}=${value}`);
  }
  // GITHUB_OUTPUT is an Actions-provided file. Avoid shell interpolation and
  // never write a value to stdout where an unmasked runner could retain it.
  appendFileSync(outputPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
}

function defaultWriteLog(line) {
  // The mask command is useful only in Actions. Keeping it out of local logs
  // prevents a one-time secret from being copied into a developer terminal.
  if (process.env.GITHUB_ACTIONS === 'true') console.log(line);
}

async function cloudflareRequest(path, { token, apiBase = API_BASE, fetchImpl = fetch, ...options }) {
  const response = await fetchImpl(`${apiBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(
      `Cloudflare API ${options.method ?? 'GET'} ${path} failed (${response.status}): ${JSON.stringify(body.errors ?? body)}`,
    );
  }
  return body.result;
}

function appsFromResult(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.apps)) return result.apps;
  return [];
}

/**
 * @typedef {{appId: string, created: string, appSecret?: string}} RealtimeWorkflowOutputs
 * @typedef {{uid: string, created: false, secret?: never} | {uid: string, created: true, secret: string}} RealtimeAppResult
 */

/**
 * @param {{accountId: string, token: string, apiBase?: string, fetchImpl?: typeof fetch, writeOutputs?: (outputs: RealtimeWorkflowOutputs) => void, writeLog?: (line: string) => void}} options
 * @returns {Promise<RealtimeAppResult>}
 */
export async function ensureRealtimeApp({
  accountId,
  token,
  apiBase = API_BASE,
  fetchImpl = fetch,
  writeOutputs = defaultWriteOutputs,
  writeLog = defaultWriteLog,
}) {
  if (!accountId || !token) throw new Error('accountId and token are required.');

  const path = realtimeAppsPath(accountId);
  const apps = appsFromResult(await cloudflareRequest(path, { token, apiBase, fetchImpl }));
  const existing = apps.find((app) => app?.name === REALTIME_APP_NAME);
  if (existing?.uid) {
    assertSafeOutputValue('uid', existing.uid);
    writeOutputs({ appId: existing.uid, created: 'false' });
    return { uid: existing.uid, created: false };
  }

  const created = await cloudflareRequest(path, {
    token,
    apiBase,
    fetchImpl,
    method: 'POST',
    body: JSON.stringify({ name: REALTIME_APP_NAME }),
  });
  if (!created?.uid || !created?.secret) {
    throw new Error('Cloudflare Realtime create response did not return uid and secret.');
  }
  assertSafeOutputValue('uid', created.uid);
  assertSafeOutputValue('secret', created.secret);

  // GitHub masks subsequent log output matching this value. The value is then
  // written only to the runner's output file for the secret-put step.
  writeLog(`::add-mask::${created.secret}`);
  writeOutputs({ appId: created.uid, created: 'true', appSecret: created.secret });
  return { uid: created.uid, created: true, secret: created.secret };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  if (command !== 'ensure') {
    console.error('Usage: node scripts/cloudflare-realtime.mjs ensure');
    process.exit(1);
  }
  const { accountId, token } = requiredEnvironment();
  const result = await ensureRealtimeApp({ accountId, token });
  console.log(`Cloudflare Realtime app ${result.uid} ${result.created ? 'created' : 'already exists'}.`);
}
