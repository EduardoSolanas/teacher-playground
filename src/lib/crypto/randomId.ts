/** Minimum entropy for room and peer identifiers (SEC-006). */
export const CSPRNG_ID_BYTES = 16;
export const CSPRNG_ID_HEX_LENGTH = CSPRNG_ID_BYTES * 2;

/**
 * Hex-encoded identifier from `crypto.getRandomValues`. Default 128 bits.
 * Display/share codes are locators only — authorization is `account_id`.
 */
export function randomHexId(byteCount = CSPRNG_ID_BYTES): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function generateRoomId(): string {
  return randomHexId();
}
