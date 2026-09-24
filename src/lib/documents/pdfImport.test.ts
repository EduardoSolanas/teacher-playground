import { describe, expect, it } from 'vitest';
import {
  MAX_PAGES_PER_IMPORT,
  MAX_PDF_BYTES,
  PAGE_GAP,
  classifyPdfError,
  defaultPageRange,
  failureMessage,
  PAGE_FRAME_COLOR,
  pageEncodingFor,
  pageFrame,
  parsePageRange,
  rasterScale,
  stackedPageRect,
} from './pdfImport';

describe('pinned limits', () => {
  it('uses the specified literal values', () => {
    expect(MAX_PDF_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_PAGES_PER_IMPORT).toBe(50);
    expect(PAGE_GAP).toBe(40);
  });
});

describe('defaultPageRange', () => {
  it('names the single page of a one-page document', () => {
    expect(defaultPageRange(1)).toBe('1');
  });

  it('covers every page up to the import cap', () => {
    expect(defaultPageRange(12)).toBe('1-12');
    expect(defaultPageRange(50)).toBe('1-50');
  });

  it('stops at the import cap for a longer document', () => {
    expect(defaultPageRange(51)).toBe('1-50');
    expect(defaultPageRange(300)).toBe('1-50');
  });
});

describe('parsePageRange', () => {
  it('accepts single pages and ranges, returning ascending unique pages', () => {
    expect(parsePageRange('3, 1-2, 2', 10)).toEqual({ ok: true, pages: [1, 2, 3] });
  });

  it('tolerates spaces around the dash and trailing commas', () => {
    expect(parsePageRange(' 4 - 6 ,', 10)).toEqual({ ok: true, pages: [4, 5, 6] });
  });

  it('accepts the last page and a range ending on it', () => {
    expect(parsePageRange('10', 10)).toEqual({ ok: true, pages: [10] });
    expect(parsePageRange('9-10', 10)).toEqual({ ok: true, pages: [9, 10] });
  });

  it('refuses an empty choice', () => {
    expect(parsePageRange('  ', 10)).toEqual({ ok: false, message: 'Choose at least one page.' });
    expect(parsePageRange(',', 10)).toEqual({ ok: false, message: 'Choose at least one page.' });
  });

  it('refuses text that is not pages or ranges', () => {
    const refused = { ok: false, message: 'Use page numbers like 1-3, 5.' };
    expect(parsePageRange('abc', 10)).toEqual(refused);
    expect(parsePageRange('1-', 10)).toEqual(refused);
    expect(parsePageRange('1.5', 10)).toEqual(refused);
    expect(parsePageRange('-2', 10)).toEqual(refused);
    expect(parsePageRange('1-2-3', 10)).toEqual(refused);
  });

  it('refuses page zero and pages past the end', () => {
    expect(parsePageRange('0', 10)).toEqual({ ok: false, message: 'This PDF has pages 1 to 10.' });
    expect(parsePageRange('11', 10)).toEqual({ ok: false, message: 'This PDF has pages 1 to 10.' });
    expect(parsePageRange('8-11', 10)).toEqual({ ok: false, message: 'This PDF has pages 1 to 10.' });
  });

  it('refuses a backwards range', () => {
    expect(parsePageRange('5-3', 10)).toEqual({ ok: false, message: 'Write ranges low to high, like 3-5.' });
  });

  it('accepts exactly the import cap and refuses one more', () => {
    expect(parsePageRange('1-50', 100)).toEqual({
      ok: true,
      pages: Array.from({ length: 50 }, (_, index) => index + 1),
    });
    expect(parsePageRange('1-51', 100)).toEqual({
      ok: false,
      message: 'Insert at most 50 pages at a time.',
    });
  });
});

describe('rasterScale', () => {
  it('scales a US Letter page so its longest side is 2000 px', () => {
    expect(rasterScale(612, 792)).toBeCloseTo(2000 / 792, 10);
  });

  it('never upscales a tiny page beyond 3x', () => {
    expect(rasterScale(100, 100)).toBe(3);
  });

  it('holds a square page at exactly the side limit', () => {
    expect(rasterScale(2000, 2000)).toBe(1);
  });

  it('shrinks a page larger than the side limit', () => {
    expect(rasterScale(4000, 500)).toBe(0.5);
  });
});

describe('pageFrame', () => {
  it('draws a hairline about one page unit wide, inset so none of it is clipped', () => {
    // 2000 px for a 792-unit page is ~2.5 px per unit: a 3 px line.
    expect(pageFrame(1545, 2000, 2000 / 792)).toEqual({ x: 1.5, y: 1.5, width: 1542, height: 1997, lineWidth: 3 });
  });

  it('never draws thinner than 2 px, so a small page still shows its edge', () => {
    expect(pageFrame(300, 300, 1)).toEqual({ x: 1, y: 1, width: 298, height: 298, lineWidth: 2 });
  });

  it('uses the slate hairline colour of the rest of the room', () => {
    expect(PAGE_FRAME_COLOR).toBe('#cbd5e1');
  });
});

describe('pageEncodingFor', () => {
  it('keeps WebP when the canvas actually produced WebP', () => {
    expect(pageEncodingFor('image/webp')).toBe('image/webp');
  });

  it('falls back to JPEG when the canvas ignored the WebP request', () => {
    expect(pageEncodingFor('image/png')).toBe('image/jpeg');
    expect(pageEncodingFor('')).toBe('image/jpeg');
  });
});

describe('stackedPageRect', () => {
  const firstPageRect = { x: 100, y: 200, width: 612, height: 792 };

  it('keeps a page of the same size and aspect ratio exactly where the first page is', () => {
    expect(stackedPageRect({ width: 612, height: 792 }, firstPageRect)).toEqual(firstPageRect);
  });

  it('shrinks a taller-aspect page to fit the height, centring it horizontally', () => {
    // A 612x1000 page is narrower for its height than the 612x792 slot, so
    // height is the binding dimension: scale = 792/1000 = 0.792.
    const rect = stackedPageRect({ width: 612, height: 1000 }, firstPageRect);
    expect(rect.height).toBeCloseTo(792, 10);
    expect(rect.width).toBeCloseTo(612 * 0.792, 10);
    expect(rect.y).toBeCloseTo(200, 10);
    expect(rect.x).toBeCloseTo(100 + (612 - rect.width) / 2, 10);
  });

  it('shrinks a wider-aspect (landscape) page to fit the width, centring it vertically', () => {
    // An 842x595 landscape page inside a 612x792 slot: scale = 612/842.
    const rect = stackedPageRect({ width: 842, height: 595 }, firstPageRect);
    const scale = 612 / 842;
    expect(rect.width).toBeCloseTo(612, 10);
    expect(rect.height).toBeCloseTo(595 * scale, 10);
    expect(rect.x).toBeCloseTo(100, 10);
    expect(rect.y).toBeCloseTo(200 + (792 - rect.height) / 2, 10);
  });

  it('keeps the aspect ratio of the fitted page', () => {
    const rect = stackedPageRect({ width: 300, height: 900 }, firstPageRect);
    expect(rect.width / rect.height).toBeCloseTo(300 / 900, 10);
  });
});

describe('classifyPdfError', () => {
  it('recognises the PDF.js exceptions by name', () => {
    expect(classifyPdfError({ name: 'PasswordException' })).toEqual({ kind: 'password' });
    expect(classifyPdfError({ name: 'InvalidPDFException' })).toEqual({ kind: 'invalid' });
  });

  it('treats anything else as an unreadable file', () => {
    expect(classifyPdfError(new Error('boom'))).toEqual({ kind: 'invalid' });
    expect(classifyPdfError(null)).toEqual({ kind: 'invalid' });
    expect(classifyPdfError(undefined)).toEqual({ kind: 'invalid' });
    expect(classifyPdfError('PasswordException')).toEqual({ kind: 'invalid' });
  });
});

describe('failureMessage', () => {
  it('gives each failure its plain message', () => {
    expect(failureMessage({ kind: 'invalid' })).toBe("This file isn't a PDF we can open.");
    expect(failureMessage({ kind: 'password' }))
      .toBe('This PDF is password protected. Remove the password and try again.');
    expect(failureMessage({ kind: 'too-large' })).toBe('This PDF is larger than 50 MB.');
    expect(failureMessage({ kind: 'page', page: 7 })).toBe("Page 7 couldn't be rendered.");
  });
});
