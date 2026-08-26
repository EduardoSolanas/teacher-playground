import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

export const PRESENCE_MESSAGE_TYPE = 100;

/**
 * Encodes a presence payload as a binary message.
 * Format: [varint message type][var-length JSON string]
 */
export function encodePresenceMessage(payload: unknown): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, PRESENCE_MESSAGE_TYPE);
  encoding.writeVarString(encoder, JSON.stringify(payload));
  return encoding.toUint8Array(encoder);
}

/**
 * Reads the presence body from a decoder that has already consumed the type varint.
 * Returns null if the payload is not valid JSON. Never throws on malformed input.
 * This is used by y-websocket message handlers, which consume the type varint before dispatch.
 */
export function readPresenceBody(decoder: decoding.Decoder): unknown | null {
  try {
    const jsonString = decoding.readVarString(decoder);
    return JSON.parse(jsonString);
  } catch {
    return null;
  }
}

/**
 * Decodes a presence message from binary.
 * Returns null if the message type is not PRESENCE_MESSAGE_TYPE or if the
 * payload is not valid JSON. Never throws on malformed input.
 */
export function decodePresenceMessage(data: Uint8Array): unknown | null {
  try {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    if (messageType !== PRESENCE_MESSAGE_TYPE) {
      return null;
    }

    return readPresenceBody(decoder);
  } catch {
    return null;
  }
}
