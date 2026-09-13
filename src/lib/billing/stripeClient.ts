/**
 * Thin Stripe API execution client (spec §7.2: execute with a bounded
 * timeout and a pinned Stripe-Version).  Requests are built by the pure
 * builders in stripeRequest; this module only executes them.
 */
import { STRIPE_API_VERSION } from './stripeConfig';

const DEFAULT_TIMEOUT_MS = 10_000;
const TIMEOUT_STATUS = 503;

export type StripeExecutionResult =
  | { ok: true; json: unknown }
  | { ok: false; status: number };

export type WithTimeoutResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number };

/**
 * Pure seam: runs `run` with an AbortController whose abort is fired by a
 * timer.  When the abort fires before `run` settles, the result is a
 * `503` outcome instead of a thrown error.  The controller may be supplied
 * so callers (tests) can drive the abort explicitly.  Any rejection that is
 * not an abort rethrows.
 */
export async function runWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  controller: AbortController = new AbortController(),
): Promise<WithTimeoutResult<T>> {
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const value = await run(controller.signal);
    clearTimeout(timer);
    return { ok: true, value };
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      return { ok: false, status: TIMEOUT_STATUS };
    }
    throw error;
  }
}

export async function executeStripeRequest(
  request: Request,
  secretKey: string,
  opts: { timeoutMs?: number } = {},
): Promise<StripeExecutionResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const executed = new Request(request, {
    headers: {
      ...Object.fromEntries(request.headers),
      Authorization: `Bearer ${secretKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
    },
  });

  const outcome = await runWithTimeout(
    async (signal) => {
      const response = await fetch(executed, { signal });
      const json: unknown = await response.json();
      return { response, json };
    },
    timeoutMs,
  );

  if (!outcome.ok) {
    return { ok: false, status: outcome.status };
  }
  if (!outcome.value.response.ok) {
    return { ok: false, status: outcome.value.response.status };
  }
  return { ok: true, json: outcome.value.json };
}