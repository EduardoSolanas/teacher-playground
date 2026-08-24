#!/usr/bin/env node

import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const CDN_BUCKET_NAME = 'teacher-playground-excalidraw';
export const CDN_DOMAIN = 'excalidraw-assets.sen-tutor.co.uk';
export const CDN_RELEASE_PREFIX = 'releases/0.18.1-tp.2/dist/prod/';
export const CDN_BASE_URL = `https://${CDN_DOMAIN}/${CDN_RELEASE_PREFIX}`;
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const MUTABLE_CACHE_CONTROL = 'no-cache, no-store, must-revalidate';
export const UPLOAD_CONCURRENCY = 4;
const API_BASE = 'https://api.cloudflare.com/client/v4';
const ZONE_NAME = 'sen-tutor.co.uk';
const DOMAIN_READY_TIMEOUT_MS = 5 * 60 * 1000;
const DOMAIN_READY_POLL_MS = 5 * 1000;

export function buildReleaseObjectKey(relativePath) {
  return `${CDN_RELEASE_PREFIX}${relativePath.replaceAll('\\', '/')}`;
}

export function buildBucketCreatePayload() {
  return { name: CDN_BUCKET_NAME, locationHint: 'eeur' };
}

export function isCustomDomainReady(result) {
  return result?.enabled === true
    && result?.status?.ownership === 'active'
    && result?.status?.ssl === 'active';
}

export function buildR2CorsPolicy() {
  return {
    rules: [{
      id: 'public-distribution-read',
      allowed: { methods: ['GET', 'HEAD'], origins: ['*'] },
      exposeHeaders: ['ETag'],
      maxAgeSeconds: 3600,
    }],
  };
}

function requiredEnvironment() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required.');
  }
  return { token, accountId };
}

async function cloudflareRequest(path, { token, apiBase = API_BASE, ...options } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(`Cloudflare API ${options.method ?? 'GET'} ${path} failed (${response.status}): ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.result;
}

async function findZone(account) {
  const result = await cloudflareRequest(`/zones?name=${encodeURIComponent(ZONE_NAME)}&status=active`, account);
  const zone = result?.[0];
  if (!zone?.id) throw new Error(`Active Cloudflare zone ${ZONE_NAME} was not found.`);
  return zone.id;
}

export async function reconcile() {
  const account = requiredEnvironment();
  const buckets = await cloudflareRequest(`/accounts/${account.accountId}/r2/buckets`, account);
  const exists = (buckets?.buckets ?? buckets ?? []).some((bucket) => bucket.name === CDN_BUCKET_NAME);
  if (!exists) {
    await cloudflareRequest(`/accounts/${account.accountId}/r2/buckets`, {
      ...account,
      method: 'POST',
      body: JSON.stringify(buildBucketCreatePayload()),
    });
  }

  await cloudflareRequest(`/accounts/${account.accountId}/r2/buckets/${CDN_BUCKET_NAME}/cors`, {
    ...account,
    method: 'PUT',
    body: JSON.stringify(buildR2CorsPolicy()),
  });

  const domainPath = `/accounts/${account.accountId}/r2/buckets/${CDN_BUCKET_NAME}/domains/custom/${CDN_DOMAIN}`;
  try {
    await cloudflareRequest(domainPath, account);
    await cloudflareRequest(domainPath, {
      ...account,
      method: 'PUT',
      body: JSON.stringify({ enabled: true, minTLS: '1.2' }),
    });
  } catch (error) {
    if (!String(error.message).includes('(404)')) throw error;
    await cloudflareRequest(`/accounts/${account.accountId}/r2/buckets/${CDN_BUCKET_NAME}/domains/custom`, {
      ...account,
      method: 'POST',
      body: JSON.stringify({ domain: CDN_DOMAIN, enabled: true, zoneId: await findZone(account) }),
    });
  }
  await waitForCustomDomainReady(account);
  console.log(`Reconciled R2 bucket ${CDN_BUCKET_NAME}, CORS, and ready domain ${CDN_DOMAIN}.`);
}

async function waitForCustomDomainReady(account, {
  timeoutMs = DOMAIN_READY_TIMEOUT_MS,
  intervalMs = DOMAIN_READY_POLL_MS,
} = {}) {
  const domainPath = `/accounts/${account.accountId}/r2/buckets/${CDN_BUCKET_NAME}/domains/custom/${CDN_DOMAIN}`;
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  for (;;) {
    const result = await cloudflareRequest(domainPath, account);
    if (isCustomDomainReady(result)) return result;
    const status = `${result?.status?.ownership ?? 'unknown'}/${result?.status?.ssl ?? 'unknown'}${result?.enabled === false ? ', disabled' : ''}`;
    if (status !== lastStatus) {
      console.log(`Waiting for ${CDN_DOMAIN} ownership/SSL readiness (${status}).`);
      lastStatus = status;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for ${CDN_DOMAIN} to become active.`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else files.push(path);
  }
  return files;
}

export function contentType(path) {
  const extension = basename(path).split('.').pop()?.toLowerCase();
  return ({ css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', woff: 'font/woff', woff2: 'font/woff2', svg: 'image/svg+xml', png: 'image/png' })[extension] ?? 'application/octet-stream';
}

function encodeObjectKey(key) {
  return key.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

async function uploadObject({ source, key, cacheControl, token, accountId, apiBase = API_BASE }) {
  const response = await fetch(
    `${apiBase}/accounts/${accountId}/r2/buckets/${CDN_BUCKET_NAME}/objects/${encodeObjectKey(key)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Cache-Control': cacheControl,
        'Content-Type': contentType(source),
      },
      body: await readFile(source),
    },
  );
  if (!response.ok) {
    throw new Error(`Cloudflare object upload failed for ${key} (${response.status}): ${await response.text()}`);
  }
}

async function runBounded(items, worker, concurrency = UPLOAD_CONCURRENCY) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }));
}

/**
 * @param {{root?: string, apiBase?: string, accountId?: string, token?: string}} options
 */
export async function upload({
  root = resolve(process.env.EXCALIDRAW_ASSET_SOURCE ?? 'node_modules/@teacher-playground/excalidraw/dist/prod'),
  apiBase = API_BASE,
  accountId,
  token,
} = {}) {
  if (!accountId || !token) ({ accountId, token } = requiredEnvironment());
  const files = await listFiles(root);

  const manifestPath = join(tmpdir(), `teacher-playground-excalidraw-${randomUUID()}.json`);
  await writeFile(manifestPath, JSON.stringify({ version: '0.18.1-tp.2', baseUrl: CDN_BASE_URL }, null, 2));
  try {
    const objects = [
      ...files.map((file) => ({
        source: file,
        key: buildReleaseObjectKey(relative(root, file)),
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      })),
      { source: manifestPath, key: 'latest.json', cacheControl: MUTABLE_CACHE_CONTROL },
    ];
    await runBounded(objects, (object) => uploadObject({ ...object, accountId, token, apiBase }));
  } finally {
    await unlink(manifestPath).catch(() => {});
  }
  console.log(`Uploaded ${files.length} immutable Excalidraw objects and latest.json.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  if (command !== 'reconcile' && command !== 'upload') {
    console.error('Usage: node scripts/excalidraw-cdn.mjs <reconcile|upload>');
    process.exit(1);
  }
  await (command === 'reconcile' ? reconcile() : upload());
}
