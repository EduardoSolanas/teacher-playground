import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { getIdentityObject, type IdentityDO } from './do/IdentityDO';
import { accessFetch, authenticatedFetch, bootstrapLocalSession, localAccessToken } from './test/workerAuth';

const BASE = 'https://example.com';

describe('real local Access boundary through workerd', () => {
  it('rejects malformed, expired, wrong issuer, wrong audience, and service assertions as JSON 401', async () => {
    for (const variant of ['malformed', 'expired', 'wrong-issuer', 'wrong-audience', 'service-token']) {
      const response = await accessFetch('/api/whiteboard/room/no-access', `boundary-${variant}`, variant, {
        method: 'GET',
      });
      expect(response.status, variant).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
    }
  });

  it('bootstraps a signed local identity and reaches a protected API with its local session', async () => {
    const session = await bootstrapLocalSession('boundary-valid');
    const current = await authenticatedFetch('/auth/session/current', session);
    expect(current.status).toBe(200);
    expect(current.headers.get('cache-control')).toBe('no-store');
    // 403, not 401: the caller passed Access and the local session, and was
    // then stopped by room authorization because it is not a member.
    const response = await authenticatedFetch('/api/whiteboard/room/boundary-valid', session);
    expect(response.status).toBe(403);
    const logout = await authenticatedFetch('/auth/session/logout', session, {
      method: 'POST',
      headers: { Origin: 'https://example.com' },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('cache-control')).toBe('no-store');
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('accepts an empty browser-style POST body for session bootstrap', async () => {
    const token = await localAccessToken('browser-style-post');
    const response = await SELF.fetch(`${BASE}/auth/session`, {
      method: 'POST',
      headers: {
        Origin: BASE,
        'Cf-Access-Jwt-Assertion': token,
        'Content-Type': 'application/json',
        'Content-Length': '0',
      },
      body: '',
    });

    expect(response.status).toBe(201);
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toContain('__Host-teacher-session=');

    const logout = await SELF.fetch(`${BASE}/auth/session/logout`, {
      method: 'POST',
      headers: {
        Origin: BASE,
        'Cf-Access-Jwt-Assertion': token,
        'Content-Type': 'application/json',
        'Content-Length': '0',
        Cookie: setCookie!.split(';', 1)[0],
      },
      body: '',
    });
    expect(logout.status).toBe(204);
  });

  it('rejects inexact origins on session issue/logout before changing identity state', async () => {
    const subject = 'boundary-session-origin';
    const token = await localAccessToken(subject);
    const origins = [
      undefined,
      'null',
      'https://attacker.example',
      'https://sub.example.com',
      'http://example.com',
      'https://example.com:444',
      'https://example.com, https://attacker.example',
    ];
    for (const origin of origins) {
      const headers = new Headers({ 'Cf-Access-Jwt-Assertion': token });
      if (origin !== undefined) headers.set('Origin', origin);
      const response = await SELF.fetch(`${BASE}/auth/session`, { method: 'POST', headers });
      expect(response.status, `issue ${origin ?? 'missing'}`).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }

    const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
    const resolved = await identity.fetch('https://identity/subjects/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        issuer: (env as unknown as { ACCESS_ISSUER: string }).ACCESS_ISSUER,
        subject,
      }),
    });
    expect(resolved.status).toBe(201);
    expect(await resolved.json()).toMatchObject({ created: true });

    const session = await bootstrapLocalSession('boundary-logout-origin');
    for (const origin of origins) {
      const headers = new Headers({
        'Cf-Access-Jwt-Assertion': session.token,
        Cookie: session.cookie,
      });
      if (origin !== undefined) headers.set('Origin', origin);
      const response = await SELF.fetch(`${BASE}/auth/session/logout`, { method: 'POST', headers });
      expect(response.status, `logout ${origin ?? 'missing'}`).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await authenticatedFetch('/auth/session/current', session)).status).toBe(200);
  });

  it('rejects every non-read API method without an exact same-origin Origin before session or room state', async () => {
    const subject = 'boundary-origin-table';
    const token = await localAccessToken(subject);
    const origins = [
      undefined,
      'null',
      'https://attacker.example',
      'https://sub.example.com',
      'http://example.com',
      'https://example.com:444',
      'https://example.com, https://attacker.example',
    ];

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const [index, origin] of origins.entries()) {
        const roomId = `origin-${method.toLowerCase()}-${index}`;
        const headers = new Headers({
          'Cf-Access-Jwt-Assertion': token,
          'content-type': 'application/json',
        });
        if (origin !== undefined) headers.set('Origin', origin);
        const response = await SELF.fetch(`${BASE}/api/whiteboard/room/${roomId}`, {
          method,
          headers,
          body: method === 'OPTIONS' ? undefined : JSON.stringify({ elements: [] }),
        });
        expect(response.status, `${method} ${origin ?? 'missing'}`).toBe(403);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({ error: 'Origin required' });

        const untouched = await accessFetch(`/api/whiteboard/room/${roomId}`, subject);
        // A 401 proves the guard ran before local-session authorization. A
        // same-origin session probe below proves rejected POSTs never create.
        expect(untouched.status).toBe(401);
      }
    }

    // Room reads now answer 403 for any non-member, so they cannot prove a room
    // is absent. Creating it instead can: only the first writer of a room that
    // does not yet exist becomes its owner, so a 200 here proves the rejected
    // cross-origin POSTs never created anything.
    const session = await bootstrapLocalSession(subject);
    for (let index = 0; index < origins.length; index += 1) {
      const claimed = await authenticatedFetch(`/api/whiteboard/room/origin-post-${index}`, session, {
        method: 'POST',
        headers: { Origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({ elements: [] }),
      });
      expect(claimed.status, `room ${index} was mutated`).toBe(200);
    }
  });

  it('allows originless API reads but requires exact same-origin Origin on mutations', async () => {
    const session = await bootstrapLocalSession('boundary-origin-positive');
    const read = await authenticatedFetch('/api/whiteboard/room/origin-positive', session);
    expect(read.status).toBe(403);

    const create = await authenticatedFetch('/api/whiteboard/room/origin-positive', session, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    });
    expect(create.status).toBe(200);

    const head = await authenticatedFetch('/api/whiteboard/room/origin-positive', session, { method: 'HEAD' });
    expect(head.status).not.toBe(403);
  });

  it('requires exact same-origin Origin on signaling before local-session authorization or upgrade', async () => {
    const subject = 'boundary-signaling-origin';
    for (const origin of [
      undefined,
      'null',
      'https://attacker.example',
      'https://sub.example.com',
      'http://example.com',
      'https://example.com:444',
      'https://example.com, https://attacker.example',
    ]) {
      const headers = new Headers({ Upgrade: 'websocket' });
      if (origin !== undefined) headers.set('Origin', origin);
      const response = await accessFetch('/signaling?room=origin-rejected', subject, 'valid', { headers });
      expect(response.status, origin ?? 'missing').toBe(403);
      expect(response.webSocket).toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'Origin required' });
    }

    const session = await bootstrapLocalSession(subject);
    const accepted = await authenticatedFetch('/signaling?room=origin-accepted', session, {
      headers: { Upgrade: 'websocket', Origin: BASE },
    });
    expect(accepted.status).toBe(101);
    expect(accepted.webSocket).not.toBeNull();
    accepted.webSocket?.accept();
    accepted.webSocket?.close();
  });

  it('denies missing sessions and wrong principals before the room handler', async () => {
    const session = await bootstrapLocalSession('boundary-owner');
    const missing = await accessFetch('/api/whiteboard/room/boundary-owner', 'boundary-owner');
    expect(missing.status).toBe(401);
    const wrongToken = await localAccessToken('boundary-other');
    const wrongPrincipal = await authenticatedFetch('/api/whiteboard/room/boundary-owner', session, {}, wrongToken);
    expect(wrongPrincipal.status).toBe(401);
    expect(wrongPrincipal.headers.get('set-cookie')).toContain('Max-Age=0');
    const valid = await authenticatedFetch('/api/whiteboard/room/boundary-owner', session);
    expect(valid.status).toBe(403);
  });

  it('denies a locally disabled account while its signed Access assertion remains valid', async () => {
    const session = await bootstrapLocalSession('boundary-disabled');
    const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
    const disabled = await identity.fetch('https://identity/accounts/disable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: session.accountId }),
    });
    expect(disabled.status).toBe(200);
    const denied = await authenticatedFetch('/api/whiteboard/room/boundary-disabled', session);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
