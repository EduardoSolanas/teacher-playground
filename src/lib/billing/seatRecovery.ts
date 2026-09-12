export const STRIPE_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1_000;

export interface SeatChangeDriftAlert {
  alert: 'seat_change_drift';
  previousQuantity: number;
  targetQuantity: number;
  fetchedQuantity: number;
}

export type SeatChangeRecoveryDecision =
  | { kind: 'settled' }
  | { kind: 'retry' }
  | { kind: 'released' }
  | { kind: 'pending' }
  | { kind: 'drift'; fetchedQuantity: number; alert: SeatChangeDriftAlert };

export function seatChangeAttemptWithinWindow(
  attemptedAt: number | null,
  now: number,
): boolean {
  if (attemptedAt === null) return true;
  return now - attemptedAt < STRIPE_IDEMPOTENCY_WINDOW_MS;
}

export function seatChangeDriftAlert(input: {
  previousQuantity: number;
  targetQuantity: number;
  fetchedQuantity: number;
}): SeatChangeDriftAlert {
  return {
    alert: 'seat_change_drift',
    previousQuantity: input.previousQuantity,
    targetQuantity: input.targetQuantity,
    fetchedQuantity: input.fetchedQuantity,
  };
}

export function decideSeatChangeRecovery(input: {
  previousQuantity: number;
  targetQuantity: number;
  fetchedQuantity: number | null;
  attemptedAt: number | null;
  now: number;
}): SeatChangeRecoveryDecision {
  const withinWindow = seatChangeAttemptWithinWindow(input.attemptedAt, input.now);
  if (input.fetchedQuantity !== null) {
    if (input.fetchedQuantity === input.targetQuantity) return { kind: 'settled' };
    if (input.fetchedQuantity === input.previousQuantity) {
      return withinWindow ? { kind: 'retry' } : { kind: 'released' };
    }
    return {
      kind: 'drift',
      fetchedQuantity: input.fetchedQuantity,
      alert: seatChangeDriftAlert({
        previousQuantity: input.previousQuantity,
        targetQuantity: input.targetQuantity,
        fetchedQuantity: input.fetchedQuantity,
      }),
    };
  }
  return withinWindow ? { kind: 'retry' } : { kind: 'pending' };
}
