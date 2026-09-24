/*
 * Mutation note (AGENTS.md): two survivors here are equivalent. `< 10` against
 * `<= 10` both render exactly ten megabytes as "10 MB", and removing the empty
 * payload check still returns 0, because floor(0 * 3 / 4) is 0.
 */
import { describe, expect, it } from 'vitest';
import { dataUrlBytes, formatMegabytes, freeBytes, importTooLargeMessage, storageLabel } from './roomStorage';

const MB = 1024 * 1024;

describe('formatMegabytes', () => {
  it('rounds a large figure to whole megabytes', () => {
    expect(formatMegabytes(250 * MB)).toBe('250 MB');
    expect(formatMegabytes(12.4 * MB)).toBe('12 MB');
  });

  it('keeps one decimal below ten megabytes, where whole numbers hide the difference', () => {
    expect(formatMegabytes(4.25 * MB)).toBe('4.3 MB');
    expect(formatMegabytes(0.5 * MB)).toBe('0.5 MB');
  });

  it('starts saying a figure exactly at the twentieth of a megabyte', () => {
    expect(formatMegabytes(0.05 * MB)).toBe('0.1 MB');
    expect(formatMegabytes(0.05 * MB - 1)).toBe('under 0.1 MB');
  });

  it('never says a file with bytes in it is nothing at all', () => {
    expect(formatMegabytes(1)).toBe('under 0.1 MB');
    expect(formatMegabytes(0)).toBe('0 MB');
  });
});

describe('freeBytes', () => {
  it('is what is left of the cap', () => {
    expect(freeBytes(10 * MB, 250 * MB)).toBe(240 * MB);
  });

  it('is nothing rather than a negative number when the room is over the cap', () => {
    expect(freeBytes(260 * MB, 250 * MB)).toBe(0);
  });
});

describe('storageLabel', () => {
  it('says what the room holds against what it may hold', () => {
    expect(storageLabel(12 * MB, 250 * MB)).toBe('12 MB of 250 MB used');
  });
});

describe('importTooLargeMessage', () => {
  it('says nothing when the pages fit', () => {
    expect(importTooLargeMessage(5 * MB, 10 * MB, 250 * MB)).toBeNull();
  });

  it('lets an import that exactly fills the room through', () => {
    expect(importTooLargeMessage(240 * MB, 10 * MB, 250 * MB)).toBeNull();
  });

  it('says what is needed and what is free when it does not fit', () => {
    expect(importTooLargeMessage(18 * MB, 246 * MB, 250 * MB)).toBe(
      'These pages need about 18 MB, but only 4 MB is free in this room. Delete some pictures or use fewer pages.',
    );
  });

  it('refuses by one byte, because the upload would too', () => {
    expect(importTooLargeMessage(4 * MB + 1, 246 * MB, 250 * MB)).not.toBeNull();
  });
});

describe('dataUrlBytes', () => {
  it('measures the encoded bytes a page will upload, not the string length', () => {
    // "hello" is 5 bytes; base64 is 8 characters of it.
    expect(dataUrlBytes('data:image/webp;base64,aGVsbG8=')).toBe(5);
    expect(dataUrlBytes('data:image/jpeg;base64,aGVsbG9faGk=')).toBe(8);
  });

  it('accounts for each length of base64 padding', () => {
    // 1 byte -> "AA==", 2 bytes -> "AAE=", 3 bytes -> "AAEC" with no padding.
    expect(dataUrlBytes('data:image/webp;base64,AA==')).toBe(1);
    expect(dataUrlBytes('data:image/webp;base64,AAE=')).toBe(2);
    expect(dataUrlBytes('data:image/webp;base64,AAEC')).toBe(3);
  });

  it('counts nothing for a data URL with no payload', () => {
    expect(dataUrlBytes('data:image/webp;base64,')).toBe(0);
  });

  it('counts nothing for something that is not a base64 data URL', () => {
    expect(dataUrlBytes('https://example.test/page.webp')).toBe(0);
    expect(dataUrlBytes('')).toBe(0);
  });

  it('needs the comma as well as the marker', () => {
    // A header-looking string with no payload separator is not a data URL.
    expect(dataUrlBytes('data:image/webp;base64ZZZZ')).toBe(0);
  });

  it('reads the marker in the header, not anywhere in the payload', () => {
    // A plain-text data URL whose own text contains ";base64" is still not one.
    expect(dataUrlBytes('data:text/plain,;base64 is written here')).toBe(0);
    expect(dataUrlBytes('data:text/plain,hello')).toBe(0);
  });
});
