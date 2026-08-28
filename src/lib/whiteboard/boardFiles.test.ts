import { describe, expect, it } from 'vitest';
import {
  dataURLToBytes,
  bytesToDataURL,
  filesToUpload,
  isAllowedMimeType,
} from './boardFiles';

describe('dataURLToBytes', () => {
  it('converts a data URL with PNG base64 to bytes and mime type', () => {
    // data:image/png;base64,iVBORw0KGgo...
    const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const result = dataURLToBytes(pngDataUrl);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe('image/png');
    expect(result?.bytes).toBeInstanceOf(Uint8Array);
    expect(result?.bytes.length).toBeGreaterThan(0);
  });

  it('converts a data URL with JPEG base64 to bytes and mime type', () => {
    const jpegDataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/';
    const result = dataURLToBytes(jpegDataUrl);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe('image/jpeg');
    expect(result?.bytes).toBeInstanceOf(Uint8Array);
  });

  it('converts a data URL with WebP base64 to bytes and mime type', () => {
    const webpDataUrl = 'data:image/webp;base64,UklGRiYAAABXRUJQVlA4IBIAAAAwAQCdASoBAAEAAUAcJaQCdLoB/gAA/v8AP/7+/v//';
    const result = dataURLToBytes(webpDataUrl);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe('image/webp');
    expect(result?.bytes).toBeInstanceOf(Uint8Array);
  });

  it('converts a data URL with GIF base64 to bytes and mime type', () => {
    const gifDataUrl = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const result = dataURLToBytes(gifDataUrl);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe('image/gif');
    expect(result?.bytes).toBeInstanceOf(Uint8Array);
  });

  it('returns null for malformed data URLs', () => {
    expect(dataURLToBytes('not-a-data-url')).toBeNull();
    expect(dataURLToBytes('')).toBeNull();
    expect(dataURLToBytes('data:text/plain;base64,hello')).toBeNull();
  });

  it('returns null for data URLs without base64 encoding', () => {
    expect(dataURLToBytes('data:image/png,somedata')).toBeNull();
  });

  it('returns null for invalid base64', () => {
    expect(dataURLToBytes('data:image/png;base64,not!valid@base64$')).toBeNull();
  });
});

describe('bytesToDataURL', () => {
  it('converts bytes and mime type to a valid data URL', () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG signature
    const result = bytesToDataURL(bytes, 'image/png');
    expect(result).toMatch(/^data:image\/png;base64,/);
    expect(result).toContain('iVBORw0KGgo');
  });

  it('converts JPEG bytes to a data URL', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG SOI
    const result = bytesToDataURL(bytes, 'image/jpeg');
    expect(result).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('handles empty bytes', () => {
    const bytes = new Uint8Array([]);
    const result = bytesToDataURL(bytes, 'image/png');
    expect(result).toBe('data:image/png;base64,');
  });
});

describe('dataURLToBytes and bytesToDataURL roundtrip', () => {
  it('preserves data through conversion cycle', () => {
    const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const bytes = dataURLToBytes(pngDataUrl);
    expect(bytes).not.toBeNull();
    if (!bytes) return;
    const dataUrl = bytesToDataURL(bytes.bytes, bytes.mimeType);
    expect(dataUrl).toBe(pngDataUrl);
  });
});

describe('isAllowedMimeType', () => {
  it('allows PNG images', () => {
    expect(isAllowedMimeType('image/png')).toBe(true);
  });

  it('allows JPEG images', () => {
    expect(isAllowedMimeType('image/jpeg')).toBe(true);
  });

  it('allows WebP images', () => {
    expect(isAllowedMimeType('image/webp')).toBe(true);
  });

  it('allows GIF images', () => {
    expect(isAllowedMimeType('image/gif')).toBe(true);
  });

  it('rejects text mime types', () => {
    expect(isAllowedMimeType('text/plain')).toBe(false);
    expect(isAllowedMimeType('text/html')).toBe(false);
  });

  it('rejects other image types', () => {
    expect(isAllowedMimeType('image/svg+xml')).toBe(false);
    expect(isAllowedMimeType('image/tiff')).toBe(false);
  });

  it('rejects empty or malformed types', () => {
    expect(isAllowedMimeType('')).toBe(false);
    expect(isAllowedMimeType('image/')).toBe(false);
    expect(isAllowedMimeType('/')).toBe(false);
  });
});

describe('filesToUpload', () => {
  it('returns fileIds that are in the files map but not in the uploadedSet', () => {
    const files: Record<string, { id: string; mimeType: string; dataURL: string; created: number }> = {
      'file-1': {
        id: 'file-1',
        mimeType: 'image/png',
        dataURL: 'data:image/png;base64,iVBORw0KGgo=',
        created: Date.now(),
      },
      'file-2': {
        id: 'file-2',
        mimeType: 'image/jpeg',
        dataURL: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD//',
        created: Date.now(),
      },
    };
    const uploaded = new Set<string>(['file-1']);

    const result = filesToUpload(files as any, uploaded);
    expect(result).toEqual(['file-2']);
  });

  it('returns empty array when all files are already uploaded', () => {
    const files: Record<string, { id: string; mimeType: string; dataURL: string; created: number }> = {
      'file-1': {
        id: 'file-1',
        mimeType: 'image/png',
        dataURL: 'data:image/png;base64,iVBORw0KGgo=',
        created: Date.now(),
      },
    };
    const uploaded = new Set<string>(['file-1']);

    const result = filesToUpload(files as any, uploaded);
    expect(result).toEqual([]);
  });

  it('returns all fileIds when nothing is uploaded yet', () => {
    const files: Record<string, { id: string; mimeType: string; dataURL: string; created: number }> = {
      'file-1': {
        id: 'file-1',
        mimeType: 'image/png',
        dataURL: 'data:image/png;base64,iVBORw0KGgo=',
        created: Date.now(),
      },
      'file-2': {
        id: 'file-2',
        mimeType: 'image/jpeg',
        dataURL: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD//',
        created: Date.now(),
      },
      'file-3': {
        id: 'file-3',
        mimeType: 'image/webp',
        dataURL: 'data:image/webp;base64,UklGRiY=',
        created: Date.now(),
      },
    };
    const uploaded = new Set<string>();

    const result = filesToUpload(files as any, uploaded);
    expect(result).toHaveLength(3);
    expect(result).toContain('file-1');
    expect(result).toContain('file-2');
    expect(result).toContain('file-3');
  });

  it('returns empty array when files map is empty', () => {
    const files: Record<string, any> = {};
    const uploaded = new Set<string>(['file-1']);

    const result = filesToUpload(files, uploaded);
    expect(result).toEqual([]);
  });

  it('only returns fileIds (object keys from the files map)', () => {
    const files: Record<string, { id: string; mimeType: string; dataURL: string; created: number }> = {
      'alpha': {
        id: 'alpha',
        mimeType: 'image/png',
        dataURL: 'data:image/png;base64,iVBORw0KGgo=',
        created: Date.now(),
      },
      'beta': {
        id: 'beta',
        mimeType: 'image/jpeg',
        dataURL: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD//',
        created: Date.now(),
      },
    };
    const uploaded = new Set<string>();

    const result = filesToUpload(files as any, uploaded);
    expect(Array.isArray(result)).toBe(true);
    expect(result.every((id) => typeof id === 'string')).toBe(true);
  });
});

describe('boardFiles at real image sizes', () => {
  it('encodes an image too large to spread into an argument list', () => {
    /*
     * A photograph is megabytes, not bytes. Spreading one into
     * String.fromCharCode(...bytes) passes a million arguments to a function
     * call and overflows the stack, so the failure lands on exactly the images
     * this feature exists to carry -- and never on a small fixture.
     */
    const bytes = new Uint8Array(1_000_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

    const dataUrl = bytesToDataURL(bytes, 'image/png');
    const decoded = dataURLToBytes(dataUrl);

    expect(decoded).not.toBeNull();
    expect(decoded!.mimeType).toBe('image/png');
    expect(decoded!.bytes.length).toBe(bytes.length);
    expect(decoded!.bytes[0]).toBe(bytes[0]);
    expect(decoded!.bytes[999_999]).toBe(bytes[999_999]);
  });
});
