import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_USER_COLOR,
  USER_COLORS,
  USER_COLOR_STORAGE_KEY,
  generateUserColor,
  resolveUserColor,
} from './userColor';

describe('generateUserColor', () => {
  beforeEach(() => localStorage.clear());

  it('gives the same name the same colour every time', () => {
    expect(generateUserColor('Alice Smith')).toBe(generateUserColor('Alice Smith'));
  });

  it('gives different names different colours', () => {
    /*
     * The point of the palette. Every peer announced the same blue before this
     * existed, because the colour was a hard-coded constant that nothing ever
     * reassigned -- so every cursor and every tile in a room looked alike.
     */
    const names = ['Alice', 'Bob', 'Carla', 'Dev', 'Eve'];
    const colours = new Set(names.map(generateUserColor));
    expect(colours.size).toBeGreaterThan(1);
  });

  it('only ever returns a colour from the palette', () => {
    for (const name of ['a', 'zz', 'Very Long Name Indeed', '123']) {
      expect(USER_COLORS).toContain(generateUserColor(name));
    }
  });
});

describe('resolveUserColor', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('prefers what this browser stored, so a rename keeps the colour', () => {
    localStorage.setItem(USER_COLOR_STORAGE_KEY, '#123456');
    expect(resolveUserColor('Alice')).toBe('#123456');
  });

  it('derives one from the name when nothing is stored', () => {
    expect(resolveUserColor('Alice')).toBe(generateUserColor('Alice'));
  });

  it('falls back to the default when there is no name either', () => {
    expect(resolveUserColor('')).toBe(DEFAULT_USER_COLOR);
  });
});
