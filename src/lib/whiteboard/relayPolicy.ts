import * as decoding from 'lib0/decoding';

/**
 * Determines whether a binary frame should be relayed to peers.
 *
 * Only y-protocol types that clients legitimately send are relayable:
 * - 0: sync (MESSAGE_SYNC) — Yjs protocol updates
 * - 1: awareness — peer awareness state
 *
 * Anything else returns false, including message type 100 (presence). We use a
 * positive allowlist rather than a denylist because the object relays on behalf
 * of peers: anything it does not recognise is something a peer invented, not
 * part of the protocol. Presence frames are only one case we happened to find,
 * but the allowlist guards against future attacks of the same shape.
 *
 * Never throws: a frame too short to hold a varint, or empty, returns false.
 */
export function isRelayableFrame(bytes: Uint8Array): boolean {
  if (bytes.length === 0) {
    return false;
  }

  try {
    const decoder = decoding.createDecoder(bytes);
    const messageType = decoding.readVarUint(decoder);
    // Only relay sync (0) and awareness (1)
    return messageType === 0 || messageType === 1;
  } catch {
    // Frame too short or malformed to read a varint
    return false;
  }
}
