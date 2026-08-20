import { afterEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import { RoomDO } from './do/RoomDO';
import { issueGuestPin } from './lib/whiteboard/guestPin';
import { GUEST_SESSION_COOKIE_NAME } from './lib/identity/sessionStore';
import { MAX_BODY_BYTES } from './lib/worker/requestGuard';
import { accessFetch, authenticatedFetch, bootstrapLocalSession } from './test/workerAuth';
import { resetAuthEventWriterForTests, setAuthEventWriterForTests } from './worker';

const TEACHER = 'https://example.com';
const GUEST = 'https://join.example.com';
const HEX_ROOM = 'aabbccddeeff00112233445566778899';

describe('Task 8a — host dispatch', () => {
  afterEach(() => {
    resetAuthEventWriterForTests();
  });

  it('returns 401 JSON for /api/... on the teacher host with no Access JWT', async () => {
    const response = await SELF.fetch(`${TEACHER}/api/whiteboard/room/no-jwt-host-dispatch`);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('still serves teacher marketing pages without a JWT', async () => {
    const response = await SELF.fetch(`${TEACHER}/`);
    expect(response.status).toBe(200);
  });

  it('still issues a teacher session on the teacher host', async () => {
    const session = await bootstrapLocalSession('host-dispatch-teacher-session');
    const current = await authenticatedFetch('/auth/session/current', session);
    expect(current.status).toBe(200);
  });

  it('returns 404 for POST /auth/guest on the teacher host, including with a valid JWT', async () => {
    const missingJwt = await SELF.fetch(`${TEACHER}/auth/guest`, {
      method: 'POST',
      headers: {
        Origin: TEACHER,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ roomId: HEX_ROOM, pin: '123456', displayName: 'Ada' }),
    });
    expect(missingJwt.status).toBe(404);

    const withJwt = await accessFetch('/auth/guest', 'host-dispatch-teacher-guest', 'valid', {
      method: 'POST',
      headers: {
        Origin: TEACHER,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ roomId: HEX_ROOM, pin: '123456', displayName: 'Ada' }),
    });
    expect(withJwt.status).toBe(404);
  });

  it('serves the guest-host room page even with a deliberately invalid Access JWT', async () => {
    const response = await SELF.fetch(`${GUEST}/whiteboard/${HEX_ROOM}`, {
      method: 'GET',
      headers: { 'Cf-Access-Jwt-Assertion': 'not-a-valid-jwt' },
    });
    expect(response.status).not.toBe(401);
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      expect(await response.json()).not.toEqual({ error: 'Unauthorized' });
    }
  });

  it('returns 404 for teacher-only paths on the guest host', async () => {
    for (const path of ['/auth/session', '/api/whiteboard/rooms', '/']) {
      const response = await SELF.fetch(`${GUEST}${path}`, {
        headers: { 'Cf-Access-Jwt-Assertion': 'not-a-valid-jwt' },
      });
      expect(response.status, path).toBe(404);
    }
  });

  it('returns 404 for an unknown hostname', async () => {
    const response = await SELF.fetch(`https://evil.example.com/whiteboard/${HEX_ROOM}`, {
      method: 'GET',
      headers: { 'Cf-Access-Jwt-Assertion': 'not-a-valid-jwt' },
    });
    expect(response.status).toBe(404);
  });
});

function hexRoomId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

async function createTeacherRoom(subject: string): Promise<{ roomId: string; owner: Awaited<ReturnType<typeof bootstrapLocalSession>> }> {
  const owner = await bootstrapLocalSession(subject);
  const roomId = hexRoomId();
  const created = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
    method: 'POST',
    headers: { Origin: TEACHER, 'content-type': 'application/json' },
    body: JSON.stringify({ elements: [] }),
  });
  expect(created.status).toBe(200);
  return { roomId, owner };
}

async function pinForRoom(roomId: string): Promise<string> {
  return runInDurableObject(
    env.ROOMS.get(env.ROOMS.idFromName(roomId)),
    (instance: RoomDO) => issueGuestPin(instance.db, roomId, Date.now()),
  );
}

function guestAuthInit(body: unknown, headers: HeadersInit = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      Origin: GUEST,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

describe('Task 8b — POST /auth/guest', () => {
  afterEach(() => {
    resetAuthEventWriterForTests();
  });

  it('issues a guest session cookie for a valid PIN on the guest host', async () => {
    const { roomId } = await createTeacherRoom('guest-auth-valid-pin');
    const pin = await pinForRoom(roomId);
    const response = await SELF.fetch(`${GUEST}/auth/guest`, guestAuthInit({
      roomId,
      pin,
      displayName: 'Ada',
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('set-cookie')).toContain(`${GUEST_SESSION_COOKIE_NAME}=`);
  });

  it('returns byte-identical 403 bodies for wrong PIN, guest off, and lockout', async () => {
    const { roomId: wrongPinRoom } = await createTeacherRoom('guest-auth-wrong-pin');
    await pinForRoom(wrongPinRoom);
    const wrong = await SELF.fetch(`${GUEST}/auth/guest`, guestAuthInit({
      roomId: wrongPinRoom,
      pin: '000000',
      displayName: 'Ada',
    }));

    const { roomId: disabledRoom } = await createTeacherRoom('guest-auth-disabled');
    const disabled = await SELF.fetch(`${GUEST}/auth/guest`, guestAuthInit({
      roomId: disabledRoom,
      pin: '123456',
      displayName: 'Ada',
    }));

    const { roomId: lockedRoom } = await createTeacherRoom('guest-auth-lockout');
    const lockedPin = await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(lockedRoom)),
      (instance: RoomDO) => {
        const pin = issueGuestPin(instance.db, lockedRoom, Date.now());
        instance.db.prepare(
          'UPDATE rooms SET guest_lockout_until = ? WHERE room_id = ?',
        ).run(Date.now() + 15 * 60 * 1000, lockedRoom);
        return pin;
      },
    );
    const locked = await SELF.fetch(`${GUEST}/auth/guest`, guestAuthInit({
      roomId: lockedRoom,
      pin: lockedPin,
      displayName: 'Ada',
    }));

    expect(wrong.status).toBe(403);
    expect(disabled.status).toBe(403);
    expect(locked.status).toBe(403);
    const wrongBody = await wrong.text();
    const disabledBody = await disabled.text();
    const lockedBody = await locked.text();
    expect(wrongBody).toBe(disabledBody);
    expect(wrongBody).toBe(lockedBody);
  });

  it('rejects missing Origin and a teacher-host Origin on the guest URL', async () => {
    const { roomId } = await createTeacherRoom('guest-auth-origin');
    const pin = await pinForRoom(roomId);
    const body = { roomId, pin, displayName: 'Ada' };

    const missing = await SELF.fetch(`${GUEST}/auth/guest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: 'Origin required' });

    const teacherOrigin = await SELF.fetch(`${GUEST}/auth/guest`, {
      method: 'POST',
      headers: {
        Origin: TEACHER,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(teacherOrigin.status).toBe(403);
    expect(await teacherOrigin.json()).toEqual({ error: 'Origin required' });
  });

  it('rejects non-POST with 405', async () => {
    const response = await SELF.fetch(`${GUEST}/auth/guest`, {
      method: 'GET',
      headers: { Origin: GUEST },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('rejects an oversized body with 413', async () => {
    const response = await SELF.fetch(`${GUEST}/auth/guest`, {
      method: 'POST',
      headers: {
        Origin: GUEST,
        'content-type': 'application/json',
        'content-length': String(MAX_BODY_BYTES + 1),
      },
      body: JSON.stringify({ roomId: HEX_ROOM, pin: '123456', displayName: 'Ada' }),
    });
    expect(response.status).toBe(413);
  });

  it('rejects a non-JSON content type with 415', async () => {
    const response = await SELF.fetch(`${GUEST}/auth/guest`, {
      method: 'POST',
      headers: {
        Origin: GUEST,
        'content-type': 'text/plain',
      },
      body: 'roomId=x',
    });
    expect(response.status).toBe(415);
  });

  it('never writes the PIN into auth events', async () => {
    const lines: string[] = [];
    setAuthEventWriterForTests((line) => lines.push(line));
    const { roomId } = await createTeacherRoom('guest-auth-pin-log');
    const distinctivePin = '654321';
    await pinForRoom(roomId);
    const response = await SELF.fetch(`${GUEST}/auth/guest`, guestAuthInit({
      roomId,
      pin: distinctivePin,
      displayName: 'Ada',
    }));
    expect(response.status).toBe(403);
    expect(lines.join('\n')).not.toContain(distinctivePin);
  });

  it('rate-limits POST /auth/guest per CF-Connecting-IP at 5 per minute', async () => {
    const { roomId } = await createTeacherRoom('guest-auth-rate');
    await pinForRoom(roomId);
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const attempt = () => SELF.fetch(`${GUEST}/auth/guest`, guestAuthInit(
      { roomId, pin: '000000', displayName: 'Ada' },
      { 'CF-Connecting-IP': ip, 'x-test-strict-rate-limit': '1' },
    ));

    for (let index = 0; index < 5; index += 1) {
      const response = await attempt();
      expect(response.status, `attempt ${index}`).toBe(403);
    }
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect(await limited.json()).toEqual({ error: 'Too many requests' });
  });
});

async function issueGuestCookie(roomId: string, displayName = 'Ada'): Promise<string> {
  const pin = await pinForRoom(roomId);
  const response = await SELF.fetch(`${GUEST}/auth/guest`, guestAuthInit({
    roomId,
    pin,
    displayName,
  }));
  expect(response.status).toBe(200);
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return setCookie!.split(';', 1)[0];
}

describe('Task 8c — guest API forwarding', () => {
  afterEach(() => {
    resetAuthEventWriterForTests();
  });

  it('returns 401 on the guest host room API when no guest cookie is present', async () => {
    const { roomId } = await createTeacherRoom('guest-api-no-cookie');
    const response = await SELF.fetch(`${GUEST}/api/whiteboard/room/${roomId}/access`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 before RoomDO when a guest session for room A is used on room B', async () => {
    const { roomId: roomA } = await createTeacherRoom('guest-api-cross-a');
    const cookie = await issueGuestCookie(roomA);
    const roomB = hexRoomId();
    const response = await SELF.fetch(`${GUEST}/api/whiteboard/room/${roomB}/access`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('forwards a room-bound guest session to GET /access', async () => {
    const { roomId } = await createTeacherRoom('guest-api-access');
    const cookie = await issueGuestCookie(roomId);
    const response = await SELF.fetch(`${GUEST}/api/whiteboard/room/${roomId}/access`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { status?: string };
    expect(typeof body.status).toBe('string');
  });

  it('still 404s guest-verify on the guest host even with a guest session', async () => {
    const { roomId } = await createTeacherRoom('guest-api-verify-404');
    const cookie = await issueGuestCookie(roomId);
    const response = await SELF.fetch(`${GUEST}/api/whiteboard/room/${roomId}/guest-verify`, {
      method: 'POST',
      headers: {
        Origin: GUEST,
        Cookie: cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ pin: '123456' }),
    });
    expect(response.status).toBe(404);
  });

  it('does not let a teacher client stamp guest=1 onto a teacher request', async () => {
    const { roomId, owner } = await createTeacherRoom('guest-stamp-teacher');
    const settings = await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/settings?guest=1`,
      owner,
    );
    expect(settings.status).toBe(200);
  });
});
