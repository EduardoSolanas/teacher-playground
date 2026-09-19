/**
 * Per-account request caps (SEC-005, SEC-017).
 *
 * These live here rather than in `src/worker.ts` because that file is the
 * Worker entrypoint: workerd treats every named export of the entrypoint as a
 * handler or Durable Object class, so exporting a plain number from it makes
 * the runtime refuse to start with "Incorrect type for map entry ... not of
 * type 'function or ExportedHandler'".
 *
 * Tests import these instead of re-declaring them. A duplicated copy in
 * `worker.access.workers.test.ts` silently drifted from production once
 * already, which made the presence limit test assert a threshold the Worker no
 * longer used.
 */

/** Room-creation POSTs per verified account per minute. */
export const ROOM_CREATE_RATE_MAX = 10;

/** Access-request POSTs per verified account per minute. */
export const ACCESS_REQUEST_RATE_MAX = 20;

/**
 * Presence POSTs per account per minute.
 *
 * The client heartbeats presence every 2s (`useCollaboration.ts`), so one
 * healthy tab already sends 30/minute. A cap of 30 therefore sat exactly on the
 * legitimate steady-state rate: the initial join, a retry, or a second tab
 * pushed an ordinary user over it, and a 429 on presence bounced an admitted
 * student back to the waiting room. Keep this a multiple of the client rate so
 * normal use has headroom; it still bounds abuse.
 */
export const PRESENCE_POST_RATE_MAX = 90;

/** Existing-room scene POSTs per account per minute. */
export const SCENE_WRITE_RATE_MAX = 120;

/**
 * Document uploads per account per minute (milestone 2 hardening, SEC-C1).
 *
 * Uploads are 25 MiB binaries buffered in-isolate for digesting, so unlike a
 * JSON scene write each request has real CPU and bandwidth cost. A lesson adds
 * a handful of documents at most; ten per minute leaves generous headroom for
 * retries while bounding what one owner account can push through.
 */
export const DOCUMENTS_UPLOAD_RATE_MAX = 10;

/**
 * Stripe webhook deliveries per client IP per minute (SEC-A21).
 *
 * Stripe sends from a small published set of addresses and retries a 429 with
 * backoff for up to three days, so this delays a burst rather than dropping an
 * event; its job is bounding the signature work an unauthenticated caller can
 * force from one address. Far above this product's real delivery rate.
 */
export const BILLING_WEBHOOK_RATE_MAX = 120;

/** Guest PIN submissions per client IP per minute. */
export const GUEST_AUTH_RATE_MAX = 5;

/** Shared window for every cap above. */
export const RATE_WINDOW_MS = 60_000;
