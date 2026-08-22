import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const VERSION = 1;

/**
 * Encode points array into a compact binary format using delta encoding.
 *
 * Format:
 * - 1 byte: version (1)
 * - varint: point count
 * - for each point: quantized coordinate pairs (100ths of a pixel), delta-encoded
 *
 * Returns null for invalid input (not an array, non-finite numbers, misshapen entries).
 * Quantization to hundredths (0.01px) is far below human perception.
 * Delta encoding exploits that stroke samples are usually a few pixels apart.
 */
export function encodePoints(points: unknown): Uint8Array | null {
  // Validate input type
  if (!Array.isArray(points)) {
    return null;
  }

  // Validate all entries are [number, number] pairs with finite values
  for (const entry of points) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return null;
    }
    const [x, y] = entry;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
  }

  const encoder = encoding.createEncoder();

  // Write version byte
  encoding.writeUint8(encoder, VERSION);

  // Write point count
  encoding.writeVarUint(encoder, points.length);

  // Encode points with delta encoding using signed varints
  let prevX = 0;
  let prevY = 0;

  for (const [x, y] of points as Array<[number, number]>) {
    // Quantize to hundredths
    const qx = Math.round(x * 100);
    const qy = Math.round(y * 100);

    // Delta encode (difference from previous)
    const dx = qx - prevX;
    const dy = qy - prevY;

    // Write deltas as signed varints
    encoding.writeVarInt(encoder, dx);
    encoding.writeVarInt(encoder, dy);

    prevX = qx;
    prevY = qy;
  }

  return encoding.toUint8Array(encoder);
}

/**
 * Decode points from binary format, legacy JSON string, or already-decoded array.
 *
 * Accepts three forms for backward compatibility:
 * 1. Uint8Array in the binary format
 * 2. JSON string of the points array
 * 3. Plain array already decoded
 *
 * Returns null for unrecognized input or malformed bytes.
 * Never throws on corrupt data (graceful degradation for untrusted network data).
 */
export function decodePoints(value: unknown): number[][] | null {
  // Handle legacy JSON string
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Not valid JSON
    }
    return null;
  }

  // Handle already-decoded array
  if (Array.isArray(value)) {
    return value;
  }

  // Handle binary format
  if (!(value instanceof Uint8Array)) {
    return null;
  }

  // Minimum buffer: at least version byte (1) + count varint (1+)
  if (value.length < 2) {
    return null;
  }

  try {
    const decoder = decoding.createDecoder(value);

    // Read and verify version byte
    const version = decoding.readUint8(decoder);
    if (version !== VERSION) {
      return null;
    }

    // Read point count
    const count = decoding.readVarUint(decoder);

    // Decode points with delta decoding
    const points: number[][] = [];
    let prevX = 0;
    let prevY = 0;

    for (let i = 0; i < count; i++) {
      // Read deltas as signed varints
      const dx = decoding.readVarInt(decoder);
      const dy = decoding.readVarInt(decoder);

      // Reconstruct quantized coordinates
      const qx = prevX + dx;
      const qy = prevY + dy;

      // Dequantize back to original scale
      const x = qx / 100;
      const y = qy / 100;

      points.push([x, y]);

      prevX = qx;
      prevY = qy;
    }

    return points;
  } catch {
    // Gracefully handle malformed bytes
    return null;
  }
}
