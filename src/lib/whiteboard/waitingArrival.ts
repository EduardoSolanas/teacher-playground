/**
 * Whether a waiting-room arrival should pull the roster open.
 *
 * Only the rising edge off an empty queue counts. Deriving "open" from "someone
 * is waiting" would pin the panel open for as long as the student sat there,
 * leaving the teacher no way to collapse it. Re-firing on each extra arrival
 * would reopen a panel the teacher had just deliberately closed. Neither is a
 * notification; both are the UI arguing with the person using it.
 */
export function shouldExpandForArrival(previousWaiting: number, waiting: number): boolean {
  return previousWaiting === 0 && waiting > 0;
}
