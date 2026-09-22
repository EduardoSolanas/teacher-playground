/**
 * Opaque, per-room LiveKit participant identities (audit M4).
 *
 * LiveKit shows every participant every other participant's identity, so the
 * identity must never be the accountId itself: every call participant would
 * learn every other participant's stable account id, while the HTTP layer
 * deliberately redacts accountIds from non-owner presence. It is also bound
 * to the room, so the same person is a different pseudonym in every room and
 * two room rosters cannot be linked.
 *
 * The identity is still fully server-bound: it is derived here from the
 * server-verified accountId with the Worker-side LiveKit secret as the HMAC
 * key, and the client never supplies or influences it. Without the secret a
 * participant can neither predict a pseudonym nor confirm a guessed
 * accountId-to-identity mapping. The same derivation is recomputed by the
 * Room Service calls (kick eviction, mute, screen-share), so it must stay
 * deterministic.
 */

import { hmacSha256 } from './livekitToken';

const encoder = new TextEncoder();

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

function hex(bytes: Uint8Array): string {
  let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export async function deriveLiveKitIdentity(
  apiSecret: string,
  roomId: string,
  accountId: string,
): Promise<string> {
  // JSON so a newline in either value can never shift the boundary between
  // them and one (room, account) pair can never hash like another.
  const message = JSON.stringify([roomId, accountId]);
  const digest = await hmacSha256(utf8(apiSecret), utf8(message));
  // 128 bits of the HMAC: far past collision-attack territory for a room
  // roster, and a short stable pseudonym rather than a full digest.
  return hex(digest).slice(0, 32);
}
