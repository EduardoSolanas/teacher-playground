/**
 * Room power comes from the Worker-stamped `accountId` query parameter.
 * Authorization headers are ignored; they never select a membership.
 */
export function verifiedAccountId(request: Request): string | null {
  const id = new URL(request.url).searchParams.get('accountId');
  return id && id.length > 0 ? id : null;
}
