/**
 * Codec for the owner-only page-turn frame (spec/PAGED_DOCUMENTS_SPEC.md
 * §5.1), mirroring `followMessage.ts`: a private y-websocket frame, decoded
 * before the Yjs path and never applied to the Yjs document. Wiring it into
 * `RoomDO` is a later milestone; this module only encodes and decodes it.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

export const PAGE_MESSAGE_TYPE = 103;

/** Largest import a page frame may name (mirrors `pdfImport.ts`). */
const MAX_PAGES_PER_IMPORT = 50;

const IMPORT_ID_PATTERN = /^[0-9a-f]{16}$/;

export type PageMessage = { importId: string; index: number };

/**
 * Valid only when `importId` matches the 16-hex-character import id pattern,
 * `index` is an integer with `0 <= index < MAX_PAGES_PER_IMPORT`, and the
 * object carries no other keys -- an object with an extra key is rejected
 * rather than silently stripped, the same strictness `followMessage.ts`
 * applies to its own shape.
 */
function isValidPageMessage(value: unknown): value is PageMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('importId') || !keys.includes('index')) return false;

  const { importId, index } = value as { importId?: unknown; index?: unknown };
  return typeof importId === 'string' && IMPORT_ID_PATTERN.test(importId)
    && Number.isInteger(index) && (index as number) >= 0 && (index as number) < MAX_PAGES_PER_IMPORT;
}

function parsePagePayload(value: unknown): PageMessage | null {
  return isValidPageMessage(value) ? { importId: value.importId, index: value.index } : null;
}

export function encodePageMessage(message: PageMessage): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, PAGE_MESSAGE_TYPE);
  encoding.writeVarString(encoder, JSON.stringify(message));
  return encoding.toUint8Array(encoder);
}

export function decodePageMessagePayload(decoder: decoding.Decoder): PageMessage | null {
  try {
    return parsePagePayload(JSON.parse(decoding.readVarString(decoder)));
  } catch {
    return null;
  }
}

export function decodePageMessage(data: Uint8Array): PageMessage | null {
  try {
    const decoder = decoding.createDecoder(data);
    if (decoding.readVarUint(decoder) !== PAGE_MESSAGE_TYPE) return null;
    return decodePageMessagePayload(decoder);
  } catch {
    return null;
  }
}
