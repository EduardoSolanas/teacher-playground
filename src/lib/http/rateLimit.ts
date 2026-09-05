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
  maxTrackedKeys?: number;
}) {
  const { windowMs, max, countRejected = false, maxTrackedKeys = 10_000 } = options;
  const buckets = new Map<string, number[]>();
  let lastSweptAt = 0;

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

    /*
     * Without this the Map keeps an array for every key ever seen -- every
     * account id, every client IP the guest PIN path ever answered -- and a
     * Durable Object lives long enough for that to matter.
     *
     * Sweeping is rate-limited to once per window rather than run whenever the
     * Map is over size. Once the room genuinely holds more than maxTrackedKeys
     * *active* keys, an unthrottled sweep walks the whole Map on every single
     * message and finds nothing to drop, which costs more than the leak did.
     *
     * Only fully-expired keys are dropped. Evicting a key that still has live
     * timestamps would reset its count and let a flooder straight through, so
     * over-size is allowed to persist rather than traded for a bypass.
     */
    if (buckets.size > maxTrackedKeys && now - lastSweptAt >= windowMs) {
      lastSweptAt = now;
      for (const [otherKey, timestamps] of buckets) {
        if (timestamps.every((timestamp) => now - timestamp >= windowMs)) {
          buckets.delete(otherKey);
        }
      }
    }

    return { ok: true, messagesInWindow: active.length };
  }

  return { take, size: () => buckets.size };
}
