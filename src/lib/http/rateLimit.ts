export type RateLimitResult =
  | { ok: true; messagesInWindow: number }
  | { ok: false; retryAfterMs: number; messagesInWindow: number };

/**
 * A sliding-window limiter.
 *
 * `countRejected` decides whether a refused attempt still occupies the window.
 *
 * The default is false, which is what every HTTP caller needs. Counting
 * refusals means a client that keeps retrying never drains its bucket, and the
 * guest PIN cap is keyed by client IP — a school puts hundreds of pupils behind
 * one address, so one buggy or hostile client could hold that lockout open
 * against everybody sharing it.
 *
 * The signaling socket opts in, because there the count is the signal: telling
 * a burst of drawing apart from a client flooding the room requires knowing how
 * much it actually sent, not how much was let through.
 */
export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  countRejected?: boolean;
}) {
  const { windowMs, max, countRejected = false } = options;
  const buckets = new Map<string, number[]>();

  function take(key: string): RateLimitResult {
    const now = Date.now();
    const active = (buckets.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);

    if (active.length >= max) {
      const oldest = active[0]!;
      if (countRejected) active.push(now);
      buckets.set(key, active);
      return {
        ok: false,
        retryAfterMs: Math.max(1, oldest + windowMs - now),
        messagesInWindow: active.length,
      };
    }

    active.push(now);
    buckets.set(key, active);
    return { ok: true, messagesInWindow: active.length };
  }

  return { take };
}
