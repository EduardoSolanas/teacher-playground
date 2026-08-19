/**
 * Builds the body for a kick / suspend presence POST.
 *
 * Presence mints its own peer id when an account is admitted, so a peer id the
 * host captured while the peer was still queued can already be stale by the
 * time the host moderates. `resolveModerationTarget` rejects an unbound peer id
 * with a 404 even when a valid account id accompanies it, so the two ids are
 * never sent together: the account is the stable identity and wins whenever it
 * is known.
 */
export function moderationTargetBody(
  action: 'kick' | 'suspend',
  peerId: string,
  accountId?: string | null,
): Record<string, string> {
  if (accountId) return { action, accountId };
  return { action, peerId };
}
