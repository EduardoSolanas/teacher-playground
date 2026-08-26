import { describe, it, expect } from 'vitest';
import { encodePresenceMessage, decodePresenceMessage, PRESENCE_MESSAGE_TYPE, readPresenceBody } from './presenceMessage';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

describe('presenceMessage codec', () => {
  it('encodes and decodes a presence payload round trip', () => {
    const payload = {
      users: [{ peerId: 'peer1', userName: 'User 1', color: '#ff0000' }],
      hostPeerId: 'peer0',
      waitingPeers: [{ peerId: 'peer2', userName: 'Waiting', color: '#00ff00' }],
    };

    const encoded = encodePresenceMessage(payload);
    expect(encoded).toBeInstanceOf(Uint8Array);

    const decoded = decodePresenceMessage(encoded);
    expect(decoded).toEqual(payload);
  });

  it('returns null for a foreign message type', () => {
    // Message type 200 (not PRESENCE_MESSAGE_TYPE which is 100)
    // Create a properly encoded message with wrong type using lib0
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 200); // Wrong type
    encoding.writeVarString(encoder, JSON.stringify({ users: [] }));
    const buffer = encoding.toUint8Array(encoder);

    const decoded = decodePresenceMessage(buffer);
    expect(decoded).toBeNull();
  });

  it('returns null for truncated/garbage bytes without throwing', () => {
    const truncated = new Uint8Array([100, 0, 1]); // Truncated varint
    expect(() => {
      const result = decodePresenceMessage(truncated);
      expect(result).toBeNull();
    }).not.toThrow();
  });

  it('returns null for invalid JSON payload without throwing', () => {
    // Encode message type 100 with invalid JSON bytes
    const buffer = new Uint8Array([100, 5]); // Type 100, then invalid UTF-8
    expect(() => {
      const result = decodePresenceMessage(buffer);
      expect(result).toBeNull();
    }).not.toThrow();
  });

  it('handles unicode characters in payload', () => {
    const payload = {
      users: [{ peerId: 'peer1', userName: '用户 😀', color: '#ff0000' }],
    };

    const encoded = encodePresenceMessage(payload);
    const decoded = decodePresenceMessage(encoded);
    expect(decoded).toEqual(payload);
  });

  it('encodes message type as first varint', () => {
    const payload = { users: [] };
    const encoded = encodePresenceMessage(payload);

    // First byte should be the varint for PRESENCE_MESSAGE_TYPE (100)
    // 100 < 128, so it's a single byte
    expect(encoded[0]).toBe(PRESENCE_MESSAGE_TYPE);
  });
});

describe('readPresenceBody', () => {
  it('reads a presence body from a decoder pointing at the body (after type varint consumed)', () => {
    const payload = {
      users: [{ peerId: 'peer1', userName: 'User 1', color: '#ff0000' }],
      hostPeerId: 'peer0',
    };

    // Build a frame and manually advance past the type varint
    const frame = encodePresenceMessage(payload);
    const decoder = decoding.createDecoder(frame);
    decoding.readVarUint(decoder); // consume type varint

    // readPresenceBody should read the body and parse JSON
    const result = readPresenceBody(decoder);
    expect(result).toEqual(payload);
  });

  it('returns null on malformed input (truncated body) without throwing', () => {
    // Create an encoder with just a type varint, no body
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, PRESENCE_MESSAGE_TYPE);
    // Intentionally no writeVarString

    const frame = encoding.toUint8Array(encoder);
    const decoder = decoding.createDecoder(frame);
    decoding.readVarUint(decoder); // consume type varint

    // Decoder now points at empty/invalid body
    expect(() => {
      const result = readPresenceBody(decoder);
      expect(result).toBeNull();
    }).not.toThrow();
  });

  it('returns null on invalid JSON without throwing', () => {
    // Create a frame with garbage after the type varint (invalid UTF-8)
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, PRESENCE_MESSAGE_TYPE);
    encoding.writeVarUint(encoder, 255); // Invalid UTF-8 length marker

    const frame = encoding.toUint8Array(encoder);
    const decoder = decoding.createDecoder(frame);
    decoding.readVarUint(decoder); // consume type varint

    expect(() => {
      const result = readPresenceBody(decoder);
      expect(result).toBeNull();
    }).not.toThrow();
  });
});
