/**
 * Student join links must use the guest hostname. A teacher-host URL hits
 * Cloudflare Access and the student cannot proceed.
 *
 * The fallback used to rewrite the first hostname label whatever the host, so
 * `example.com` became `join.com` -- a domain nobody owns -- and the env-var
 * path always said `https://` with no port. The configured guest origin is now
 * authoritative: it may be a bare hostname or a full origin, and its scheme and
 * port survive. Without one, only a host with at least three labels (a real
 * `app.<domain>` shape) has its first label swapped; scheme and port are
 * preserved. Two-label hosts are left alone rather than redirected into a
 * different registrable domain, and so are literal IPv4 addresses, whose four
 * labels are not a subdomain shape. The single-label localhost fallback stays
 * for development.
 */
/**
 * A literal IPv4 address is not a domain with a subdomain to swap.
 *
 * It has four dot-separated labels, so the >=3-label rule below would read
 * `127.0.0.1` as `app.example.com` and rewrite the first label, producing
 * `join.0.0.1` -- a host that resolves nowhere. Left alone instead.
 */
function isIpv4Literal(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

export function guestHostJoinUrl(
  roomId: string,
  currentOrigin = typeof window !== 'undefined' ? window.location.origin : '',
): string {
  const path = `/whiteboard/${roomId}`;
  const guestHost = process.env.NEXT_PUBLIC_GUEST_HOSTNAME?.trim();
  if (guestHost) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(guestHost)) {
      return `${guestHost.replace(/\/+$/, '')}${path}`;
    }
    return `https://${guestHost}${path}`;
  }

  try {
    const url = new URL(currentOrigin);
    const labels = url.hostname.split('.');
    /*
     * The host is assembled rather than assigned through `url.hostname`,
     * whose setter silently ignores a value it cannot parse. That meant an
     * IPv4 literal like 127.0.0.1 -- four labels, so the >=3 rule tried to
     * swap the first -- happened to survive only because `join.0.0.1` was
     * rejected on assignment. Computing the string keeps that edge explicit
     * and testable: the guard below is what stops the rewrite.
     */
    let hostname = url.hostname;
    if (labels.length >= 3 && !isIpv4Literal(url.hostname)) {
      hostname = ['join', ...labels.slice(1)].join('.');
    } else if (labels.length === 1) {
      hostname = 'join.localhost';
    }
    return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}${path}`;
  } catch {
    return `https://join.localhost${path}`;
  }
}
