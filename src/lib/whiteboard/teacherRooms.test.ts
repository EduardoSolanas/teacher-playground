import { describe, expect, it } from 'vitest';

import {
  createTeacherRoom,
  deleteTeacherRoom,
  loadTeacherRooms,
  parseTeacherRooms,
  rateLimitMessage,
  type AjaxFetch,
} from './teacherRooms';

describe('parseTeacherRooms', () => {
  it('returns an empty list for payloads that are not room lists', () => {
    expect(parseTeacherRooms(null)).toEqual([]);
    expect(parseTeacherRooms('rooms')).toEqual([]);
    expect(parseTeacherRooms({ rooms: 'nope' })).toEqual([]);
    expect(parseTeacherRooms({ rooms: {} })).toEqual([]);
    expect(parseTeacherRooms({})).toEqual([]);
  });

  it('skips entries that are not objects and entries without a room id', () => {
    expect(parseTeacherRooms([null, 'x', 7, {}, { roomId: '' }, { roomId: 9 }])).toEqual([]);
  });

  it('normalizes optional fields and keeps only string names and numeric timestamps', () => {
    expect(
      parseTeacherRooms([
        { roomId: 'a', name: 'Algebra', createdAt: 10, updatedAt: 20 },
        { roomId: 'b', name: 7, createdAt: '10', updatedAt: null },
        { roomId: 'c' },
      ]),
    ).toEqual([
      { roomId: 'a', name: 'Algebra', createdAt: 10, updatedAt: 20 },
      { roomId: 'b', name: null, createdAt: undefined, updatedAt: undefined },
      { roomId: 'c', name: null, createdAt: undefined, updatedAt: undefined },
    ]);
  });
});

describe('loadTeacherRooms', () => {
  it('returns null when the read fails', async () => {
    const request: AjaxFetch = async () => new Response('{}', { status: 500 });
    expect(await loadTeacherRooms(request)).toBeNull();
  });

  it('parses a real rooms response', async () => {
    const request: AjaxFetch = async () =>
      Response.json({ rooms: [{ roomId: 'a', name: 'Algebra' }] });
    expect(await loadTeacherRooms(request)).toEqual([
      { roomId: 'a', name: 'Algebra', createdAt: undefined, updatedAt: undefined },
    ]);
  });
});

describe('rateLimitMessage', () => {
  it('falls back to the generic wording without a usable Retry-After', () => {
    expect(rateLimitMessage(new Response('', { status: 429 }))).toBe(
      'Too many rooms created. Please wait a minute and try again.',
    );
    expect(rateLimitMessage(new Response('', { status: 429, headers: { 'Retry-After': '0' } }))).toBe(
      'Too many rooms created. Please wait a minute and try again.',
    );
    expect(rateLimitMessage(new Response('', { status: 429, headers: { 'Retry-After': 'nope' } }))).toBe(
      'Too many rooms created. Please wait a minute and try again.',
    );
  });

  it('rounds a wait up and pluralizes it', () => {
    expect(rateLimitMessage(new Response('', { status: 429, headers: { 'Retry-After': '1' } }))).toBe(
      'Too many rooms created. Wait 1 second and try again.',
    );
    expect(rateLimitMessage(new Response('', { status: 429, headers: { 'Retry-After': '2.5' } }))).toBe(
      'Too many rooms created. Wait 3 seconds and try again.',
    );
  });
});

describe('deleteTeacherRoom', () => {
  it('re-confirms the session and retries once after a 403', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/auth/session/confirm') return new Response('', { status: 200 });
      return new Response('', { status: calls.filter((call) => call.url.includes('/room/')).length === 1 ? 403 : 200 });
    };

    const response = await deleteTeacherRoom(request, 'room-1');

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { url: '/api/whiteboard/room/room-1', method: 'DELETE' },
      { url: '/auth/session/confirm', method: 'POST' },
      { url: '/api/whiteboard/room/room-1', method: 'DELETE' },
    ]);
  });

  it('returns the original 403 when the session cannot be confirmed', async () => {
    let deletes = 0;
    const request: AjaxFetch = async (input) => {
      if (String(input) === '/auth/session/confirm') return new Response('', { status: 401 });
      deletes += 1;
      return new Response('', { status: 403 });
    };

    const response = await deleteTeacherRoom(request, 'room-1');

    expect(response.status).toBe(403);
    expect(deletes).toBe(1);
  });

  it('does not confirm the session for a successful delete', async () => {
    const calls: string[] = [];
    const request: AjaxFetch = async (input) => {
      calls.push(String(input));
      return new Response('', { status: 200 });
    };

    const response = await deleteTeacherRoom(request, 'room-1');

    expect(response.status).toBe(200);
    expect(calls).toEqual(['/api/whiteboard/room/room-1']);
  });
});

describe('createTeacherRoom', () => {
  it('sends a JSON content type with the optional name omitted when blank', async () => {
    let sentBody: Record<string, unknown> | undefined;
    let sentContentType: string | null = null;
    const request: AjaxFetch = async (_input, init) => {
      sentContentType = new Headers(init?.headers).get('Content-Type');
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ success: true });
    };

    const outcome = await createTeacherRoom({
      request,
      roomId: 'room-1',
      hostPeerId: 'peer-1',
      maxUsers: 2,
    });

    expect(outcome).toEqual({ ok: true, roomId: 'room-1' });
    expect(sentContentType).toBe('application/json');
    expect(sentBody).toEqual({
      elements: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      maxUsers: 2,
      hostPeerId: 'peer-1',
    });
  });

  it('carries a named room through', async () => {
    let sentBody: Record<string, unknown> | undefined;
    const request: AjaxFetch = async (_input, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ success: true });
    };

    await createTeacherRoom({
      request,
      roomId: 'room-1',
      hostPeerId: 'peer-1',
      maxUsers: 2,
      name: 'Algebra',
    });

    expect(sentBody).toMatchObject({ name: 'Algebra' });
  });

  it('explains the free-plan limit on 402', async () => {
    const request: AjaxFetch = async () => new Response('', { status: 402 });

    expect(await createTeacherRoom({
      request,
      roomId: 'room-1',
      hostPeerId: 'peer-1',
      maxUsers: 2,
    })).toEqual({
      ok: false,
      message: 'Free accounts can keep one room. Delete it to create another.',
    });
  });

  it('carries the Retry-After wait on 429', async () => {
    const request: AjaxFetch = async () =>
      new Response('', { status: 429, headers: { 'Retry-After': '2' } });

    expect(await createTeacherRoom({
      request,
      roomId: 'room-1',
      hostPeerId: 'peer-1',
      maxUsers: 2,
    })).toEqual({
      ok: false,
      message: 'Too many rooms created. Wait 2 seconds and try again.',
    });
  });

  it('reports a generic failure for other statuses and for a transport error', async () => {
    const denied: AjaxFetch = async () => new Response('', { status: 500 });
    const broken: AjaxFetch = async () => {
      throw new Error('offline');
    };

    expect(await createTeacherRoom({
      request: denied,
      roomId: 'room-1',
      hostPeerId: 'peer-1',
      maxUsers: 2,
    })).toEqual({ ok: false, message: 'Room creation failed. Please try again.' });
    expect(await createTeacherRoom({
      request: broken,
      roomId: 'room-1',
      hostPeerId: 'peer-1',
      maxUsers: 2,
    })).toEqual({ ok: false, message: 'Room creation failed. Please try again.' });
  });
});
