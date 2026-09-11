/**
 * Stripe webhook signature verification (spec §7.1).
 *
 * Stripe signs webhook payloads as `t=<unix seconds>,v1=<hmac-sha256 hex>`
 * where the signed message is `${t}.${body}`. Rotation delivers several
 * comma-separated `v1` entries (and several configured secrets); any matching
 * (secret, v1) pair succeeds. Timestamps are checked against `nowMs` with a
 * 300 s tolerance on both sides.
 */

export type SignatureVerification =
  | { valid: true; payloadHash: string }
  | {
      valid: false;
      reason:
        | 'missing_header'
        | 'no_v1'
        | 'expired'
        | 'no_matching_secret'
        | 'mismatch';
    };

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

async function verifyHmacSha256(
  secret: string,
  data: BufferSource,
  signature: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, signature, data);
}

async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

/**
 * Verifies a Stripe `Stripe-Signature` header against every supplied secret.
 * The payload hash is the lowercase hex SHA-256 of the raw body (audit only).
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secrets: readonly string[],
  nowMs: number,
  toleranceMs = 300_000,
): Promise<SignatureVerification> {
  if (signatureHeader === null || signatureHeader.trim() === '') {
    return { valid: false, reason: 'missing_header' };
  }

  let timestamp: string | undefined;
  const v1Signatures: string[] = [];
  for (const rawToken of signatureHeader.split(',')) {
    const token = rawToken.trim();
    const eq = token.indexOf('=');
    if (eq === -1) continue;
    const name = token.slice(0, eq).trim().toLowerCase();
    const value = token.slice(eq + 1).trim();
    if (name === 't' && timestamp === undefined) {
      timestamp = value;
    } else if (name === 'v1') {
      v1Signatures.push(value.toLowerCase());
    }
  }

  if (v1Signatures.length === 0) {
    return { valid: false, reason: 'no_v1' };
  }
  if (timestamp === undefined || !/^\d+$/.test(timestamp)) {
    return { valid: false, reason: 'mismatch' };
  }

  const timestampSec = Number(timestamp);
  if (Math.abs(nowMs - timestampSec * 1000) > toleranceMs) {
    return { valid: false, reason: 'expired' };
  }
  if (secrets.length === 0) {
    return { valid: false, reason: 'no_matching_secret' };
  }

  const message = new TextEncoder().encode(`${timestamp}.${rawBody}`);
  for (const secret of secrets) {
    for (const v1 of v1Signatures) {
      const signature = hexToBytes(v1);
      if (signature !== null && (await verifyHmacSha256(secret, message, signature))) {
        return { valid: true, payloadHash: await sha256Hex(rawBody) };
      }
    }
  }
  return { valid: false, reason: 'mismatch' };
}