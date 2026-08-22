import { describe, expect, it } from 'vitest';

import { shouldPersistBoard } from './persistOwnership';

describe('shouldPersistBoard', () => {
  it('has the host write the board', () => {
    expect(shouldPersistBoard({ isHost: true, hostPresent: true })).toBe(true);
  });

  it('keeps a peer from writing while the host is here', () => {
    // The duplication is not the worst of it: two peers can hold different
    // views for a moment, and the loser of the race stores the older one.
    expect(shouldPersistBoard({ isHost: false, hostPresent: true })).toBe(false);
  });

  it('lets a peer take over when no host is present', () => {
    // A teacher's tab closing mid-lesson must not leave the student drawing
    // into nothing.
    expect(shouldPersistBoard({ isHost: false, hostPresent: false })).toBe(true);
  });

  it('never leaves a board with nobody to save it', () => {
    for (const isHost of [true, false]) {
      for (const hostPresent of [true, false]) {
        const someoneWrites = shouldPersistBoard({ isHost, hostPresent })
          || (hostPresent && !isHost);
        expect(someoneWrites).toBe(true);
      }
    }
  });
});
