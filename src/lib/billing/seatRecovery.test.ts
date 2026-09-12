import { describe, expect, it } from 'vitest';
import {
  STRIPE_IDEMPOTENCY_WINDOW_MS,
  decideSeatChangeRecovery,
  seatChangeAttemptWithinWindow,
  seatChangeDriftAlert,
} from './seatRecovery';

const NOW = 1_700_000_000_000;

describe('seat-change 24-hour-window recovery (spec §3.2 step 4)', () => {
  it('treats a fetched target quantity as applied without a retry', () => {
    expect(
      decideSeatChangeRecovery({
        previousQuantity: 2,
        targetQuantity: 4,
        fetchedQuantity: 4,
        attemptedAt: NOW - STRIPE_IDEMPOTENCY_WINDOW_MS - 1,
        now: NOW,
      }),
    ).toEqual({ kind: 'settled' });
  });

  it('retries the previous quantity while inside the idempotency window', () => {
    expect(
      decideSeatChangeRecovery({
        previousQuantity: 2,
        targetQuantity: 4,
        fetchedQuantity: 2,
        attemptedAt: NOW - 1,
        now: NOW,
      }),
    ).toEqual({ kind: 'retry' });
  });

  it('releases the previous quantity after the idempotency window', () => {
    expect(
      decideSeatChangeRecovery({
        previousQuantity: 2,
        targetQuantity: 4,
        fetchedQuantity: 2,
        attemptedAt: NOW - STRIPE_IDEMPOTENCY_WINDOW_MS,
        now: NOW,
      }),
    ).toEqual({ kind: 'released' });
  });

  it('classifies any other fetched quantity as drift with the fetched value and an alert', () => {
    expect(
      decideSeatChangeRecovery({
        previousQuantity: 2,
        targetQuantity: 4,
        fetchedQuantity: 7,
        attemptedAt: NOW,
        now: NOW,
      }),
    ).toEqual({
      kind: 'drift',
      fetchedQuantity: 7,
      alert: {
        alert: 'seat_change_drift',
        previousQuantity: 2,
        targetQuantity: 4,
        fetchedQuantity: 7,
      },
    });
  });

  it('keeps an unreadable fetched quantity pending after the window and retries it inside', () => {
    const afterWindow = decideSeatChangeRecovery({
      previousQuantity: 2,
      targetQuantity: 4,
      fetchedQuantity: null,
      attemptedAt: NOW - STRIPE_IDEMPOTENCY_WINDOW_MS,
      now: NOW,
    });
    expect(afterWindow).toEqual({ kind: 'pending' });

    const insideWindow = decideSeatChangeRecovery({
      previousQuantity: 2,
      targetQuantity: 4,
      fetchedQuantity: null,
      attemptedAt: NOW - 1,
      now: NOW,
    });
    expect(insideWindow).toEqual({ kind: 'retry' });
  });

  it('treats a missing attempt timestamp as inside the window', () => {
    expect(seatChangeAttemptWithinWindow(null, NOW)).toBe(true);
    expect(
      decideSeatChangeRecovery({
        previousQuantity: 2,
        targetQuantity: 4,
        fetchedQuantity: 2,
        attemptedAt: null,
        now: NOW,
      }),
    ).toEqual({ kind: 'retry' });
  });

  it('treats the exact window boundary as outside and the millisecond before as inside', () => {
    expect(seatChangeAttemptWithinWindow(NOW - STRIPE_IDEMPOTENCY_WINDOW_MS + 1, NOW)).toBe(true);
    expect(seatChangeAttemptWithinWindow(NOW - STRIPE_IDEMPOTENCY_WINDOW_MS, NOW)).toBe(false);
  });

  it('builds the drift alert from the three quantities', () => {
    expect(
      seatChangeDriftAlert({ previousQuantity: 2, targetQuantity: 4, fetchedQuantity: 9 }),
    ).toEqual({
      alert: 'seat_change_drift',
      previousQuantity: 2,
      targetQuantity: 4,
      fetchedQuantity: 9,
    });
  });
});
