/*
 * Mutation note (AGENTS.md): five survivors in `isValidPageMessage`'s first
 * guard (`!value || typeof value !== 'object' || Array.isArray(value)`,
 * pageMessage.ts line 27) are equivalent and cannot be killed, for reasons
 * specific to how this function is reached. It is private, called only from
 * `decodePageMessagePayload`, whose value always comes from
 * `JSON.parse(readVarString(...))` -- so it can only ever be null, a
 * boolean, a number, a string, an array, or a plain object, never
 * `undefined` and never an array carrying extra named properties (JSON
 * arrays cannot). Given that closed set of inputs:
 * - Dropping the whole check, or any one clause of it, never lets a
 *   malformed `value` reach a wrongly-`true` result: every case that isn't
 *   already caught here still fails the `keys.length !== 2 ||
 *   !keys.includes('importId') || !keys.includes('index')` check right
 *   after, because `Object.keys(...)` on a boolean, number, string or array
 *   never produces exactly `['importId', 'index']` (JSON cannot attach named
 *   properties to an array, and primitives box to no or index-named keys).
 * - The one case `Object.keys` cannot even evaluate is `null`
 *   (`Object.keys(null)` throws). Weakening the checks so that case reaches
 *   `Object.keys(null)` does not change the outward result, because the
 *   thrown `TypeError` is caught by `decodePageMessagePayload`'s own
 *   `try`/`catch`, which returns `null` -- the same answer the real guard
 *   gives for `null` directly.
 * Both backstops -- the shape check and the outer catch -- are exercised by
 * the tests below; killing the redundant guard itself is not possible
 * without changing what the function is reachable with.
 */
import { describe, expect, it } from 'vitest';
import * as encoding from 'lib0/encoding';
import {
  PAGE_MESSAGE_TYPE,
  decodePageMessage,
  encodePageMessage,
} from './pageMessage';

const VALID_IMPORT_ID = '0123456789abcdef';

/** Frames an arbitrary JSON payload the way encodePageMessage would. */
function framePayload(payload: unknown): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, PAGE_MESSAGE_TYPE);
  encoding.writeVarString(encoder, JSON.stringify(payload));
  return encoding.toUint8Array(encoder);
}

describe('pageMessage codec', () => {
  it('round trips a valid page frame', () => {
    const message = { importId: VALID_IMPORT_ID, index: 3 };
    expect(decodePageMessage(encodePageMessage(message))).toEqual(message);
  });

  it('accepts index 0', () => {
    const message = { importId: VALID_IMPORT_ID, index: 0 };
    expect(decodePageMessage(encodePageMessage(message))).toEqual(message);
  });

  it('rejects a foreign message type', () => {
    expect(decodePageMessage(new Uint8Array([99, 0]))).toBeNull();
  });

  it('rejects a frame that ends before its payload', () => {
    expect(decodePageMessage(new Uint8Array([PAGE_MESSAGE_TYPE]))).toBeNull();
  });

  it('rejects an empty frame', () => {
    expect(decodePageMessage(new Uint8Array([]))).toBeNull();
  });

  it('rejects a numeric importId whose digits happen to look like a valid pattern', () => {
    // 16 digits, all valid hex characters once coerced to a string -- only
    // rejected because importId must actually be a string.
    expect(decodePageMessage(framePayload({ importId: 1234567890123456, index: 0 }))).toBeNull();
  });

  it('rejects payloads that are not plain objects', () => {
    for (const payload of [null, 42, 'page', true, [], [1, 2]]) {
      expect(decodePageMessage(framePayload(payload))).toBeNull();
    }
  });

  it('rejects an importId that is not 16 lowercase hex characters', () => {
    for (const importId of ['', 'abc', VALID_IMPORT_ID.toUpperCase(), `${VALID_IMPORT_ID}0`, 'zzzzzzzzzzzzzzzz']) {
      expect(decodePageMessage(framePayload({ importId, index: 0 }))).toBeNull();
    }
  });

  it('rejects a non-integer index', () => {
    for (const index of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined]) {
      expect(decodePageMessage(framePayload({ importId: VALID_IMPORT_ID, index }))).toBeNull();
    }
  });

  it('rejects an index outside 0..MAX_PAGES_PER_IMPORT-1', () => {
    expect(decodePageMessage(framePayload({ importId: VALID_IMPORT_ID, index: -1 }))).toBeNull();
    expect(decodePageMessage(framePayload({ importId: VALID_IMPORT_ID, index: 50 }))).toBeNull();
  });

  it('accepts the last valid index and rejects one past it', () => {
    expect(decodePageMessage(framePayload({ importId: VALID_IMPORT_ID, index: 49 })))
      .toEqual({ importId: VALID_IMPORT_ID, index: 49 });
    expect(decodePageMessage(framePayload({ importId: VALID_IMPORT_ID, index: 50 }))).toBeNull();
  });

  it('rejects an object with extra keys', () => {
    expect(
      decodePageMessage(framePayload({ importId: VALID_IMPORT_ID, index: 0, extra: 'nope' })),
    ).toBeNull();
  });

  it('rejects an object missing a required key', () => {
    expect(decodePageMessage(framePayload({ importId: VALID_IMPORT_ID }))).toBeNull();
    expect(decodePageMessage(framePayload({ index: 0 }))).toBeNull();
  });
});
