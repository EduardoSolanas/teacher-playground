import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

/**
 * Binary control-message type for call state.
 *
 * Same framing as follow (101): a y-websocket-style varuint type followed by a
 * JSON payload. The server gates writes to owner-role sockets and stores the
 * state durably so late joiners receive it on admission.
 */
export const CALL_MESSAGE_TYPE = 102;

export type CallState =
  | { active: true; hostAccountId: string; startedAt: number }
  | { active: false };

function parseCallPayload(value: unknown): CallState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const msg = value as { active?: unknown; hostAccountId?: unknown; startedAt?: unknown };
  if (msg.active === false) return { active: false };
  if (
    msg.active === true &&
    typeof msg.hostAccountId === 'string' &&
    msg.hostAccountId.length > 0 &&
    typeof msg.startedAt === 'number' &&
    Number.isFinite(msg.startedAt)
  ) {
    return { active: true, hostAccountId: msg.hostAccountId, startedAt: msg.startedAt };
  }
  return null;
}

export function encodeCallMessage(state: CallState): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, CALL_MESSAGE_TYPE);
  encoding.writeVarString(encoder, JSON.stringify(state));
  return encoding.toUint8Array(encoder);
}

export function decodeCallMessagePayload(
  decoder: decoding.Decoder,
): CallState | null {
  try {
    return parseCallPayload(JSON.parse(decoding.readVarString(decoder)));
  } catch {
    return null;
  }
}

export function decodeCallMessage(data: Uint8Array): CallState | null {
  try {
    const decoder = decoding.createDecoder(data);
    if (decoding.readVarUint(decoder) !== CALL_MESSAGE_TYPE) return null;
    return decodeCallMessagePayload(decoder);
  } catch {
    return null;
  }
}
