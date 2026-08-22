import { describe, it, expect } from 'vitest';
import { DO_VALUE_LIMIT_BYTES, SNAPSHOT_WARN_BYTES, snapshotBudgetState } from './snapshotBudget';

describe('snapshotBudgetState', () => {
  it('calls an ordinary board fine', () => {
    // ~44KB measured, against a SQLite-backed ceiling of 2MB.
    expect(snapshotBudgetState(44_000)).toBe('fine');
    expect(snapshotBudgetState(131_072)).toBe('fine');
  });

  it('warns before the limit, while the write still succeeds', () => {
    expect(snapshotBudgetState(SNAPSHOT_WARN_BYTES)).toBe('approaching');
    expect(snapshotBudgetState(DO_VALUE_LIMIT_BYTES - 1)).toBe('approaching');
  });

  it('calls a board at or over the storage limit unwritable', () => {
    expect(snapshotBudgetState(DO_VALUE_LIMIT_BYTES)).toBe('over');
    expect(snapshotBudgetState(DO_VALUE_LIMIT_BYTES + 1)).toBe('over');
  });

  it('leaves headroom between the warning and the limit', () => {
    expect(SNAPSHOT_WARN_BYTES).toBeLessThan(DO_VALUE_LIMIT_BYTES);
  });
});
