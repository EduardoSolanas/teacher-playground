import { describe, it, expect } from 'vitest';
import { canSaveLibrary } from './libraryGuard';

describe('canSaveLibrary', () => {
  it('returns false for pending state', () => {
    expect(canSaveLibrary('pending')).toBe(false);
  });

  it('returns true for loaded state', () => {
    expect(canSaveLibrary('loaded')).toBe(true);
  });

  it('returns false for failed state', () => {
    expect(canSaveLibrary('failed')).toBe(false);
  });
});
