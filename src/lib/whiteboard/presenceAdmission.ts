/** Maps presence POST HTTP status to local admission UI. */
export function admissionFromPresenceStatus(
  status: number,
): 'ok' | 'waiting' | 'queue_full' | 'rejected' | 'error' | 'ignore' {
  if (status >= 500) return 'error';
  if (status === 403) return 'rejected';
  // A full waiting list is a real refusal, so it cannot share the rate-limit
  // 429 the heartbeat backoff already treats as "still waiting".
  if (status === 409) return 'queue_full';
  if (status === 404 || status === 429) return 'waiting';
  if (status >= 200 && status < 300) return 'ok';
  return 'ignore';
}
