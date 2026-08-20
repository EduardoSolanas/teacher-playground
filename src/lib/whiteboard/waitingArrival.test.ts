import { describe, expect, it } from 'vitest';

import { shouldExpandForArrival } from './waitingArrival';

describe('shouldExpandForArrival', () => {
  it('opens the roster when the first student knocks', () => {
    expect(shouldExpandForArrival(0, 1)).toBe(true);
  });

  it('stays quiet while the queue is empty', () => {
    expect(shouldExpandForArrival(0, 0)).toBe(false);
  });

  it('stays quiet while the same student keeps waiting', () => {
    expect(shouldExpandForArrival(1, 1)).toBe(false);
  });

  it('does not reopen a panel the teacher closed when a second student joins', () => {
    // The teacher has already been shown the queue once and may have collapsed
    // it on purpose. A second arrival is not grounds to overrule that.
    expect(shouldExpandForArrival(1, 2)).toBe(false);
  });

  it('stays quiet as the queue drains', () => {
    expect(shouldExpandForArrival(2, 1)).toBe(false);
    expect(shouldExpandForArrival(1, 0)).toBe(false);
  });

  it('opens again for a fresh arrival after the queue emptied', () => {
    expect(shouldExpandForArrival(0, 1)).toBe(true);
  });
});
