import { describe, expect, it } from 'vitest';
import * as encoding from 'lib0/encoding';
import { isRelayableFrame } from './relayPolicy';
import { PRESENCE_MESSAGE_TYPE } from './presenceMessage';
import { FOLLOW_MESSAGE_TYPE } from './followMessage';
import { MESSAGE_SYNC } from './serverSync';

describe('isRelayableFrame', () => {
  it('returns true for sync message type 0', () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, 'test data');
    const bytes = encoding.toUint8Array(encoder);

    expect(isRelayableFrame(bytes)).toBe(true);
  });

  it('returns true for awareness message type 1', () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarString(encoder, 'awareness data');
    const bytes = encoding.toUint8Array(encoder);

    expect(isRelayableFrame(bytes)).toBe(true);
  });

  it('returns false for presence message type 100', () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, PRESENCE_MESSAGE_TYPE);
    encoding.writeVarString(encoder, JSON.stringify({ isKicked: true }));
    const bytes = encoding.toUint8Array(encoder);

    expect(isRelayableFrame(bytes)).toBe(false);
  });

  it('relays follow messages, which peers author by design', () => {
    // Unlike presence, a follow message legitimately originates from a peer:
    // it is one participant telling the others where to look. Leaving it out
    // of the allowlist would drop it at the room and the feature would be dead
    // on the wire with nothing to show why.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, FOLLOW_MESSAGE_TYPE);
    encoding.writeVarString(encoder, JSON.stringify({ type: 'guide' }));

    expect(isRelayableFrame(encoding.toUint8Array(encoder))).toBe(true);
  });

  it('returns false for arbitrary unknown message type', () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 42);
    encoding.writeVarString(encoder, 'unknown type');
    const bytes = encoding.toUint8Array(encoder);

    expect(isRelayableFrame(bytes)).toBe(false);
  });

  it('returns false for empty Uint8Array', () => {
    const bytes = new Uint8Array();
    expect(isRelayableFrame(bytes)).toBe(false);
  });

  it('returns false for truncated buffer too short to hold a varint', () => {
    // A buffer with just one byte that could be a varint marker
    // but no following data - simulates a truncated frame
    const bytes = new Uint8Array([255]); // High bit set indicates multi-byte varint
    expect(isRelayableFrame(bytes)).toBe(false);
  });
});
