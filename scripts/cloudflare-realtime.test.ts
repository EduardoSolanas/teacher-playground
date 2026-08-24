import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  REALTIME_APP_NAME,
  ensureRealtimeApp,
} from './cloudflare-realtime.mjs';

const originalOutput = process.env.GITHUB_OUTPUT;
const originalActions = process.env.GITHUB_ACTIONS;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalOutput === undefined) delete process.env.GITHUB_OUTPUT;
  else process.env.GITHUB_OUTPUT = originalOutput;
  if (originalActions === undefined) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = originalActions;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function localApi(handler: (request: Request) => Promise<Response>) {
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const result = await handler(new Request(`http://127.0.0.1${request.url}`, {
      method: request.method,
      headers,
      body: request.method === 'GET' ? undefined : Buffer.concat(body),
    }));
    response.statusCode = result.status;
    result.headers.forEach((value, key) => response.setHeader(key, value));
    response.end(await result.text());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local API did not bind a port');
  return {
    apiBase: `http://127.0.0.1:${address.port}/client/v4`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function outputFile() {
  const directory = await mkdtemp(join(tmpdir(), 'teacher-playground-realtime-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'github-output');
  process.env.GITHUB_OUTPUT = path;
  return path;
}

async function readOutputs(path: string) {
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  return Object.fromEntries(lines.map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

describe('Cloudflare Realtime SFU control plane', () => {
  it('returns the existing named app without recreating it or exposing a secret', async () => {
    const path = await outputFile();
    const requests: Request[] = [];
    const api = await localApi(async (request) => {
      requests.push(request);
      return Response.json({ success: true, result: [{ uid: 'existing-uid', name: REALTIME_APP_NAME }] });
    });

    const result = await ensureRealtimeApp({
      accountId: 'account-123',
      token: 'token',
      apiBase: api.apiBase,
    });
    await api.close();

    expect(result).toEqual({ uid: 'existing-uid', created: false });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toContain('/accounts/account-123/calls/apps');
    expect(await readOutputs(path)).toEqual({ appId: 'existing-uid', created: 'false' });
  });

  it('creates a missing named app and masks the one-time secret before output', async () => {
    const path = await outputFile();
    const requests: Request[] = [];
    const logs: string[] = [];
    let call = 0;
    const api = await localApi(async (request) => {
      requests.push(request);
      call += 1;
      return call === 1
        ? Response.json({ success: true, result: [] })
        : Response.json({ success: true, result: { uid: 'created-uid', name: REALTIME_APP_NAME, secret: 'one-time-secret' } });
    });

    const result = await ensureRealtimeApp({
      accountId: 'account-123',
      token: 'token',
      apiBase: api.apiBase,
      writeLog: (line) => logs.push(line),
    });
    await api.close();

    expect(result).toEqual({ uid: 'created-uid', created: true, secret: 'one-time-secret' });
    expect(requests).toHaveLength(2);
    expect(requests[0].method).toBe('GET');
    expect(requests[1].method).toBe('POST');
    expect(await requests[1].json()).toEqual({ name: REALTIME_APP_NAME });
    expect(await readOutputs(path)).toEqual({ appId: 'created-uid', created: 'true', appSecret: 'one-time-secret' });
    expect(logs).toEqual(['::add-mask::one-time-secret']);
  });

  it('rejects a create response that does not contain a uid and secret', async () => {
    const api = await localApi(async () => Response.json({ success: true, result: [] }));
    await expect(ensureRealtimeApp({
      accountId: 'account-123',
      token: 'token',
      apiBase: api.apiBase,
    })).rejects.toThrow('did not return uid and secret');
    await api.close();
  });
});
