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

    expect(limiter.take('user-a')).toEqual({ ok: true, messagesInWindow: 1 });
    expect(limiter.take('user-a')).toEqual({ ok: true, messagesInWindow: 2 });
    expect(limiter.take('user-a')).toEqual({ ok: true, messagesInWindow: 3 });
    expect(limiter.take('user-a')).toEqual({
      ok: false,
      retryAfterMs: expect.any(Number),
      messagesInWindow: 3,
    });
  });

  it('rate-limits keys independently', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2 });

    expect(limiter.take('user-a')).toEqual({ ok: true, messagesInWindow: 1 });
    expect(limiter.take('user-a')).toEqual({ ok: true, messagesInWindow: 2 });
    expect(limiter.take('user-a')).toEqual({
      ok: false,
      retryAfterMs: expect.any(Number),
      messagesInWindow: 2,
    });

    expect(limiter.take('user-b')).toEqual({ ok: true, messagesInWindow: 1 });
  });

  it('allows takes again after the window elapses', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2 });

    expect(limiter.take('user-a')).toEqual({ ok: true, messagesInWindow: 1 });
    expect(limiter.take('user-a')).toEqual({ ok: true, messagesInWindow: 2 });
    expect(limiter.take('user-a')).toEqual({
      ok: false,
      retryAfterMs: expect.any(Number),
      messagesInWindow: 2,
    });

    vi.advanceTimersByTime(1000);

    expect(limiter.take('user-a')).toEqual({ ok: true, messagesInWindow: 1 });
  });

  it('returns a positive retryAfterMs bounded by the window when denied', () => {
    const limiter = createRateLimiter({ windowMs: 5000, max: 1 });

    expect(limiter.take('key')).toEqual({ ok: true, messagesInWindow: 1 });
    const denied = limiter.take('key');

    expect(denied).toEqual({ ok: false, retryAfterMs: expect.any(Number), messagesInWindow: 1 });
    if (!denied.ok) {
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(5000);
    }
  });
});

describe('createRateLimiter countRejected', () => {
  it('does not let a refused attempt occupy the window by default', () => {
    /*
     * The guest PIN cap is keyed by client IP and a school NATs its pupils
     * behind one address. If refusals counted, one client retrying in a loop
     * would hold the lockout open against everybody sharing that address.
     */
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });

    expect(limiter.take('ip').ok).toBe(true);
    const refused = limiter.take('ip');
    expect(refused.ok).toBe(false);
    expect(refused.messagesInWindow).toBe(1);
  });

  it('counts refused attempts when a caller opts in', () => {
    // Signaling opts in: telling a burst of drawing apart from a flood needs
    // to know what was sent, not what was let through.
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, countRejected: true });

    expect(limiter.take('peer').ok).toBe(true);
    expect(limiter.take('peer').messagesInWindow).toBe(2);
    expect(limiter.take('peer').messagesInWindow).toBe(3);
  });
});
