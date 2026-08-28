import { afterEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import { getIdentityObject, type IdentityDO } from './do/IdentityDO';
import { MAX_BODY_BYTES } from './lib/worker/requestGuard';
import { DESTRUCTIVE_FRESH_MS } from './lib/identity/sessionStore';
import { accessFetch, authenticatedFetch, bootstrapLocalSession, localAccessToken } from './test/workerAuth';
import { resetAuthEventWriterForTests, setAuthEventWriterForTests } from './worker';

declare global {
  namespace Cloudflare {
    interface Env {
      BOARD_FILES: R2Bucket;
    }
  }
}
import {
  ACCESS_REQUEST_RATE_MAX,
  PRESENCE_POST_RATE_MAX,
  ROOM_CREATE_RATE_MAX,
  SCENE_WRITE_RATE_MAX,
} from './lib/worker/rateLimits';

const BASE = 'https://example.com';
// Rate caps are imported from the Worker, never re-declared here: a local copy
// silently drifted from production and made the presence limit test assert a
// threshold the Worker no longer used.

describe('real local Access boundary through workerd', () => {
  afterEach(() => {
    resetAuthEventWriterForTests();
  });
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

  it('returns the verified Access full name on the current session and ignores email', async () => {
    const token = await localAccessToken('session-display-name', 'valid', 'Ada Lovelace');
    const issued = await SELF.fetch(`${BASE}/auth/session`, {
      method: 'POST',
      headers: {
        Origin: BASE,
        'Cf-Access-Jwt-Assertion': token,
      },
    });
    expect(issued.status).toBe(201);
    const cookie = issued.headers.get('set-cookie')!.split(';', 1)[0];
    const current = await SELF.fetch(`${BASE}/auth/session/current`, {
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        Cookie: cookie,
      },
    });
    expect(current.status).toBe(200);
    const body = await current.json() as { displayName?: string; accountId?: string };
    expect(body.displayName).toBe('Ada Lovelace');
    expect(JSON.stringify(body)).not.toMatch(/@/);
  });

  it('lets the caller set a preferred display name that session current returns instead of the Access JWT name', async () => {
    const token = await localAccessToken('profile-display-name', 'valid', 'Ada Lovelace');
    const issued = await SELF.fetch(`${BASE}/auth/session`, {
      method: 'POST',
      headers: {
        Origin: BASE,
        'Cf-Access-Jwt-Assertion': token,
      },
    });
    expect(issued.status).toBe(201);
    const cookie = issued.headers.get('set-cookie')!.split(';', 1)[0];
    const session = {
      subject: 'profile-display-name',
      token,
      cookie,
      accountId: ((await issued.json()) as { accountId: string }).accountId,
    };

    const missingOrigin = await SELF.fetch(`${BASE}/auth/account/profile`, {
      method: 'PATCH',
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        Cookie: cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Ms Ada' }),
    });
    expect(missingOrigin.status).toBe(403);

    const saved = await authenticatedFetch('/auth/account/profile', session, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Ms Ada' }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ displayName: 'Ms Ada' });

    const current = await authenticatedFetch('/auth/session/current', session);
    expect(current.status).toBe(200);
    const body = await current.json() as Record<string, unknown>;
    expect(body.displayName).toBe('Ms Ada');
    expect(body).not.toHaveProperty('preferredDisplayName');
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

  it('GET /auth/access/logout clears CF_Authorization and redirects home in local-test', async () => {
    const response = await SELF.fetch(`${BASE}/auth/access/logout?redirect=${encodeURIComponent('/')}`, {
      redirect: 'manual',
      headers: { Cookie: 'CF_Authorization=fake-token' },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('CF_Authorization=');
    expect(setCookie).toContain('Max-Age=0');
  });

  // Ending the app session must NOT end the Access session. Full sign-out is
  // completeSignOut(), which calls this and then navigates to
  // /auth/access/logout. Clearing the Access cookie here as well left a user
  // unable to re-bootstrap a local session while their Access session was
  // still valid (tests/e2e/auth-security.spec.ts "bootstrap, use, logout, and
  // re-bootstrap all work in sequence").
  it('POST /auth/session/logout leaves CF_Authorization for re-bootstrap', async () => {
    const session = await bootstrapLocalSession('logout-cf-cookie');
    const response = await authenticatedFetch('/auth/session/logout', session, {
      method: 'POST',
      headers: { Origin: 'https://example.com' },
    });
    expect(response.status).toBe(204);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain('CF_Authorization=');
  });

  it('GET /auth/access/logout is what clears CF_Authorization', async () => {
    const response = await SELF.fetch(
      `${BASE}/auth/access/logout?redirect=${encodeURIComponent('/')}`,
      { redirect: 'manual', headers: { Cookie: 'CF_Authorization=fake-token' } },
    );
    expect(response.status).toBe(302);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('CF_Authorization=');
    expect(setCookie).toContain('Max-Age=0');
  });

  it('exports only the caller account after Access and a local session', async () => {
    const session = await bootstrapLocalSession('export-own-account');
    const other = await bootstrapLocalSession('export-other-account');
    const rawToken = session.cookie.split('=', 2)[1];

    const missingSession = await accessFetch('/auth/account/export', 'export-own-account');
    expect(missingSession.status).toBe(401);

    const exported = await authenticatedFetch('/auth/account/export', session);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('cache-control')).toBe('no-store');
    const body = await exported.json() as {
      accountId: string;
      createdAt: number;
      sessions: Array<{ sessionHash: string }>;
      accessSubjects: Array<{ issuer: string; subject: string }>;
    };
    expect(body.accountId).toBe(session.accountId);
    expect(body.sessions[0]?.sessionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.accessSubjects).toEqual([
      expect.objectContaining({ subject: 'export-own-account' }),
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(rawToken);
    expect(serialized).not.toContain(other.accountId);

    const mixed = await authenticatedFetch(
      '/auth/account/export',
      session,
      {},
      other.token,
    );
    expect(mixed.status).toBe(401);
  });

  it('erases the caller account after Access and a fresh local session', async () => {
    const session = await bootstrapLocalSession('erase-own-account');
    const other = await bootstrapLocalSession('erase-other-account');

    const getDenied = await authenticatedFetch('/auth/account', session);
    expect(getDenied.status).toBe(405);
    expect(getDenied.headers.get('allow')).toBe('DELETE');

    const missingSession = await accessFetch('/auth/account', 'erase-own-account', 'valid', {
      method: 'DELETE',
    });
    expect(missingSession.status).toBe(401);

    await runInDurableObject(
      getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>),
      (instance: IdentityDO) => {
        instance.db
          .prepare(
            `UPDATE sessions SET created_at = created_at - ?
             WHERE account_id = ? AND revoked_at IS NULL`,
          )
          .run(DESTRUCTIVE_FRESH_MS + 60_000, session.accountId);
      },
    );
    const stale = await authenticatedFetch('/auth/account', session, { method: 'DELETE' });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: 'Reauthentication required' });
    expect((await authenticatedFetch('/auth/session/current', session)).status).toBe(200);

    const confirm = await authenticatedFetch('/auth/session/confirm', session, {
      method: 'POST',
    });
    expect(confirm.status).toBe(200);

    const erased = await authenticatedFetch('/auth/account', session, { method: 'DELETE' });
    expect(erased.status).toBe(200);
    expect(erased.headers.get('cache-control')).toBe('no-store');
    expect(erased.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await erased.json()).toEqual({ ok: true });
    expect((await authenticatedFetch('/auth/session/current', session)).status).toBe(401);
    expect((await authenticatedFetch('/auth/session/current', other)).status).toBe(200);
  });

  it('erases uploaded board images along with the account', async () => {
    /*
     * The board rows are erased through the room object, which cannot reach R2
     * -- the bucket is bound to the Worker. So an erasure that only forwarded
     * to the room left every uploaded picture in the bucket for good, which for
     * images of children's work is the one kind of leftover that matters.
     */
    const owner = await bootstrapLocalSession('erase-board-files');
    const roomId = `erase-files-${crypto.randomUUID()}`;
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    const bytes = new Uint8Array([9, 8, 7, 6]);
    expect((await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/files/erase-me-1`,
      owner,
      {
        method: 'PUT',
        headers: { Origin: BASE, 'content-type': 'image/png', 'content-length': String(bytes.length) },
        body: bytes,
      },
    )).status).toBe(201);

    const key = `rooms/${roomId}/files/erase-me-1`;
    expect(await env.BOARD_FILES.get(key)).not.toBeNull();

    expect((await authenticatedFetch('/auth/session/confirm', owner, { method: 'POST' })).status).toBe(200);
    expect((await authenticatedFetch('/auth/account', owner, { method: 'DELETE' })).status).toBe(200);

    expect(await env.BOARD_FILES.get(key)).toBeNull();
  });

  it('purges rooms the caller owned and leaves another account room intact', async () => {
    const owner = await bootstrapLocalSession('erase-owned-rooms');
    const other = await bootstrapLocalSession('erase-other-rooms');
    const ownedRoomId = `erase-owned-${crypto.randomUUID()}`;
    const otherRoomId = `erase-other-${crypto.randomUUID()}`;

    expect((await authenticatedFetch(`/api/whiteboard/room/${ownedRoomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);
    expect((await authenticatedFetch(`/api/whiteboard/room/${otherRoomId}`, other, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    let listedIds: string[] = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const listed = await waitForTeacherRooms(owner);
      listedIds = teacherRoomIds(listed.body);
      if (listedIds.includes(ownedRoomId)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(listedIds).toContain(ownedRoomId);

    const erased = await authenticatedFetch('/auth/account', owner, { method: 'DELETE' });
    expect(erased.status).toBe(200);
    expect(await erased.json()).toEqual({ ok: true });

    const gone = await authenticatedFetch(`/api/whiteboard/room/${ownedRoomId}`, other);
    expect(gone.status).toBe(410);
    const kept = await authenticatedFetch(`/api/whiteboard/room/${otherRoomId}`, other);
    expect(kept.status).toBe(200);
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
    for (let index = 0; index < origins.length; index += 1) {
      const claimer = await bootstrapLocalSession(`${subject}-claim-${index}`);
      const claimed = await authenticatedFetch(`/api/whiteboard/room/origin-post-${index}`, claimer, {
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
    expect((await authenticatedFetch('/api/whiteboard/room/origin-accepted', session, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: BASE },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);
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

  it('rate-limits room creation per account with 429 and Retry-After', async () => {
    const session = await bootstrapLocalSession('boundary-create-rate');
    const createRoom = (index: number) => authenticatedFetch(
      `/api/whiteboard/room/rate-create-${index}`,
      session,
      {
        method: 'POST',
        headers: {
          Origin: BASE,
          'content-type': 'application/json',
          'x-test-strict-rate-limit': '1',
        },
        body: JSON.stringify({ elements: [] }),
      },
    );

    for (let index = 0; index < ROOM_CREATE_RATE_MAX; index += 1) {
      const response = await createRoom(index);
      expect(response.status, `create ${index}`).toBe(200);
      expect((await authenticatedFetch(`/api/whiteboard/room/rate-create-${index}`, session, {
        method: 'DELETE',
      })).status).toBe(200);
    }

    const limited = await createRoom(ROOM_CREATE_RATE_MAX);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    const retryAfter = limited.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ error: 'Too many requests' });
  });

  it('logs rate_limit on 429 without cookie or JWT', async () => {
    const lines: string[] = [];
    setAuthEventWriterForTests((line) => lines.push(line));
    const session = await bootstrapLocalSession('boundary-rate-limit-log');
    const createRoom = (index: number) => authenticatedFetch(
      `/api/whiteboard/room/rate-log-${index}`,
      session,
      {
        method: 'POST',
        headers: {
          Origin: BASE,
          'content-type': 'application/json',
          'x-test-strict-rate-limit': '1',
        },
        body: JSON.stringify({ elements: [] }),
      },
    );

    for (let index = 0; index < ROOM_CREATE_RATE_MAX; index += 1) {
      const response = await createRoom(index);
      expect(response.status, `create ${index}`).toBe(200);
      expect((await authenticatedFetch(`/api/whiteboard/room/rate-log-${index}`, session, {
        method: 'DELETE',
      })).status).toBe(200);
    }

    const limited = await createRoom(ROOM_CREATE_RATE_MAX);
    expect(limited.status).toBe(429);

    const rateLimitLines = lines.filter((line) => {
      const logged = JSON.parse(line) as { type?: string };
      return logged.type === 'rate_limit';
    });
    expect(rateLimitLines.length).toBeGreaterThanOrEqual(1);
    for (const line of rateLimitLines) {
      const logged = JSON.parse(line);
      expect(logged).toMatchObject({ event: 'auth_event', type: 'rate_limit' });
      expect(line).not.toContain(session.token);
      expect(line).not.toContain(session.cookie);
      expect(line).not.toMatch(/Bearer\s+eyJ/i);
      expect(line).not.toMatch(/__Host-teacher-session=/);
    }
  });

  it('rate-limits access requests per account with 429 and Retry-After', async () => {
    const owner = await bootstrapLocalSession('boundary-access-rate-owner');
    const requester = await bootstrapLocalSession('boundary-access-rate-requester');
    const roomId = 'rate-access-request';
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    const requestAccess = () => authenticatedFetch(
      `/api/whiteboard/room/${roomId}/requests`,
      requester,
      {
        method: 'POST',
        headers: {
          Origin: BASE,
          'content-type': 'application/json',
          'x-test-strict-rate-limit': '1',
        },
        body: JSON.stringify({ userName: 'Student' }),
      },
    );

    for (let index = 0; index < ACCESS_REQUEST_RATE_MAX; index += 1) {
      const response = await requestAccess();
      expect(response.status, `request ${index}`).toBe(201);
    }

    const limited = await requestAccess();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    const retryAfter = limited.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ error: 'Too many requests' });

    const approve = await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/requests/${requester.accountId}`,
      owner,
      {
        method: 'POST',
        headers: { Origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role: 'peer' }),
      },
    );
    expect(approve.status).toBe(200);

    for (let index = 0; index <= ACCESS_REQUEST_RATE_MAX; index += 1) {
      const heartbeat = await authenticatedFetch(
        `/api/whiteboard/room/${roomId}/presence`,
        requester,
        {
          method: 'POST',
          headers: {
            Origin: BASE,
            'content-type': 'application/json',
            'x-test-strict-rate-limit': '1',
          },
          body: JSON.stringify({ peerId: 'rate-access-editor', userName: 'Student' }),
        },
      );
      expect(heartbeat.status, `heartbeat ${index}`).toBe(200);
    }
  });

  it('rate-limits presence POSTs per account with 429 and Retry-After', async () => {
    const owner = await bootstrapLocalSession('boundary-presence-rate-owner');
    const joiner = await bootstrapLocalSession('boundary-presence-rate-joiner');
    const roomId = 'rate-presence-join';
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, joiner, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'Student' }),
    })).status).toBe(201);
    expect((await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/requests/${joiner.accountId}`,
      owner,
      {
        method: 'POST',
        headers: { Origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role: 'peer' }),
      },
    )).status).toBe(200);

    const postPresence = (userName: string) => authenticatedFetch(
      `/api/whiteboard/room/${roomId}/presence`,
      joiner,
      {
        method: 'POST',
        headers: {
          Origin: BASE,
          'content-type': 'application/json',
          'x-test-strict-rate-limit': '1',
        },
        body: JSON.stringify({ peerId: 'rate-presence-peer', userName }),
      },
    );

    for (let index = 0; index < PRESENCE_POST_RATE_MAX; index += 1) {
      const response = await postPresence(`Name-${index}`);
      expect(response.status, `presence ${index}`).toBe(200);
    }

    const limited = await postPresence('Name-flood');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    const retryAfter = limited.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ error: 'Too many requests' });

    const list = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, joiner);
    expect(list.status).toBe(200);
    // 90 sequential workerd round trips: past vitest's 5s default under
    // suite load. Same reason the scene-write cap test below extends it.
  }, 20_000);

  it('rate-limits existing-room scene writes per account with 429 and Retry-After', async () => {
    const session = await bootstrapLocalSession('boundary-scene-write-rate');
    const roomId = 'rate-scene-write';
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    const writeScene = (index: number) => authenticatedFetch(
      `/api/whiteboard/room/${roomId}`,
      session,
      {
        method: 'POST',
        headers: {
          Origin: BASE,
          'content-type': 'application/json',
          'x-test-strict-rate-limit': '1',
        },
        body: JSON.stringify({ elements: [] }),
      },
    );

    for (let index = 0; index < SCENE_WRITE_RATE_MAX; index += 1) {
      const response = await writeScene(index);
      expect(response.status, `scene ${index}`).toBe(200);
    }

    const limited = await writeScene(SCENE_WRITE_RATE_MAX);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    const retryAfter = limited.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ error: 'Too many requests' });

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session, {
      method: 'DELETE',
    })).status).toBe(200);

    const createStillAllowed = await authenticatedFetch(
      '/api/whiteboard/room/rate-scene-write-new',
      session,
      {
        method: 'POST',
        headers: {
          Origin: BASE,
          'content-type': 'application/json',
          'x-test-strict-rate-limit': '1',
        },
        body: JSON.stringify({ elements: [] }),
      },
    );
    expect(createStillAllowed.status).toBe(200);
  }, 20_000);

  it('logs auth_failure without tokens when the local session is missing', async () => {
    const lines: string[] = [];
    setAuthEventWriterForTests((line) => lines.push(line));
    const token = await localAccessToken('boundary-auth-log-missing');

    const api = await SELF.fetch(`${BASE}/api/whiteboard/room/auth-log-missing`, {
      method: 'GET',
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    expect(api.status).toBe(401);

    const signaling = await SELF.fetch(`${BASE}/signaling?room=auth-log-missing`, {
      headers: { Upgrade: 'websocket', Origin: BASE, 'Cf-Access-Jwt-Assertion': token },
    });
    expect(signaling.status).toBe(401);

    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      const logged = JSON.parse(line);
      expect(logged).toMatchObject({ event: 'auth_event', type: 'auth_failure', outcome: 'denied' });
      expect(line).not.toContain(token);
      expect(line).not.toMatch(/Bearer\s+eyJ/i);
      expect(line).not.toMatch(/__Host-teacher-session=/);
    }
  });

  it('logs auth_failure on origin-guard 403 without sensitive request values', async () => {
    const lines: string[] = [];
    setAuthEventWriterForTests((line) => lines.push(line));
    const session = await bootstrapLocalSession('boundary-auth-log-origin');
    const token = session.token;

    const response = await SELF.fetch(`${BASE}/api/whiteboard/room/auth-log-origin`, {
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        Cookie: session.cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ elements: [] }),
    });
    expect(response.status).toBe(403);

    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0]!);
    expect(logged).toMatchObject({ event: 'auth_event', type: 'auth_failure', outcome: 'denied' });
    expect(lines[0]).not.toContain(token);
    expect(lines[0]).not.toContain(session.cookie);
  });

  it('rejects a foreign Origin on an otherwise valid session mutation without changing the room', async () => {
    const session = await bootstrapLocalSession('boundary-csrf-session');
    const roomId = 'csrf-session-room';
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, session, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Kept' }),
    })).status).toBe(200);

    const hijack = await authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, session, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Stolen' }),
    });
    expect(hijack.status).toBe(403);
    expect(await hijack.json()).toEqual({ error: 'Origin required' });

    const still = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session);
    expect(still.status).toBe(200);
    expect(await still.json()).toMatchObject({ name: 'Kept' });
  });

  it('denies a locally disabled account while its signed Access assertion remains valid', async () => {
    const session = await bootstrapLocalSession('boundary-disabled');
    const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
    const disabled = await identity.fetch('https://identity/accounts/disable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: session.accountId, actor: 'test-operator', reason: 'automated test' }),
    });
    expect(disabled.status).toBe(200);
    const denied = await authenticatedFetch('/api/whiteboard/room/boundary-disabled', session);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('still serves a room API after identity headers are present on the Worker request', async () => {
    const session = await bootstrapLocalSession('boundary-strip-owner');
    const roomId = 'strip-identity-headers';
    const create = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session, {
      method: 'POST',
      headers: {
        Origin: BASE,
        'content-type': 'application/json',
        'X-Account-Id': 'acct-injected',
        'X-User-Id': 'user-injected',
        'X-Forwarded-User': 'forwarded-injected',
        Authorization: 'Bearer forged',
      },
      body: JSON.stringify({ elements: [] }),
    });
    expect(create.status).toBe(200);

    const read = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, session, {
      headers: { 'X-Account-Id': 'acct-injected' },
    });
    expect(read.status).toBe(200);
  });

  it('rejects an oversized POST without Content-Length as 413 and leaves the scene unchanged', async () => {
    const owner = await bootstrapLocalSession('boundary-body-cap-owner');
    const roomId = 'bounded-body-missing-cl';
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [{ id: 'keep' }] }),
    })).status).toBe(200);

    const oversized = JSON.stringify({
      elements: [{ id: 'oversized', pad: 'x'.repeat(MAX_BODY_BYTES) }],
    });
    const bytes = new TextEncoder().encode(oversized);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const oversizedResponse = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(oversizedResponse.status).toBe(413);

    const still = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner);
    expect(still.status).toBe(200);
    expect(await still.json()).toMatchObject({
      elements: [expect.objectContaining({ id: 'keep' })],
    });
  });

  it('does not let a forged X-Account-Id or Cookie select another account in RoomDO', async () => {
    const owner = await bootstrapLocalSession('boundary-strip-owner-neg');
    const outsider = await bootstrapLocalSession('boundary-strip-outsider-neg');
    const roomId = 'strip-identity-forge';
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    const forged = await authenticatedFetch(
      `/api/whiteboard/room/${roomId}?accountId=${encodeURIComponent(owner.accountId)}`,
      outsider,
      {
        headers: {
          'X-Account-Id': owner.accountId,
          Cookie: `${outsider.cookie}; ${owner.cookie}`,
        },
      },
    );
    expect(forged.status).toBe(403);

    const stillOwner = await authenticatedFetch(
      `/api/whiteboard/room/${roomId}?accountId=${encodeURIComponent(outsider.accountId)}`,
      owner,
      { headers: { 'X-Account-Id': outsider.accountId } },
    );
    expect(stillOwner.status).toBe(200);
  });

  it('rejects GET /api/whiteboard/rooms without a local session as 401', async () => {
    const response = await accessFetch('/api/whiteboard/rooms', 'rooms-list-missing-session');
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('lists only the authenticated teacher rooms after create and delete', async () => {
    const teacherA = await bootstrapLocalSession('rooms-list-teacher-a');
    const teacherB = await bootstrapLocalSession('rooms-list-teacher-b');
    const roomId = `rooms-list-${crypto.randomUUID()}`;

    const created = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, teacherA, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ hasCreatorGrant: true });

    const listA = await waitForTeacherRooms(teacherA);
    expect(listA.status).toBe(200);
    expect(listA.headers.get('cache-control')).toBe('no-store');
    expect(teacherRoomIds(listA.body)).toContain(roomId);

    const listB = await waitForTeacherRooms(
      teacherB,
      `?accountId=${encodeURIComponent(teacherA.accountId)}`,
    );
    expect(listB.status).toBe(200);
    expect(teacherRoomIds(listB.body)).not.toContain(roomId);

    const deleted = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, teacherA, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);

    const afterDelete = await waitForTeacherRooms(teacherA);
    if (afterDelete.status === 404) return;
    expect(afterDelete.status).toBe(200);
    expect(teacherRoomIds(afterDelete.body)).not.toContain(roomId);
  });

  it('syncs owner room name from settings into GET /api/whiteboard/rooms', async () => {
    const owner = await bootstrapLocalSession('rooms-list-settings-name');
    const roomId = `rooms-name-${crypto.randomUUID()}`;

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    const settings = await authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, owner, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Algebra' }),
    });
    expect(settings.status).toBe(200);

    const named = await waitForTeacherRoomName(owner, roomId, 'Algebra');
    expect(named).toEqual(expect.objectContaining({ roomId, name: 'Algebra' }));
  });

  it('rejects a second owned room with the plan-limit status and does not create it', async () => {
    const owner = await bootstrapLocalSession('rooms-plan-second');
    const firstId = `plan-room-a-${crypto.randomUUID()}`;
    const secondId = `plan-room-b-${crypto.randomUUID()}`;

    expect((await authenticatedFetch(`/api/whiteboard/room/${firstId}`, owner, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    const second = await authenticatedFetch(`/api/whiteboard/room/${secondId}`, owner, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    });
    expect(second.status).toBe(402);
    expect(await second.json()).toEqual({ error: 'Plan limit reached' });

    const listed = await waitForTeacherRooms(owner);
    expect(teacherRoomIds(listed.body)).toEqual([firstId]);
    expect((await authenticatedFetch(`/api/whiteboard/room/${secondId}`, owner)).status).toBe(410);
  });

  it('rejects occupancy above host plus one student with the plan-limit status', async () => {
    const owner = await bootstrapLocalSession('rooms-plan-seats');
    const roomId = `plan-seats-${crypto.randomUUID()}`;

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);

    const settings = await authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, owner, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ maxUsers: 3 }),
    });
    expect(settings.status).toBe(402);
    expect(await settings.json()).toEqual({ error: 'Plan limit reached' });

    const read = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner);
    expect(await read.json()).toMatchObject({ maxUsers: 2 });
  });

  it('refuses guest-verify subpath with 404 for authenticated POST', async () => {
    const session = await bootstrapLocalSession('guest-verify-post');
    const response = await authenticatedFetch('/api/whiteboard/room/guest-verify-test/guest-verify', session, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '1234' }),
    });
    expect(response.status).toBe(404);
  });

  it('refuses guest-verify subpath with 404 for authenticated GET', async () => {
    const session = await bootstrapLocalSession('guest-verify-get');
    const response = await authenticatedFetch('/api/whiteboard/room/guest-verify-test/guest-verify', session);
    expect(response.status).toBe(404);
  });

  it('refuses guest-verify subpath with 404 for authenticated PUT', async () => {
    const session = await bootstrapLocalSession('guest-verify-put');
    const response = await authenticatedFetch('/api/whiteboard/room/guest-verify-test/guest-verify', session, {
      method: 'PUT',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '1234' }),
    });
    expect(response.status).toBe(404);
  });

  it('refuses guest-verify subpath with 404 for authenticated DELETE', async () => {
    const session = await bootstrapLocalSession('guest-verify-delete');
    const response = await authenticatedFetch('/api/whiteboard/room/guest-verify-test/guest-verify', session, {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
  });

  it('refuses guest-verify subpath with 404 for authenticated PATCH', async () => {
    const session = await bootstrapLocalSession('guest-verify-patch');
    const response = await authenticatedFetch('/api/whiteboard/room/guest-verify-test/guest-verify', session, {
      method: 'PATCH',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '1234' }),
    });
    expect(response.status).toBe(404);
  });

  it('refuses guest-verify with trailing slash with 404', async () => {
    const session = await bootstrapLocalSession('guest-verify-trailing');
    const response = await authenticatedFetch('/api/whiteboard/room/guest-verify-test/guest-verify/', session);
    expect(response.status).toBe(404);
  });

  it('refuses guest-verify with deeper path with 404', async () => {
    const session = await bootstrapLocalSession('guest-verify-deeper');
    const response = await authenticatedFetch('/api/whiteboard/room/guest-verify-test/guest-verify/anything', session);
    expect(response.status).toBe(404);
  });

  it('returns 401 for guest-verify without session before the 404 check', async () => {
    const response = await accessFetch('/api/whiteboard/room/guest-verify-test/guest-verify', 'guest-verify-nosession');
    expect(response.status).toBe(401);
  });

  it('allows other room subpaths to work as before (regression test)', async () => {
    const owner = await bootstrapLocalSession('guest-verify-regression');
    const roomId = 'guest-verify-room';
    const create = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { Origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    });
    expect(create.status).toBe(200);

    const access = await authenticatedFetch(`/api/whiteboard/room/${roomId}/access`, owner);
    expect(access.status).toBe(200);

    const root = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner);
    expect(root.status).toBe(200);
  });

  describe('board file upload and download', () => {
    it('returns the exact bytes that were uploaded', async () => {
      const owner = await bootstrapLocalSession('board-file-roundtrip');
      const roomId = 'board-file-roundtrip-room';
      expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
        method: 'POST',
        headers: { Origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({ elements: [] }),
      })).status).toBe(200);

      // A byte pattern that would survive nothing that re-encodes it.
      const bytes = new Uint8Array(2048);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) % 256;

      const upload = await authenticatedFetch(
        `/api/whiteboard/room/${roomId}/files/roundtrip-file-1`,
        owner,
        {
          method: 'PUT',
          headers: { Origin: BASE, 'content-type': 'image/png', 'content-length': String(bytes.length) },
          body: bytes,
        },
      );
      expect(upload.status).toBe(201);

      const download = await authenticatedFetch(
        `/api/whiteboard/room/${roomId}/files/roundtrip-file-1`,
        owner,
      );
      expect(download.status).toBe(200);
      expect(download.headers.get('content-type')).toBe('image/png');
      // SEC-012 forces no-store on every non-HTML response, so the route's own
      // immutable caching header does not survive. Documented here because it
      // means each image is refetched on every load; see the note in the review.
      expect(download.headers.get('cache-control')).toBe('no-store');
      expect(Array.from(new Uint8Array(await download.arrayBuffer()))).toEqual(Array.from(bytes));
    });

    it('refuses a file to an account with no grant in that room', async () => {
      const owner = await bootstrapLocalSession('board-file-owner-iso');
      const outsider = await bootstrapLocalSession('board-file-outsider');
      const roomId = 'board-file-isolation-room';
      expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
        method: 'POST',
        headers: { Origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({ elements: [] }),
      })).status).toBe(200);

      const bytes = new Uint8Array([1, 2, 3, 4]);
      expect((await authenticatedFetch(
        `/api/whiteboard/room/${roomId}/files/private-file-1`,
        owner,
        {
          method: 'PUT',
          headers: { Origin: BASE, 'content-type': 'image/png', 'content-length': String(bytes.length) },
          body: bytes,
        },
      )).status).toBe(201);

      // A session alone must not be enough: the grant is what gates the bytes,
      // or one room's pictures are readable by anyone who can guess a URL.
      const stolen = await authenticatedFetch(
        `/api/whiteboard/room/${roomId}/files/private-file-1`,
        outsider,
      );
      expect(stolen.status).toBe(403);
      expect(stolen.headers.get('content-type')).not.toContain('image/');
    });

    it('refuses SVG, which would be script running from our own origin', async () => {
      const owner = await bootstrapLocalSession('board-file-svg');
      const roomId = 'board-file-svg-room';
      await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
        method: 'POST',
        headers: { Origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({ elements: [] }),
      });

      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
      const refused = await authenticatedFetch(
        `/api/whiteboard/room/${roomId}/files/svg-attempt`,
        owner,
        {
          method: 'PUT',
          headers: { Origin: BASE, 'content-type': 'image/svg+xml', 'content-length': String(svg.length) },
          body: svg,
        },
      );
      expect(refused.status).toBe(415);
    });
  });
});

function teacherRoomIds(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const rooms = (body as { rooms?: unknown }).rooms;
  if (!Array.isArray(rooms)) return [];
  return rooms.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (typeof entry === 'object' && entry !== null && 'roomId' in entry) {
      const id = (entry as { roomId: unknown }).roomId;
      return typeof id === 'string' ? [id] : [];
    }
    return [];
  });
}

async function waitForTeacherRooms(
  session: Awaited<ReturnType<typeof bootstrapLocalSession>>,
  query = '',
): Promise<{ status: number; headers: Headers; body: unknown }> {
  let last: { status: number; headers: Headers; body: unknown } | null = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await authenticatedFetch(`/api/whiteboard/rooms${query}`, session);
    const body = await response.json().catch(() => null);
    last = { status: response.status, headers: response.headers, body };
    if (response.status !== 404 && response.ok) return last;
    if (response.status === 404 && attempt === 7) return last;
  }
  return last!;
}

async function waitForTeacherRoomName(
  session: Awaited<ReturnType<typeof bootstrapLocalSession>>,
  roomId: string,
  name: string,
): Promise<{ roomId: string; name: unknown } | undefined> {
  let last: { roomId: string; name: unknown } | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const listed = await waitForTeacherRooms(session);
    const rooms = typeof listed.body === 'object' && listed.body !== null
      ? (listed.body as { rooms?: unknown }).rooms
      : null;
    if (Array.isArray(rooms)) {
      const match = rooms.find((entry) => (
        typeof entry === 'object'
        && entry !== null
        && (entry as { roomId?: unknown }).roomId === roomId
      )) as { roomId: string; name: unknown } | undefined;
      last = match;
      if (match?.name === name) return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return last;
}
