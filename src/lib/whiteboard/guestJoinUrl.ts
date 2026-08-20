/**
 * Student join links must use the guest hostname. A teacher-host URL hits
 * Cloudflare Access and the student cannot proceed.
 */
export function guestHostJoinUrl(
  roomId: string,
  currentOrigin = typeof window !== 'undefined' ? window.location.origin : '',
): string {
  const guestHost = process.env.NEXT_PUBLIC_GUEST_HOSTNAME?.trim();
  if (guestHost) {
    return `https://${guestHost}/whiteboard/${roomId}`;
  }

  try {
    const url = new URL(currentOrigin);
    const labels = url.hostname.split('.');
    if (labels.length >= 2) {
      labels[0] = 'join';
      url.hostname = labels.join('.');
    } else {
      url.hostname = 'join.localhost';
    }
    return `${url.protocol}//${url.host}/whiteboard/${roomId}`;
  } catch {
    return `https://join.localhost/whiteboard/${roomId}`;
  }
}
