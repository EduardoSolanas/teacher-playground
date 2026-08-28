import { describe, expect, it } from 'vitest';

import {
  formatIncrementComparisonWarning,
  incrementSceneChange,
  isRemoteIncrement,
  publishCandidatesEqual,
} from './incrementSync';

const event = (changes: {
  added?: string[];
  removed?: string[];
  updated?: string[];
}) => ({
  elementsChange: {
    added: new Map((changes.added ?? []).map((id) => [id, {}])),
    removed: new Map((changes.removed ?? []).map((id) => [id, {}])),
    updated: new Map((changes.updated ?? []).map((id) => [id, {}])),
  },
});

describe('Excalidraw increment sync', () => {
  it('selects complete current elements for added and updated ids', () => {
    const elements = [
      { id: 'old', type: 'rectangle', version: 1 },
      { id: 'updated', type: 'rectangle', version: 2, x: 40 },
      { id: 'added', type: 'ellipse', version: 1 },
    ];

    expect(incrementSceneChange(event({ added: ['added'], updated: ['updated'] }), elements))
      .toEqual({
        elements: [elements[1], elements[2]],
        wholeScene: false,
      });
  });

  it('uses the whole current scene when an element was removed', () => {
    const elements = [
      { id: 'survivor', type: 'rectangle', version: 3 },
    ];

    expect(incrementSceneChange(event({ removed: ['deleted'] }), elements))
      .toEqual({ elements, wholeScene: true });
  });

  it('compares the exact payload shape and sweep mode', () => {
    expect(publishCandidatesEqual(
      { elements: [{ id: 'a', type: 'rectangle' }], wholeScene: false },
      { elements: [{ id: 'a', type: 'rectangle' }], wholeScene: false },
    )).toBe(true);
    expect(publishCandidatesEqual(
      { elements: [{ id: 'a', type: 'rectangle' }], wholeScene: false },
      { elements: [{ id: 'a', type: 'rectangle' }], wholeScene: true },
    )).toBe(false);
  });

  it('formats a redacted structured mismatch warning without scene contents', () => {
    const warning = formatIncrementComparisonWarning(
      { elements: [{ id: 'legacy', type: 'rectangle', text: 'private answer' }], wholeScene: false },
      { elements: [], wholeScene: false },
    );

    expect(warning).toContain('"event":"whiteboard_increment_mismatch"');
    expect(warning).toContain('"legacyCount":1');
    expect(warning).toContain('"incrementCount":0');
    expect(warning).not.toContain('private answer');
  });

  it('recognizes only the explicit remote increment source', () => {
    expect(isRemoteIncrement({ ...event({ added: ['remote'] }), source: 'remote' })).toBe(true);
    expect(isRemoteIncrement({ ...event({ added: ['local'] }), source: undefined })).toBe(false);
    expect(isRemoteIncrement({ ...event({ added: ['local'] }), source: 'api' })).toBe(false);
  });
});
