/*
 * Mutation note (AGENTS.md): Stryker's `next.length > cap` -> `>=` and the
 * `true ? next.slice(...) : next` survivors on this file are equivalent.
 * At `next.length === cap`, `next.slice(next.length - cap)` is `slice(0)`,
 * which reproduces the same array content the untouched branch returns --
 * so no input can tell the two branches apart by their result.
 */
import { describe, expect, it } from 'vitest';
import { MAX_STORED_PAGE_ENTRIES, withPageEntry } from './pageState';
import type { PageMessage } from './pageMessage';

function entry(importId: string, index = 0): PageMessage {
  return { importId, index };
}

describe('withPageEntry', () => {
  it('appends a new key to an empty list', () => {
    expect(withPageEntry([], entry('0000000000000001', 3))).toEqual([
      { importId: '0000000000000001', index: 3 },
    ]);
  });

  it('appends a new key after existing ones, preserving their order', () => {
    const entries = [entry('0000000000000001'), entry('0000000000000002')];
    expect(withPageEntry(entries, entry('0000000000000003'))).toEqual([
      entry('0000000000000001'),
      entry('0000000000000002'),
      entry('0000000000000003'),
    ]);
  });

  it('moves a re-set key to the end and keeps its new value', () => {
    const entries = [entry('0000000000000001', 0), entry('0000000000000002', 0)];
    expect(withPageEntry(entries, entry('0000000000000001', 5))).toEqual([
      entry('0000000000000002', 0),
      entry('0000000000000001', 5),
    ]);
  });

  it('drops the oldest entry (insertion order) when a new key would exceed the cap', () => {
    const entries = [entry('0000000000000001'), entry('0000000000000002'), entry('0000000000000003')];
    expect(withPageEntry(entries, entry('0000000000000004'), 3)).toEqual([
      entry('0000000000000002'),
      entry('0000000000000003'),
      entry('0000000000000004'),
    ]);
  });

  it('re-setting an existing key at the cap does not drop anything else', () => {
    const entries = [entry('0000000000000001'), entry('0000000000000002'), entry('0000000000000003')];
    expect(withPageEntry(entries, entry('0000000000000001', 9), 3)).toEqual([
      entry('0000000000000002'),
      entry('0000000000000003'),
      entry('0000000000000001', 9),
    ]);
  });

  it('defaults the cap to the 200-entry spec limit', () => {
    expect(MAX_STORED_PAGE_ENTRIES).toBe(200);
    const entries = Array.from({ length: 200 }, (_, i) => entry(i.toString(16).padStart(16, '0')));
    const result = withPageEntry(entries, entry('ffffffffffffffff'));
    expect(result).toHaveLength(200);
    expect(result[0]).toEqual(entries[1]);
    expect(result[result.length - 1]).toEqual(entry('ffffffffffffffff'));
  });
});
