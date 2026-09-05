import { describe, it, expect } from 'vitest';
import {
  encodeCallMessage,
  decodeCallMessage,
  decodeCallMessagePayload,
  CALL_MESSAGE_TYPE,
  type CallState,
} from './callMessage';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

function encodeRaw(payload: unknown): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, CALL_MESSAGE_TYPE);
  encoding.writeVarString(encoder, JSON.stringify(payload));
  return encoding.toUint8Array(encoder);
}

describe('callMessage', () => {
  it('round-trips an active call state', () => {
    const state: CallState = {
      active: true,
      hostAccountId: 'host-123',
      startedAt: 1000,
    };
    const encoded = encodeCallMessage(state);
    const decoded = decodeCallMessage(encoded);
    expect(decoded).toEqual(state);
  });

  it('round-trips an inactive call state', () => {
    const state: CallState = { active: false };
    const encoded = encodeCallMessage(state);
    const decoded = decodeCallMessage(encoded);
    expect(decoded).toEqual(state);
  });

  it('rejects a message with wrong type', () => {
    const encoded = encodeCallMessage({ active: false });
    encoded[0] = 99;
    expect(decodeCallMessage(encoded)).toBeNull();
  });

  it('rejects active state without hostAccountId', () => {
    expect(decodeCallMessage(encodeRaw({ active: true, startedAt: 1000 }))).toBeNull();
  });

  it('rejects active state with empty hostAccountId', () => {
    expect(
      decodeCallMessage(encodeRaw({ active: true, hostAccountId: '', startedAt: 1000 })),
    ).toBeNull();
  });

  it('rejects garbage bytes', () => {
    expect(decodeCallMessage(new Uint8Array([255, 0, 1]))).toBeNull();
  });

  it('decodes the payload after the type has been consumed', () => {
    const state: CallState = {
      active: true,
      hostAccountId: 'host-456',
      startedAt: 2000,
    };
    const encoded = encodeCallMessage(state);
    const decoder = decoding.createDecoder(encoded);
    expect(decoding.readVarUint(decoder)).toBe(CALL_MESSAGE_TYPE);
    expect(decodeCallMessagePayload(decoder)).toEqual(state);
  });
});
