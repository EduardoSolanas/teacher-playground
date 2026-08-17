export const SESSION_EXPIRED_EVENT = 'teacher-session-expired';

/**
 * Sends browser API/auth requests as same-origin AJAX. Cloudflare Access uses
 * X-Requested-With to return a 401 for an expired session instead of an HTML
 * login response, so callers cannot remove or replace that header.
 */
export async function ajaxFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const target = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (target.origin !== window.location.origin) throw new Error('Cross-origin AJAX request rejected');

  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  headers.set('X-Requested-With', 'XMLHttpRequest');

  const response = await fetch(input, {
    ...init,
    credentials: 'same-origin',
    headers,
  });
  if (response.status === 401 && target.pathname.startsWith('/api/')) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
  return response;
}
