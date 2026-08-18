import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './rateLimit';

describe('createRateLimiter (SEC-005)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to max takes per key within the window', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3 });

    expect(limiter.take('user-a')).toEqual({ ok: true });
    expect(limiter.take('user-a')).toEqual({ ok: true });
    expect(limiter.take('user-a')).toEqual({ ok: true });
    expect(limiter.take('user-a')).toEqual({
      ok: false,
      retryAfterMs: expect.any(Number),
    });
  });

  it('rate-limits keys independently', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2 });

    expect(limiter.take('user-a')).toEqual({ ok: true });
    expect(limiter.take('user-a')).toEqual({ ok: true });
    expect(limiter.take('user-a')).toEqual({
      ok: false,
      retryAfterMs: expect.any(Number),
    });

    expect(limiter.take('user-b')).toEqual({ ok: true });
  });

  it('allows takes again after the window elapses', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2 });

    expect(limiter.take('user-a')).toEqual({ ok: true });
    expect(limiter.take('user-a')).toEqual({ ok: true });
    expect(limiter.take('user-a')).toEqual({
      ok: false,
      retryAfterMs: expect.any(Number),
    });

    vi.advanceTimersByTime(1000);

    expect(limiter.take('user-a')).toEqual({ ok: true });
  });

  it('returns a positive retryAfterMs bounded by the window when denied', () => {
    const limiter = createRateLimiter({ windowMs: 5000, max: 1 });

    expect(limiter.take('key')).toEqual({ ok: true });
    const denied = limiter.take('key');

    expect(denied).toEqual({ ok: false, retryAfterMs: expect.any(Number) });
    if (!denied.ok) {
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(5000);
    }
  });
});
