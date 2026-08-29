import { describe, expect, it } from 'vitest';
import {
  computeTargetDimensions,
  shouldConvertToWebP,
  chooseEncoding,
  downscaleImage,
} from './imageDownscale';

describe('computeTargetDimensions', () => {
  it('caps the long edge at 2048px for landscape images', () => {
    const [width, height] = computeTargetDimensions(4000, 3000, 2048);
    expect(width).toBe(2048);
    expect(height).toBe(1536);
    // Verify aspect ratio is preserved: width / height should match original.
    expect(width / height).toBeCloseTo(4000 / 3000, 5);
  });

  it('caps the long edge at 2048px for portrait images', () => {
    const [width, height] = computeTargetDimensions(3000, 4000, 2048);
    expect(width).toBe(1536);
    expect(height).toBe(2048);
    // Verify aspect ratio is preserved.
    expect(width / height).toBeCloseTo(3000 / 4000, 5);
  });

  it('leaves square images unchanged if already within limit', () => {
    const [width, height] = computeTargetDimensions(2048, 2048, 2048);
    expect(width).toBe(2048);
    expect(height).toBe(2048);
  });

  it('does not upscale small images', () => {
    const [width, height] = computeTargetDimensions(800, 600, 2048);
    expect(width).toBe(800);
    expect(height).toBe(600);
  });

  it('scales image exactly at the limit with 1:1 aspect ratio', () => {
    const [width, height] = computeTargetDimensions(2048, 2048, 2048);
    expect(width).toBe(2048);
    expect(height).toBe(2048);
  });

  it('handles very large images (phone photos)', () => {
    // A typical phone photo: 4032 x 3024.
    const [width, height] = computeTargetDimensions(4032, 3024, 2048);
    expect(width).toBe(2048);
    expect(height).toBeLessThanOrEqual(2048);
    // Verify aspect ratio.
    expect(width / height).toBeCloseTo(4032 / 3024, 5);
  });

  it('preserves aspect ratio for portrait phone photos', () => {
    // Portrait orientation: 3024 x 4032.
    const [width, height] = computeTargetDimensions(3024, 4032, 2048);
    expect(width).toBeLessThanOrEqual(2048);
    expect(height).toBe(2048);
    // Verify aspect ratio.
    expect(width / height).toBeCloseTo(3024 / 4032, 5);
  });

  it('rounds dimensions to integers', () => {
    const [width, height] = computeTargetDimensions(1234, 5678, 2048);
    expect(Number.isInteger(width)).toBe(true);
    expect(Number.isInteger(height)).toBe(true);
  });

  it('never upscales a 640x480 image to 2048x1536', () => {
    const [width, height] = computeTargetDimensions(640, 480, 2048);
    expect(width).toBe(640);
    expect(height).toBe(480);
  });
});

describe('shouldConvertToWebP', () => {
  it('converts PNG images', () => {
    expect(shouldConvertToWebP('image/png')).toBe(true);
  });

  it('converts JPEG images', () => {
    expect(shouldConvertToWebP('image/jpeg')).toBe(true);
  });

  it('converts WebP images (for consistent re-encoding)', () => {
    expect(shouldConvertToWebP('image/webp')).toBe(true);
  });

  it('skips GIF images to preserve animation', () => {
    expect(shouldConvertToWebP('image/gif')).toBe(false);
  });

  it('rejects other image types', () => {
    expect(shouldConvertToWebP('image/svg+xml')).toBe(false);
    expect(shouldConvertToWebP('image/tiff')).toBe(false);
    expect(shouldConvertToWebP('image/bmp')).toBe(false);
  });

  it('rejects non-image MIME types', () => {
    expect(shouldConvertToWebP('text/plain')).toBe(false);
    expect(shouldConvertToWebP('application/pdf')).toBe(false);
  });
});

describe('chooseEncoding', () => {
  const png = (size: number) => ({ bytes: new Uint8Array(size), mimeType: 'image/png' });

  it('takes the WebP when it came out smaller', () => {
    const converted = new Uint8Array(3);
    expect(chooseEncoding(png(8), converted)).toEqual({ bytes: converted, mimeType: 'image/webp' });
  });

  it('keeps the original bytes when the re-encode grew', () => {
    const original = png(100);
    expect(chooseEncoding(original, new Uint8Array(1_000_000))).toBe(original);
  });

  /*
   * The bug this exists to stop: a re-encode that grew kept the original PNG
   * bytes but still announced image/webp. R2 stores that content type on the
   * object, so every peer that downloaded the picture afterwards was told it
   * held a WebP and handed something else.
   */
  it('keeps the original MIME type with the original bytes', () => {
    const original = { bytes: new Uint8Array(100), mimeType: 'image/png' };
    expect(chooseEncoding(original, new Uint8Array(400)).mimeType).toBe('image/png');
  });

  it('breaks a tie towards WebP, so a board converges on one encoding', () => {
    const converted = new Uint8Array(3);
    expect(chooseEncoding(png(3), converted).mimeType).toBe('image/webp');
  });

  it('takes the WebP for a photograph, where the saving is the whole point', () => {
    const converted = new Uint8Array(300_000);
    const chosen = chooseEncoding({ bytes: new Uint8Array(5_000_000), mimeType: 'image/jpeg' }, converted);
    expect(chosen).toEqual({ bytes: converted, mimeType: 'image/webp' });
  });
});

describe('downscaleImage', () => {
  it('skips GIF images (returns original bytes and mime type)', async () => {
    // Use a minimal valid GIF.
    const gifBytes = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
      0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
      0xff, 0xff, 0xff, 0x00, 0x00, 0x00,
      0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
    ]);

    const result = await downscaleImage(gifBytes, 'image/gif');
    expect(result.bytes).toBe(gifBytes);
    expect(result.mimeType).toBe('image/gif');
  });

  it('returns original bytes when OffscreenCanvas is not available (jsdom)', async () => {
    // jsdom does not have OffscreenCanvas, so this tests graceful fallback.
    // We use a valid PNG (1x1 pixel).
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
      0x54, 0x08, 0x99, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x7b, 0xfb, 0xd3,
      0xcc, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    const result = await downscaleImage(pngBytes, 'image/png');
    // In jsdom, OffscreenCanvas is undefined, so we get the original back.
    expect(result.bytes).toBe(pngBytes);
    expect(result.mimeType).toBe('image/png');
  });

  it('returns original bytes unchanged on decode failure', async () => {
    // Corrupt data that is not a valid image.
    const corruptBytes = new Uint8Array([0xff, 0xd8, 0xff]); // Invalid JPEG fragment

    const result = await downscaleImage(corruptBytes, 'image/jpeg');
    expect(result.bytes).toBe(corruptBytes);
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('returns original mime type for GIF even with WebP conversion present', async () => {
    // A GIF header.
    const gifBytes = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
      0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
      0xff, 0xff, 0xff, 0x00, 0x00, 0x00,
      0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
    ]);

    const result = await downscaleImage(gifBytes, 'image/gif');
    // MIME type must stay GIF; we never convert.
    expect(result.mimeType).toBe('image/gif');
  });

  it('never throws, even on unexpected errors', async () => {
    // Test with an empty byte array.
    const empty = new Uint8Array([]);

    let threwError = false;
    try {
      await downscaleImage(empty, 'image/png');
    } catch {
      threwError = true;
    }

    expect(threwError).toBe(false);
  });

  it('preserves byte identity for GIFs', async () => {
    const gifBytes = new Uint8Array([0x47, 0x49, 0x46]);
    const result = await downscaleImage(gifBytes, 'image/gif');
    // Ensure it is the same Uint8Array object, not a copy.
    expect(result.bytes).toBe(gifBytes);
  });
});
