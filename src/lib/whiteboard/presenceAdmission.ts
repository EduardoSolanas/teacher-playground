/** Maps presence POST HTTP status to local admission UI. */
export function admissionFromPresenceStatus(status: number): 'ok' | 'waiting' | 'rejected' | 'ignore' {
  if (status === 403) return 'rejected';
  if (status === 404 || status === 429) return 'waiting';
  if (status >= 200 && status < 300) return 'ok';
  return 'ignore';
}
