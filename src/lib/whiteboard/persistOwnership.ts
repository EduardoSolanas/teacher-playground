/**
 * Whether this peer should write the room's stored board.
 *
 * Every writer used to persist, so a one-teacher-one-student room sent the
 * whole board twice on every change. Worse than the duplication, the two
 * copies could disagree: the snapshot is taken when the save is scheduled, so
 * a peer could overwrite the stored board with a view from before the other
 * person's strokes arrived.
 *
 * The host writes it. Not the host alone, though: a teacher whose tab closes
 * mid-lesson would otherwise leave the student drawing into nothing, so anyone
 * still able to write takes over when no host is present. Redundant saves are
 * cheap; a lesson that saved nothing is not.
 */
export function shouldPersistBoard(input: {
  isHost: boolean;
  hostPresent: boolean;
}): boolean {
  return input.isHost || !input.hostPresent;
}
