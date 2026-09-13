import { describe, expect, it } from 'vitest';
import * as encoding from 'lib0/encoding';
import {
  FOLLOW_COORDINATE_LIMIT,
  FOLLOW_MAX_ZOOM,
  FOLLOW_MESSAGE_TYPE,
  FOLLOW_MIN_ZOOM,
  decodeFollowMessage,
  encodeFollowMessage,
  isValidFollowViewport,
} from './followMessage';

/** Frames an arbitrary JSON payload the way encodeFollowMessage would. */
function framePayload(payload: unknown): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, FOLLOW_MESSAGE_TYPE);
  encoding.writeVarString(encoder, JSON.stringify(payload));
  return encoding.toUint8Array(encoder);
}

describe('followMessage codec', () => {
  it('round trips an active guide viewport', () => {
    const message = { active: true, viewport: { x: -120, y: 42, zoom: 1.25 } };
    expect(decodeFollowMessage(encodeFollowMessage(message))).toEqual(message);
  });

  it('round trips a stop message', () => {
    expect(decodeFollowMessage(encodeFollowMessage({ active: false }))).toEqual({ active: false });
  });

  it('rejects foreign, malformed, and out-of-bounds messages', () => {
    expect(decodeFollowMessage(new Uint8Array([99, 0]))).toBeNull();
    expect(decodeFollowMessage(new Uint8Array([FOLLOW_MESSAGE_TYPE, 1]))).toBeNull();
    expect(isValidFollowViewport({ x: Number.NaN, y: 0, zoom: 1 })).toBe(false);
    expect(isValidFollowViewport({ x: 0, y: 0, zoom: 100 })).toBe(false);
    expect(isValidFollowViewport({ x: 0, y: 0, zoom: 1 })).toBe(true);
  });

  it('rejects payloads that are not objects', () => {
    for (const payload of [null, 42, 'follow', true, [], [1, 2]]) {
      expect(decodeFollowMessage(framePayload(payload))).toBeNull();
    }
  });

  it('accepts viewports exactly at the limits and rejects just beyond them', () => {
    expect(
      isValidFollowViewport({
        x: FOLLOW_COORDINATE_LIMIT,
        y: -FOLLOW_COORDINATE_LIMIT,
        zoom: FOLLOW_MIN_ZOOM,
      }),
    ).toBe(true);
    expect(
      isValidFollowViewport({
        x: -FOLLOW_COORDINATE_LIMIT,
        y: FOLLOW_COORDINATE_LIMIT,
        zoom: FOLLOW_MAX_ZOOM,
      }),
    ).toBe(true);
    expect(isValidFollowViewport({ x: FOLLOW_COORDINATE_LIMIT + 1, y: 0, zoom: 1 })).toBe(false);
    expect(isValidFollowViewport({ x: 0, y: FOLLOW_COORDINATE_LIMIT + 1, zoom: 1 })).toBe(false);
    expect(isValidFollowViewport({ x: 0, y: 0, zoom: FOLLOW_MIN_ZOOM - 0.01 })).toBe(false);
    expect(isValidFollowViewport({ x: 0, y: 0, zoom: FOLLOW_MAX_ZOOM + 0.01 })).toBe(false);
  });

  it('requires finite coordinates and zoom', () => {
    expect(isValidFollowViewport({ x: Number.NaN, y: 0, zoom: 1 })).toBe(false);
    expect(isValidFollowViewport({ x: 0, y: Number.POSITIVE_INFINITY, zoom: 1 })).toBe(false);
    expect(isValidFollowViewport({ x: 0, y: 0, zoom: Number.NaN })).toBe(false);
    expect(isValidFollowViewport({ x: 0, y: 0, zoom: '1' })).toBe(false);
    expect(isValidFollowViewport({ x: '0', y: 0, zoom: 1 })).toBe(false);
    expect(isValidFollowViewport(null)).toBe(false);
    expect(isValidFollowViewport('viewport')).toBe(false);
    expect(isValidFollowViewport([])).toBe(false);
  });

  it('accepts plain data only, not callable objects carrying viewport fields', () => {
    const callable = Object.assign(() => undefined, { x: 0, y: 0, zoom: 1 });
    expect(isValidFollowViewport(callable)).toBe(false);
  });

  it('rejects a frame that ends before its payload', () => {
    expect(decodeFollowMessage(new Uint8Array([FOLLOW_MESSAGE_TYPE]))).toBeNull();
  });

  it('rejects a stop message that carries a viewport', () => {
    expect(
      decodeFollowMessage(framePayload({ active: false, viewport: { x: 0, y: 0, zoom: 1 } })),
    ).toBeNull();
  });

  it('rejects an active message without a valid viewport', () => {
    for (const viewport of [undefined, null, 'viewport', [], { x: 0, y: 0 }, { x: 0, y: 0, zoom: 100 }]) {
      expect(decodeFollowMessage(framePayload({ active: true, viewport }))).toBeNull();
    }
  });

  it('rejects a payload whose active flag is not a boolean', () => {
    expect(
      decodeFollowMessage(framePayload({ active: 'yes', viewport: { x: 0, y: 0, zoom: 1 } })),
    ).toBeNull();
    expect(
      decodeFollowMessage(framePayload({ active: 1, viewport: { x: 0, y: 0, zoom: 1 } })),
    ).toBeNull();
  });
});
