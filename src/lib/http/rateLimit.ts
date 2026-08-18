type RateLimitResult = { ok: true } | { ok: false; retryAfterMs: number };

export function createRateLimiter(options: { windowMs: number; max: number }) {
  const { windowMs, max } = options;
  const buckets = new Map<string, number[]>();

  function take(key: string): RateLimitResult {
    const now = Date.now();
    const active = (buckets.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);

    if (active.length >= max) {
      const oldest = active[0]!;
      buckets.set(key, active);
      return {
        ok: false,
        retryAfterMs: Math.max(1, oldest + windowMs - now),
      };
    }

    active.push(now);
    buckets.set(key, active);
    return { ok: true };
  }

  return { take };
}
