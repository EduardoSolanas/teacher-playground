import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { isOriginGuardedPath } from '../lib/worker/requestGuard';

const BASE = 'https://example.com';

function localIssuer(): string {
  return (env as unknown as { ACCESS_ISSUER: string }).ACCESS_ISSUER;
}

export interface LocalAuthSession {
  readonly subject: string;
  readonly token: string;
  readonly cookie: string;
  readonly accountId: string;
}

export async function localAccessToken(
  subject: string,
  variant = 'valid',
  name?: string,
): Promise<string> {
  const params = new URLSearchParams({ sub: subject, variant });
  if (name) params.set('name', name);
  const response = await fetch(`${localIssuer()}/token?${params.toString()}`);
  if (!response.ok) throw new Error(`local issuer token failed: ${response.status}`);
  return ((await response.json()) as { token: string }).token;
}

export async function bootstrapLocalSession(subject: string): Promise<LocalAuthSession> {
  const token = await localAccessToken(subject);
  const response = await SELF.fetch(`${BASE}/auth/session`, {
    method: 'POST',
    headers: {
      Origin: BASE,
      'Cf-Access-Jwt-Assertion': token,
    },
  });
  if (response.status !== 201) {
    throw new Error(`local session bootstrap failed: ${response.status} ${await response.text()}`);
  }
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('local session bootstrap did not set a cookie');
  const body = (await response.json()) as { accountId: string };
  return { subject, token, cookie: setCookie.split(';', 1)[0], accountId: body.accountId };
}

export async function authenticatedFetch(
  path: string,
  session: LocalAuthSession,
  init: RequestInit = {},
  token = session.token,
): Promise<Response> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  // Ask the Worker's own guard which paths need an Origin, so this helper
  // cannot drift from the rule it is exercising. The guard takes a pathname,
  // so drop any query string (/signaling carries its room there).
  const pathname = path.split('?', 1)[0];
  const needsOrigin = isOriginGuardedPath(pathname, method);
  if (needsOrigin && !headers.has('Origin')) headers.set('Origin', BASE);
  headers.set('Cf-Access-Jwt-Assertion', token);
  headers.set('Cookie', session.cookie);
  return SELF.fetch(`${BASE}${path}`, { ...init, headers });
}

export async function accessFetch(
  path: string,
  subject: string,
  variant = 'valid',
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Cf-Access-Jwt-Assertion', await localAccessToken(subject, variant));
  return SELF.fetch(`${BASE}${path}`, { ...init, headers });
}
