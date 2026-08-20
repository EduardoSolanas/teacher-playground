/**
 * Client-side guest-host detection. Fail closed: if
 * NEXT_PUBLIC_GUEST_HOSTNAME is unset, this is never the guest surface.
 */
export function isGuestHostname(hostname: string): boolean {
  const guestHostname = process.env.NEXT_PUBLIC_GUEST_HOSTNAME;
  if (!guestHostname) return false;
  return hostname.toLowerCase() === guestHostname.toLowerCase();
}
