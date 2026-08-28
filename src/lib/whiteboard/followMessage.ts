import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

export const FOLLOW_MESSAGE_TYPE = 101;
export const FOLLOW_COORDINATE_LIMIT = 10_000_000;
export const FOLLOW_MIN_ZOOM = 0.1;
export const FOLLOW_MAX_ZOOM = 8;

export type FollowViewport = { x: number; y: number; zoom: number };
export type FollowMessage =
  | { active: true; viewport: FollowViewport }
  | { active: false };

export function isValidFollowViewport(value: unknown): value is FollowViewport {
  if (!value || typeof value !== 'object') return false;
  const viewport = value as Partial<FollowViewport>;
  return Number.isFinite(viewport.x)
    && Number.isFinite(viewport.y)
    && Number.isFinite(viewport.zoom)
    && Math.abs(viewport.x as number) <= FOLLOW_COORDINATE_LIMIT
    && Math.abs(viewport.y as number) <= FOLLOW_COORDINATE_LIMIT
    && (viewport.zoom as number) >= FOLLOW_MIN_ZOOM
    && (viewport.zoom as number) <= FOLLOW_MAX_ZOOM;
}

function parseFollowPayload(value: unknown): FollowMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as { active?: unknown; viewport?: unknown };
  if (message.active === false && message.viewport === undefined) {
    return { active: false };
  }
  if (message.active === true && isValidFollowViewport(message.viewport)) {
    return { active: true, viewport: message.viewport };
  }
  return null;
}

export function encodeFollowMessage(message: FollowMessage): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, FOLLOW_MESSAGE_TYPE);
  encoding.writeVarString(encoder, JSON.stringify(message));
  return encoding.toUint8Array(encoder);
}

export function decodeFollowMessagePayload(
  decoder: decoding.Decoder,
): FollowMessage | null {
  try {
    return parseFollowPayload(JSON.parse(decoding.readVarString(decoder)));
  } catch {
    return null;
  }
}

export function decodeFollowMessage(data: Uint8Array): FollowMessage | null {
  try {
    const decoder = decoding.createDecoder(data);
    if (decoding.readVarUint(decoder) !== FOLLOW_MESSAGE_TYPE) return null;
    return decodeFollowMessagePayload(decoder);
  } catch {
    return null;
  }
}
