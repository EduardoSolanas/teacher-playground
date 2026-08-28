import * as decoding from 'lib0/decoding';
import { FOLLOW_MESSAGE_TYPE } from './followMessage';

/**
 * Determines whether a binary frame should be relayed to peers.
 *
 * Only types that clients legitimately send are relayable:
 * - 0: sync (MESSAGE_SYNC) — Yjs protocol updates
 * - 1: awareness — peer state, which is where cursors travel
 * - 101: follow — one participant telling the others where to look
 *
 * Anything else returns false, including message type 100 (presence). We use a
 * positive allowlist rather than a denylist because the object relays on behalf
 * of peers: anything it does not recognise is something a peer invented, not
 * part of the protocol. Presence frames are only one case we happened to find,
 * but the allowlist guards against future attacks of the same shape.
 *
 * The line is who authors the message, not which feature it serves. Presence is
 * the room's own word about who is in it: a peer able to forge one could tell
 * the class it had been kicked. A follow message is a peer's word about its own
 * viewport, which is the entire point of it, so relaying it grants nothing that
 * drawing on the board does not already grant.
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
    return messageType === 0
      || messageType === 1
      || messageType === FOLLOW_MESSAGE_TYPE;
  } catch {
    // Frame too short or malformed to read a varint
    return false;
  }
}
