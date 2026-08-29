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

/**
 * A photograph-like truecolour PNG of `width` x `height`.
 *
 * `makeNoisePng` is the wrong instrument for measuring what downscaling saves,
 * in both directions. Its pixels are xorshift noise stored uncompressed, so
 * nothing about it behaves like a camera file: noise is the one input a lossy
 * encoder cannot win on, and at 1300px it does not even reach the 2048px cap
 * that triggers the resize. It stays in the suite because the tests that use it
 * care about size and integrity, not about compressibility.
 *
 * The opposite mistake is just as misleading, and this generator was written
 * into it once already: a smooth gradient with a whisper of grain compresses to
 * almost nothing and reports a saving no real photograph will ever match. What
 * makes a camera file big is high-frequency detail -- foliage, fabric, skin,
 * sensor grain -- so the texture here is deliberately strong enough to dominate
 * the gradient underneath it.
 *
 * It is still an approximation: no synthetic image has the edges and structure
 * of a real photograph. It errs towards being harder to compress than the truth
 * rather than easier, so a ratio measured against it is a conservative claim
 * about what a real photograph would do.
 */
export function makePhotoPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  // compression, filter and interlace methods are all the only defined value.

  let seed = 0x2545f491;
  const nextRandom = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };

  /*
   * Value noise rather than per-pixel randomness, at three scales.
   *
   * The distinction is the whole reason this generator exists. Per-pixel grain
   * is expensive for PNG to store and the first thing a lossy encoder throws
   * away, so an image made of it reports a saving that is really just the
   * encoder deleting the fixture. Detail that is smooth between neighbours --
   * a lattice of random values interpolated across it -- costs PNG about what a
   * photograph costs and still has something left after quantisation, which is
   * what makes the measured ratio mean anything.
   */
  const lattice = (cell: number) => {
    const cols = Math.ceil(width / cell) + 2;
    const values = new Float32Array(cols * (Math.ceil(height / cell) + 2));
    for (let i = 0; i < values.length; i += 1) values[i] = nextRandom();
    return { values, cols, cell };
  };
  const octaves = [lattice(64), lattice(16), lattice(4)];
  const weights = [0.55, 0.3, 0.15];

  // Smoothstep, so the lattice does not show through as visible diamonds.
  const ease = (t: number) => t * t * (3 - 2 * t);

  const sample = (octave: { values: Float32Array; cols: number; cell: number }, x: number, y: number) => {
    const fx = x / octave.cell;
    const fy = y / octave.cell;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = ease(fx - x0);
    const ty = ease(fy - y0);
    const top = octave.values[y0 * octave.cols + x0] * (1 - tx)
      + octave.values[y0 * octave.cols + x0 + 1] * tx;
    const bottom = octave.values[(y0 + 1) * octave.cols + x0] * (1 - tx)
      + octave.values[(y0 + 1) * octave.cols + x0 + 1] * tx;
    return top * (1 - ty) + bottom * ty;
  };

  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  const clamp = (value: number) => Math.min(255, Math.max(0, Math.floor(value))) & 0xff;

  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter byte: 0 = no filter

    for (let x = 0; x < width; x += 1) {
      // A gradient underneath, for the large-scale structure every photograph
      // has, with the detail carrying most of the weight above it.
      const base = ((x / width) + (y / height)) * 0.5;
      let detail = 0;
      for (let o = 0; o < octaves.length; o += 1) detail += sample(octaves[o], x, y) * weights[o];
      const value = base * 0.35 + detail * 0.65;

      // Slightly different curves per channel: a grey image is not a photograph
      // and compresses better than one.
      raw[row + 1 + x * 3] = clamp(value * 255);
      raw[row + 1 + x * 3 + 1] = clamp(value * 245 + 8);
      raw[row + 1 + x * 3 + 2] = clamp(value * 230 + 16);
    }
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    // Level 6, as an ordinary encoder would: the fixture should be as big as
    // its content genuinely is, not inflated by refusing to compress it.
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
