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

/**
 * Session-issue POSTs per account per minute (M3, session minting).
 *
 * Every mint is a write against the identity Durable Object and a cookie
 * hand-back; a single Access assertion could otherwise repeat it as fast as
 * the DO answers. Ten per minute is far above any real re-authentication
 * (the cookie lives hours) while bounding a stolen assertion's blast radius.
 */
export const SESSION_ISSUE_RATE_MAX = 10;

/**
 * A/V token POSTs per account per minute (M3).
 *
 * Tokens are minted on join and on A/V panel retries; each one is LiveKit
 * JWT signing work in the room Durable Object. Ten per minute bounds that
 * work per account without flapping a real call.
 */
export const AV_TOKEN_RATE_MAX = 10;

/**
 * Board-file PUTs per account per minute (M3).
 *
 * Excalidraw image files are content-addressed and idempotent, but each new
 * id is a full buffered read plus an R2 put, so the 25 MiB cap bounds bytes
 * per request without bounding request rate. Sixty per minute covers a
 * pasting burst while the byte quota still caps total storage.
 */
export const BOARD_FILE_PUT_RATE_MAX = 60;

/**
 * Account-export GETs per account per minute (M3).
 *
 * Each export serializes the whole account — sessions, subjects, rooms —
 * out of the identity Durable Object: the heaviest read a single caller can
 * ask for. Five per minute is generous for a human clicking download and
 * bounding for a loop.
 */
export const ACCOUNT_EXPORT_RATE_MAX = 5;

/** Shared window for every cap above. */
export const RATE_WINDOW_MS = 60_000;
