/**
 * Downscaling and re-encoding images to WebP format for efficient storage.
 *
 * Pasted images (especially from mobile phones) can be very large — up to 12MB
 * for a single photograph. This module downscales them and converts to WebP,
 * drastically reducing storage and bandwidth while maintaining visual quality
 * for a whiteboard canvas.
 */

/**
 * Computes target dimensions for an image, given a maximum long-edge length.
 *
 * Preserves aspect ratio: an image is never stretched. If the image is already
 * smaller than the maximum, it is left unchanged — we never upscale.
 *
 * Returns [width, height] tuple.
 */
export function computeTargetDimensions(
  originalWidth: number,
  originalHeight: number,
  maxLongEdge: number = 2048,
): [number, number] {
  // Do not upscale: if both dimensions are already smaller than the limit,
  // leave them alone.
  if (originalWidth <= maxLongEdge && originalHeight <= maxLongEdge) {
    return [originalWidth, originalHeight];
  }

  // Determine which edge is longer and compute the scale factor.
  const longEdge = Math.max(originalWidth, originalHeight);
  const scale = maxLongEdge / longEdge;

  // Apply scale to both dimensions, maintaining aspect ratio.
  const targetWidth = Math.round(originalWidth * scale);
  const targetHeight = Math.round(originalHeight * scale);

  return [targetWidth, targetHeight];
}

/**
 * Decides whether a MIME type should be converted to WebP.
 *
 * GIFs are skipped: a canvas can only render the first frame, so re-encoding
 * silently destroys animation. PNG and JPEG are converted for compression.
 * WebP is also converted to ensure consistent, optimal encoding.
 */
export function shouldConvertToWebP(mimeType: string): boolean {
  // GIF must pass through untouched: converting loses all but the first frame.
  if (mimeType === 'image/gif') return false;

  // Convert PNG, JPEG, and WebP.
  return ['image/png', 'image/jpeg', 'image/webp'].includes(mimeType);
}

/**
 * Chooses between the original encoding and the WebP re-encode.
 *
 * Re-encoding does not always win: an already-optimised screenshot or a small
 * flat-colour PNG can come out larger as WebP, and uploading the bigger file
 * would be worse than doing nothing at all.
 *
 * The bytes and the MIME type are decided together on purpose. Returning only
 * the bytes let the two drift apart -- keeping the original PNG while still
 * announcing `image/webp` -- and that lie is stored in R2 as the object's
 * content type and handed to every peer that downloads it afterwards.
 *
 * A tie goes to WebP: same size, and the board converges on one encoding.
 */
export function chooseEncoding(
  original: { bytes: Uint8Array; mimeType: string },
  convertedBytes: Uint8Array,
): { bytes: Uint8Array; mimeType: string } {
  if (convertedBytes.length <= original.bytes.length) {
    return { bytes: convertedBytes, mimeType: 'image/webp' };
  }
  return original;
}

/**
 * Downscales and re-encodes an image to WebP format.
 *
 * Uses createImageBitmap and OffscreenCanvas to decode the image and
 * re-encode as WebP at quality 0.82 for a good balance between size and
 * visual fidelity.
 *
 * On any failure (unsupported codec, missing encoder, decode error, etc.),
 * returns the original bytes and MIME type unchanged — a picture that
 * cannot be converted must still upload. Never throws.
 *
 * In environments without OffscreenCanvas (e.g., jsdom), returns the
 * original bytes unchanged, which is safe: the server still receives the
 * file and peers can download it, just not downscaled.
 */
export async function downscaleImage(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  // Skip GIFs: they would lose animation.
  if (!shouldConvertToWebP(mimeType)) {
    return { bytes, mimeType };
  }

  // Graceful fallback for environments without canvas support (jsdom, etc.).
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return { bytes, mimeType };
  }

  try {
    // Decode the image bytes into a bitmap.
    const blob = new Blob([bytes] as BlobPart[], { type: mimeType });
    const bitmap = await createImageBitmap(blob);

    // Compute target dimensions to avoid upscaling.
    const [targetWidth, targetHeight] = computeTargetDimensions(
      bitmap.width,
      bitmap.height,
    );

    // Draw the bitmap onto an offscreen canvas at the target size.
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { bytes, mimeType };

    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    // Encode to WebP at quality 0.82 for good compression without visible
    // quality loss on a whiteboard canvas.
    const encodedBlob = await canvas.convertToBlob({
      type: 'image/webp',
      quality: 0.82,
    });

    // Convert blob to bytes.
    const convertedBytes = new Uint8Array(await encodedBlob.arrayBuffer());

    // Keep whichever is smaller, and keep its own MIME type with it.
    return chooseEncoding({ bytes, mimeType }, convertedBytes);
  } catch {
    // On any error, return the original bytes unchanged.
    // The image will still upload; it just will not be downscaled.
    return { bytes, mimeType };
  }
}
