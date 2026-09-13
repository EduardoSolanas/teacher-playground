import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { STRIPE_API_VERSION } from './stripeConfig';
import { executeStripeRequest, runWithTimeout } from './stripeClient';

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('runWithTimeout (pure seam)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts on its own timer and reports 503 without an external controller', async () => {
    vi.useFakeTimers();
    const neverSettling = (signal: AbortSignal) =>
      new Promise<unknown>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const pending = runWithTimeout(neverSettling, 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toEqual({ ok: false, status: 503 });
  });

  it('clears its timer on success so a later abort cannot fire', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    await expect(runWithTimeout(async () => 'done', 50, controller)).resolves.toEqual({
      ok: true,
      value: 'done',
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.signal.aborted).toBe(false);
  });

  it('clears its timer when the work rejects with a non-abort error', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    await expect(
      runWithTimeout(async () => {
        throw new Error('boom');
      }, 50, controller),
    ).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.signal.aborted).toBe(false);
  });

  it('rethrows a non-abort error instead of reporting a timeout', async () => {
    await expect(
      runWithTimeout(async () => {
        throw new Error('boom');
      }, 1_000),
    ).rejects.toThrow('boom');
  });

  it('returns { ok: false, status: 503 } when the abort fires before the work settles', async () => {
    const controller = new AbortController();
    const neverSettling = (signal: AbortSignal) =>
      new Promise<unknown>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const pending = runWithTimeout(neverSettling, 60_000, controller);
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, status: 503 });
  });

  it('resolves the work value on success', async () => {
    const result = await runWithTimeout(async () => 42, 1_000);
    expect(result).toEqual({ ok: true, value: 42 });
  });
});

describe('executeStripeRequest (real HTTP server)', () => {
  it('executes the request with the secret key, pinned version, and parsed JSON', async () => {
    await withServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          authorization: request.headers.authorization,
          version: request.headers['stripe-version'],
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
    }, async (baseUrl) => {
      const result = await executeStripeRequest(
        new Request(`${baseUrl}/v1/checkout/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'mode=subscription',
        }),
        'sk_test_alpha',
      );

      expect(result).toEqual({
        ok: true,
        json: {
          authorization: 'Bearer sk_test_alpha',
          version: STRIPE_API_VERSION,
          body: 'mode=subscription',
        },
      });
    });
  });

  it('reports the status of a non-ok response', async () => {
    await withServer((_request, response) => {
      response.writeHead(402, { 'content-type': 'application/json' });
      response.end('{"error":"card_declined"}');
    }, async (baseUrl) => {
      const result = await executeStripeRequest(
        new Request(`${baseUrl}/v1/charges`),
        'sk_test_alpha',
      );

      expect(result).toEqual({ ok: false, status: 402 });
    });
  });

  it('returns 503 when the server outlasts the timeout', async () => {
    await withServer(() => {
      // Never answer: the abort must be what settles the request.
    }, async (baseUrl) => {
      const result = await executeStripeRequest(
        new Request(`${baseUrl}/v1/charges`),
        'sk_test_alpha',
        { timeoutMs: 25 },
      );

      expect(result).toEqual({ ok: false, status: 503 });
    });
  });
});