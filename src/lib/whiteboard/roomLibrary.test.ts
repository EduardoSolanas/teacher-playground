import { describe, expect, it } from 'vitest';

import {
  MAX_LIBRARY_BYTES,
  checkLibraryItems,
  libraryBytes,
  libraryStorageKey,
  parseLibraryItems,
  storedLibraryItems,
} from './roomLibrary';

const item = (id: string) => ({ id, status: 'published', elements: [], created: 1 });

describe('parseLibraryItems', () => {
  it('takes a list of items', () => {
    expect(parseLibraryItems({ items: [item('a'), item('b')] })).toHaveLength(2);
  });

  it('takes an empty library, which is how one is cleared', () => {
    // Removing the last shape must be storable, or a teacher can add to their
    // library and never empty it.
    expect(parseLibraryItems({ items: [] })).toEqual([]);
  });

  it('refuses anything that is not a list of objects', () => {
    expect(parseLibraryItems(null)).toBeNull();
    expect(parseLibraryItems({})).toBeNull();
    expect(parseLibraryItems({ items: 'shapes' })).toBeNull();
    expect(parseLibraryItems({ items: [null] })).toBeNull();
    expect(parseLibraryItems({ items: ['a string'] })).toBeNull();
    expect(parseLibraryItems({ items: [[]] })).toBeNull();
  });
});

describe('checkLibraryItems', () => {
  it('accepts a library that fits', () => {
    const result = checkLibraryItems({ items: [item('a')] });
    expect(result).toEqual({ ok: true, items: [item('a')] });
  });

  it('separates a malformed body from one that is merely too big', () => {
    /*
     * They want different answers. A body that is not a library is the
     * caller's mistake; a library too large is a teacher's shapes outgrowing
     * what a room holds, and they can only be told which if the two are told
     * apart here.
     */
    expect(checkLibraryItems({ items: 'nope' })).toEqual({ ok: false, reason: 'malformed' });

    const huge = [{ id: 'x', blob: 'y'.repeat(MAX_LIBRARY_BYTES) }];
    expect(checkLibraryItems({ items: huge })).toEqual({ ok: false, reason: 'too-large' });
  });

  it('measures the encoded size, not the character count', () => {
    // A shape named in a script that is not Latin costs more bytes than it has
    // characters, and it is bytes that the store refuses.
    const wide = [{ id: 'a', name: '数'.repeat(10) }];
    expect(libraryBytes(wide)).toBeGreaterThan(JSON.stringify(wide).length - 1);
    expect(libraryBytes([])).toBe(2);
  });
});

describe('storage', () => {
  it('keys a library to its room', () => {
    expect(libraryStorageKey('room-1')).toBe('library:room-1');
  });

  it('reads back an empty library rather than throwing on anything else', () => {
    // A key that holds something unexpected must open the board with no
    // shapes, not fail to open it.
    expect(storedLibraryItems([item('a')])).toHaveLength(1);
    expect(storedLibraryItems(undefined)).toEqual([]);
    expect(storedLibraryItems('corrupt')).toEqual([]);
    expect(storedLibraryItems({ items: [] })).toEqual([]);
  });
});
