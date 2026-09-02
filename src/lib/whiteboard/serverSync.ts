import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { serializeInternalError } from '../http/safeError';

/** y-websocket message type for the sync protocol. Awareness is 1, presence 100. */
export const MESSAGE_SYNC = 0;

/**
 * Applies one y-websocket frame to the server's document and returns the frames
 * owed back to the sender.
 *
 * - **sync step 1** (the sender's state vector): a step 2 carrying the diff it
 *   is missing, plus the server's own step 1 so the sender answers with what
 *   the server does not have. Without that second frame the server would only
 *   ever hand boards out, never take one in.
 * - **sync step 2 / update**: applied to `doc`; usually nothing to reply.
 * - **anything else** (awareness, presence): left alone, `[]`.
 *
 * Never throws. The caller has already relayed these bytes to the peers, and a
 * frame the server cannot parse must not cost them that relay.
 */
export function handleSyncFrame(
  doc: Y.Doc,
  bytes: Uint8Array,
  origin?: unknown,
  options: { readOnly?: boolean } = {},
): Uint8Array[] {
  try {
    if (options.readOnly) {
      const typeDecoder = decoding.createDecoder(bytes);
      if (decoding.readVarUint(typeDecoder) !== MESSAGE_SYNC) return [];
      if (decoding.readVarUint(typeDecoder) !== syncProtocol.messageYjsSyncStep1) return [];
    }

    const decoder = decoding.createDecoder(bytes);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return [];

    const replyEncoder = encoding.createEncoder();
    encoding.writeVarUint(replyEncoder, MESSAGE_SYNC);
    const syncMessageType = syncProtocol.readSyncMessage(decoder, replyEncoder, doc, origin);

    const replies: Uint8Array[] = [];
    // Length 1 is the message type alone: the protocol had nothing to say back.
    if (encoding.length(replyEncoder) > 1) {
      replies.push(encoding.toUint8Array(replyEncoder));
    }
    if (syncMessageType === syncProtocol.messageYjsSyncStep1 && !options.readOnly) {
      const stepOneEncoder = encoding.createEncoder();
      encoding.writeVarUint(stepOneEncoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(stepOneEncoder, doc);
      replies.push(encoding.toUint8Array(stepOneEncoder));
    }
    return replies;
  } catch (err) {
    console.error(JSON.stringify(serializeInternalError(err, 'handleSyncFrame')));
    return [];
  }
}

/**
 * Wraps a document update as a sync frame the clients already understand.
 *
 * The object usually answers the socket that spoke to it; this is for the
 * updates it makes on its own — sweeping a departed peer's cursor — which have
 * to reach every socket in the room unprompted.
 */
export function encodeUpdateFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}
