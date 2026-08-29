import { deflateSync } from 'node:zlib';

/**
 * A real, decodable PNG of a chosen size, built rather than committed.
 *
 * The board file tests need a photograph, not a token image. A one-pixel PNG
 * exercises none of what actually matters: an upload large enough to be
 * streamed, a body past the 4MB JSON cap that the file route deliberately sits
 * in front of, and bytes that have to survive a round trip through R2 intact.
 * Committing a multi-megabyte binary to test that would be worse than
 * generating one, so the pixels are noise and the deflate is stored rather than
 * compressed — the file is the size it claims to be.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** A truecolour PNG of `width` x `height` filled with non-repeating pixels. */
export function makeNoisePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  // compression, filter and interlace methods are all the only defined value.

  // Each scanline is prefixed with its filter byte; 0 means "no filter", which
  // keeps the generator honest about how many bytes it is producing.
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  let seed = 0x2545f491;
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width * 3; x += 1) {
      // xorshift: cheap, deterministic, and does not compress.
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      raw[row + 1 + x] = seed & 0xff;
    }
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    // Level 0 stores rather than compresses, so the file size is predictable
    // and the test can state what it is uploading.
    chunk('IDAT', deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
