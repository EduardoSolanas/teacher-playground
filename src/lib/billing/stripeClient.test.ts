import { describe, expect, it } from 'vitest';
import { runWithTimeout } from './stripeClient';

describe('runWithTimeout (pure seam)', () => {
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