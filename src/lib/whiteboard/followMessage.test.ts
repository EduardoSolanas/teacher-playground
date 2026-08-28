import { describe, expect, it } from 'vitest';
import {
  FOLLOW_MESSAGE_TYPE,
  decodeFollowMessage,
  encodeFollowMessage,
  isValidFollowViewport,
} from './followMessage';

describe('followMessage codec', () => {
  it('round trips an active guide viewport', () => {
    const message = { active: true, viewport: { x: -120, y: 42, zoom: 1.25 } };
    expect(decodeFollowMessage(encodeFollowMessage(message))).toEqual(message);
  });

  it('rejects foreign, malformed, and out-of-bounds messages', () => {
    expect(decodeFollowMessage(new Uint8Array([99, 0]))).toBeNull();
    expect(decodeFollowMessage(new Uint8Array([FOLLOW_MESSAGE_TYPE, 1]))).toBeNull();
    expect(isValidFollowViewport({ x: Number.NaN, y: 0, zoom: 1 })).toBe(false);
    expect(isValidFollowViewport({ x: 0, y: 0, zoom: 100 })).toBe(false);
    expect(isValidFollowViewport({ x: 0, y: 0, zoom: 1 })).toBe(true);
  });
});
