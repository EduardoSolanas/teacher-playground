import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CDN_BASE_URL,
  CDN_BUCKET_NAME,
  CDN_DOMAIN,
  CDN_RELEASE_PREFIX,
  IMMUTABLE_CACHE_CONTROL,
  MUTABLE_CACHE_CONTROL,
  UPLOAD_CONCURRENCY,
  buildReleaseObjectKey,
  buildBucketCreatePayload,
  buildR2CorsPolicy,
  isCustomDomainReady,
  upload,
  verify,
} from './excalidraw-cdn.mjs';

describe('Excalidraw CDN deployment contract', () => {
  it('uses the immutable fork release path and one-year cache policy', () => {
    expect(CDN_BUCKET_NAME).toBe('teacher-playground-excalidraw');
    expect(CDN_DOMAIN).toBe('excalidraw-assets.sen-tutor.co.uk');
    expect(CDN_RELEASE_PREFIX).toBe('releases/0.18.1-tp.2/dist/prod/');
    expect(CDN_BASE_URL).toBe(
      'https://excalidraw-assets.sen-tutor.co.uk/releases/0.18.1-tp.2/dist/prod/',
    );
    expect(IMMUTABLE_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
    expect(MUTABLE_CACHE_CONTROL).toBe('no-cache, no-store, must-revalidate');
    expect(UPLOAD_CONCURRENCY).toBe(4);
    expect(buildBucketCreatePayload()).toEqual({ name: CDN_BUCKET_NAME, locationHint: 'eeur' });
    expect(buildReleaseObjectKey('fonts/Virgil.woff2')).toBe(
      'releases/0.18.1-tp.2/dist/prod/fonts/Virgil.woff2',
    );
  });

  it('reconciles a read-only public CORS policy', () => {
    expect(buildR2CorsPolicy()).toEqual({
      rules: [{
        id: 'public-distribution-read',
        allowed: { methods: ['GET', 'HEAD'], origins: ['*'] },
        exposeHeaders: ['ETag'],
        maxAgeSeconds: 3600,
      }],
    });
  });

  it('recognizes only an enabled active custom domain as upload-ready', () => {
    expect(isCustomDomainReady({
      enabled: true,
      status: { ownership: 'active', ssl: 'active' },
    })).toBe(true);
    expect(isCustomDomainReady({
      enabled: true,
      status: { ownership: 'active', ssl: 'pending' },
    })).toBe(false);
    expect(isCustomDomainReady({
      enabled: true,
      status: { ownership: 'pending', ssl: 'active' },
    })).toBe(false);
    expect(isCustomDomainReady({
      enabled: false,
      status: { ownership: 'active', ssl: 'active' },
    })).toBe(false);
  });

  it('uploads objects directly with their key and HTTP metadata at bounded scale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excalidraw-cdn-test-'));
    const requests: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: Buffer }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({ path: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks) });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ success: true, result: {} }));
      });
    });
    await writeFile(join(root, 'fonts.woff2'), 'font-bytes');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    try {
      await upload({
        root,
        apiBase: `http://127.0.0.1:${address.port}`,
        accountId: 'account-test',
        token: 'token-test',
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }

    const asset = requests.find((request) => request.path.includes('/objects/releases/0.18.1-tp.2/dist/prod/fonts.woff2'));
    expect(asset).toBeDefined();
    expect(asset?.headers.authorization).toBe('Bearer token-test');
    expect(asset?.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(asset?.headers['content-type']).toBe('font/woff2');
    expect(asset?.body.toString()).toBe('font-bytes');

    const metadata = requests.find((request) => request.path.endsWith('/objects/latest.json'));
    expect(metadata?.headers['cache-control']).toBe(MUTABLE_CACHE_CONTROL);
  });

  it('verifies the public manifest and immutable asset contract', async () => {
    const requests: Array<{ path: string; origin: string | undefined }> = [];
    const server = createServer((request, response) => {
      requests.push({ path: request.url ?? '', origin: request.headers.origin });
      response.setHeader('access-control-allow-origin', '*');
      if (request.url === '/latest.json') {
        response.setHeader('cache-control', MUTABLE_CACHE_CONTROL);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          version: '0.18.1-tp.2',
          baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/${CDN_RELEASE_PREFIX}`,
        }));
        return;
      }
      if (request.url === `/${CDN_RELEASE_PREFIX}index.js`) {
        response.setHeader('cache-control', IMMUTABLE_CACHE_CONTROL);
        response.setHeader('content-type', 'text/javascript; charset=utf-8');
        response.end('window.__teacherPlaygroundExcalidraw = true;');
        return;
      }
      response.statusCode = 404;
      response.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const origin = `http://127.0.0.1:${address.port}`;

    try {
      await expect(verify({
        origin,
        expectedBaseUrl: `${origin}/${CDN_RELEASE_PREFIX}`,
      })).resolves.toMatchObject({ version: '0.18.1-tp.2' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    expect(requests).toEqual([
      { path: '/latest.json', origin: 'https://teacher-playground.example' },
      { path: `/${CDN_RELEASE_PREFIX}index.js`, origin: 'https://teacher-playground.example' },
    ]);
  });
});
