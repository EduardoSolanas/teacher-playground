import { describe, expect, it } from 'vitest';
import { shouldClearUsernameOnEviction } from './evictionUi';

describe('shouldClearUsernameOnEviction', () => {
  it('clears the prompt after kick or reject, but not after suspend-to-waiting', () => {
    expect(shouldClearUsernameOnEviction({
      wasKicked: true,
      wasRejected: false,
      wasSuspended: false,
    })).toBe(true);
    expect(shouldClearUsernameOnEviction({
      wasKicked: false,
      wasRejected: true,
      wasSuspended: false,
    })).toBe(true);
    expect(shouldClearUsernameOnEviction({
      wasKicked: false,
      wasRejected: false,
      wasSuspended: true,
    })).toBe(false);
  });
});
