/**
 * LiveKit access token issuance.
 *
 * LiveKit uses short-lived HS256 JWTs for room access. This module signs them
 * with the Web Crypto API so it runs on both Cloudflare Workers and in Node
 * (Vitest), with no server-side SDK dependency.
 *
 * Provider decision (spike): **LiveKit** was chosen over Daily and Cloudflare
 * Calls because it is the most widely deployed self-hostable SFU, has a
 * generous free cloud tier, and its tokens are plain HS256 JWTs that can be
 * signed directly on the Workers runtime with `crypto.subtle`.
 *
 * Claim shape follows LiveKit's documented JWT:
 *   iss = API key, sub = participant identity, video = VideoGrant.
 */

export const LIVEKIT_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour (LiveKit default)

/** LiveKit room (video) grants. */
export interface LiveKitGrant {
  readonly canPublish?: boolean;
  readonly canSubscribe?: boolean;
  readonly canPublishData?: boolean;
  readonly roomCreate?: boolean;
  readonly roomJoin?: boolean;
}

export interface BuildLiveKitTokenInput {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly room: string;
  readonly identity: string;
  readonly name?: string;
  readonly ttlSeconds?: number;
  readonly grant?: LiveKitGrant;
}

/** Base64url encodes bytes without padding. */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

async function hmacSha256(
  secret: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, data);
  return new Uint8Array(signature);
}

/**
 * Builds a LiveKit access token (HS256 JWT) for one participant.
 *
 * Claims follow the LiveKit server convention:
 * - `iss`: the API key
 * - `sub`: the participant identity
 * - `video`: publish/subscribe permissions + room name
 * - `exp` / `nbf`: short-lived window
 */
export async function buildLiveKitToken(
  input: BuildLiveKitTokenInput,
): Promise<string> {
  const ttlSeconds = input.ttlSeconds ?? LIVEKIT_TOKEN_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSeconds;
  const video: LiveKitGrant & { room: string } = {
    canPublish: input.grant?.canPublish ?? true,
    canSubscribe: input.grant?.canSubscribe ?? true,
    canPublishData: input.grant?.canPublishData ?? true,
    roomJoin: input.grant?.roomJoin ?? true,
    room: input.room,
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: Record<string, unknown> = {
    iss: input.apiKey,
    sub: input.identity,
    nbf: now,
    exp,
    video,
  };
  if (input.name) payload.name = input.name;

  const encodedHeader = base64url(utf8(JSON.stringify(header)));
  const encodedPayload = base64url(utf8(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const secret = utf8(input.apiSecret);
  const signature = await hmacSha256(secret, utf8(signingInput));

  return `${signingInput}.${base64url(signature)}`;
}

/** TTL for LiveKit Room Service API JWTs (short-lived admin tokens). */
export const LIVEKIT_ROOM_SERVICE_TOKEN_TTL_SECONDS = 60;

export interface BuildLiveKitRoomServiceTokenInput {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly room: string;
  readonly ttlSeconds?: number;
}

/**
 * Builds a short-lived HS256 JWT for LiveKit Room Service HTTP APIs.
 *
 * Claims: iss = API key, video.roomAdmin = true, video.room = room name.
 */
export async function buildLiveKitRoomServiceToken(
  input: BuildLiveKitRoomServiceTokenInput,
): Promise<string> {
  const ttlSeconds = input.ttlSeconds ?? LIVEKIT_ROOM_SERVICE_TOKEN_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSeconds;

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: Record<string, unknown> = {
    iss: input.apiKey,
    sub: input.apiKey,
    nbf: now,
    exp,
    video: {
      roomAdmin: true,
      room: input.room,
    },
  };

  const encodedHeader = base64url(utf8(JSON.stringify(header)));
  const encodedPayload = base64url(utf8(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const secret = utf8(input.apiSecret);
  const signature = await hmacSha256(secret, utf8(signingInput));

  return `${signingInput}.${base64url(signature)}`;
}

/** Parses a LiveKit config from a Worker env binding (all-or-nothing). */
export interface LiveKitConfig {
  readonly url: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}

/**
 * Trimmed, because the whitespace is invisible and the failure is total.
 *
 * A secret put in from a file or a copied line keeps its trailing newline, and
 * an HMAC over a secret with a newline on the end is simply a different HMAC.
 * What comes out is a well-formed JWT signed with the wrong key, so the media server answers 401
 * to everything carrying it -- region settings, validate, the signal socket --
 * and nothing in the token, the logs or the config reads as wrong. Trimming
 * costs nothing: no LiveKit credential has meaningful leading or trailing
 * space, and a value that is only space was never a credential at all.
 */
function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function parseLiveKitConfig(value: unknown): LiveKitConfig | null {
  const record = (value ?? {}) as Record<string, unknown>;
  const url = trimmedString(record.LIVEKIT_URL);
  const apiKey = trimmedString(record.LIVEKIT_API_KEY);
  const apiSecret = trimmedString(record.LIVEKIT_API_SECRET);
  if (url === null || apiKey === null || apiSecret === null) return null;
  return { url, apiKey, apiSecret };
}

/** Verifies a LiveKit token's HS256 signature and claims (used in tests). */
export async function verifyLiveKitToken(
  token: string,
  apiSecret: string,
): Promise<{ valid: boolean; payload: Record<string, unknown> }> {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, payload: {} };
  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const expected = await hmacSha256(utf8(apiSecret), utf8(signingInput));
  const actual = base64url(expected);
  if (actual !== signatureB64) return { valid: false, payload: {} };
  const payload = JSON.parse(decodeBase64Url(payloadB64)) as Record<string, unknown>;
  return { valid: true, payload };
}

function decodeBase64Url(text: string): string {
  const normalized = text.replaceAll('-', '+').replaceAll('_', '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return decodeURIComponent(Array.from(atob(normalized + padding)).map((c) => {
    const hex = c.charCodeAt(0).toString(16).padStart(2, '0');
    return `%${hex}`;
  }).join(''));
}
