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

  it('shared IP does not lock pupils out differently with new sweep behavior', () => {
    /*
     * A school NATs many pupils behind one IP. The guest PIN cap is keyed
     * by client IP. With countRejected: false (the default), refused attempts
     * do not occupy the window, so one pupil's retries should not block others.
     * The sweep behavior should not change this.
     */
    const maxTrackedKeys = 1000;
    const limiter = createRateLimiter({
      windowMs: 1000,
      max: 5,
      countRejected: false,
      maxTrackedKeys,
    });

    // Simulate many pupils making requests from the same IP
    const sharedIp = '192.168.1.1';

    // First pupil uses up the limit
    for (let i = 0; i < 5; i++) {
      expect(limiter.take(sharedIp).ok).toBe(true);
    }

    // Second pupil's attempt should be refused, but not count toward window
    const refused = limiter.take(sharedIp);
    expect(refused.ok).toBe(false);
    expect(refused.messagesInWindow).toBe(5);

    // Advance time to let window expire
    vi.advanceTimersByTime(1000);

    // Second pupil should now be able to go through (window expired)
    expect(limiter.take(sharedIp).ok).toBe(true);
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

describe('createRateLimiter memory bounding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds storage to maxTrackedKeys by sweeping expired entries', () => {
    const maxTrackedKeys = 100;
    const limiter = createRateLimiter({
      windowMs: 1000,
      max: 1,
      maxTrackedKeys,
    });

    // Fill with 25,000 unique keys with expired windows
    for (let i = 0; i < 25000; i++) {
      limiter.take(`key-${i}`);
    }

    // Advance time so all windows expire
    vi.advanceTimersByTime(2000);

    // Take one more to potentially trigger sweep
    limiter.take('new-key');

    // Verify bounded storage
    expect(limiter.size()).toBeLessThanOrEqual(maxTrackedKeys);
  });

  it('never evicts a key with active timestamps, even when sweep occurs', () => {
    const maxTrackedKeys = 30;
    const windowMs = 10000;
    const limiter = createRateLimiter({
      windowMs,
      max: 2,
      countRejected: false,
      maxTrackedKeys,
    });

    // Add an active key that hits its limit
    const activeKey = 'active-key-must-not-evict';
    expect(limiter.take(activeKey).ok).toBe(true);
    expect(limiter.take(activeKey).ok).toBe(true);
    const hitLimit = limiter.take(activeKey);
    expect(hitLimit.ok).toBe(false);
    expect(hitLimit.messagesInWindow).toBe(2);

    // Now fill with many keys to trigger a sweep
    for (let i = 0; i < 40; i++) {
      limiter.take(`will-expire-${i}`);
    }

    // Advance time to expire only the new keys (not activeKey which still has 9000ms left)
    vi.advanceTimersByTime(2000);

    // Trigger sweep by taking one more key
    limiter.take('trigger-sweep');

    // The active key should still refuse (proof it wasn't evicted during sweep)
    const stillRefused = limiter.take(activeKey);
    expect(stillRefused.ok).toBe(false);
    expect(stillRefused.messagesInWindow).toBe(2);
  });
});
