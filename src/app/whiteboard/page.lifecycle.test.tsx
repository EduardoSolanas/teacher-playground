import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import TeacherRoomsPanel from './TeacherRoomsPanel';
import {
  createTeacherRoom,
  loadTeacherRooms,
  parseTeacherRooms,
  rateLimitMessage,
  type AjaxFetch,
} from '@/lib/whiteboard/teacherRooms';

/*
 * No test doubles live here: the pure rules are checked with real values and
 * real `Response` objects, and the panel is driven with plain async functions
 * that return those responses.
 */
function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const closedSettings = {
  guestAccess: false,
  guestPin: null,
  guestPinExpiresAt: null,
  lockoutUntil: null,
};

describe('teacher rooms model', () => {
  it('parses rooms, keeping only string ids and numeric timestamps', () => {
    expect(parseTeacherRooms({
      rooms: [
        { roomId: 'room-alpha', name: 'Algebra', createdAt: 100, updatedAt: 200, extra: true },
        { roomId: 'room-beta' },
        { roomId: 7 },
        null,
      ],
    })).toEqual([
      { roomId: 'room-alpha', name: 'Algebra', createdAt: 100, updatedAt: 200 },
      { roomId: 'room-beta', name: null, createdAt: undefined, updatedAt: undefined },
    ]);
  });

  it('reads the Retry-After wait from a real 429 response', () => {
    expect(rateLimitMessage(new Response(null, { status: 429, headers: { 'Retry-After': '30' } })))
      .toBe('Too many rooms created. Wait 30 seconds and try again.');
    expect(rateLimitMessage(new Response(null, { status: 429, headers: { 'Retry-After': '1' } })))
      .toBe('Too many rooms created. Wait 1 second and try again.');
    expect(rateLimitMessage(new Response(null, { status: 429 })))
      .toBe('Too many rooms created. Please wait a minute and try again.');
  });

  it('returns null when the rooms read fails or the request rejects', async () => {
    const failing: AjaxFetch = async () => new Response('nope', { status: 500 });
    const rejecting: AjaxFetch = async () => { throw new Error('offline'); };
    const ok: AjaxFetch = async () => jsonResponse(200, {
      rooms: [{ roomId: 'room-alpha', updatedAt: 5 }],
    });

    expect(await loadTeacherRooms(failing)).toBeNull();
    expect(await loadTeacherRooms(rejecting)).toBeNull();
    expect(await loadTeacherRooms(ok)).toEqual([
      { roomId: 'room-alpha', name: null, createdAt: undefined, updatedAt: 5 },
    ]);
  });

  it('creates the room and its settings in one POST', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (method === 'POST') return jsonResponse(201, { hasCreatorGrant: true });
      return new Response(null, { status: 404 });
    };

    const outcome = await createTeacherRoom({
      request,
      roomId: 'room-new',
      hostPeerId: 'peer-host',
      maxUsers: 2,
      name: 'Geometry',
    });

    expect(outcome).toEqual({ ok: true, roomId: 'room-new' });
    expect(calls).toEqual([
      {
        url: '/api/whiteboard/room/room-new',
        method: 'POST',
        body: {
          elements: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          maxUsers: 2,
          hostPeerId: 'peer-host',
          name: 'Geometry',
        },
      },
    ]);
  });

  it('does not clean up after a create that never got an answer', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const request: AjaxFetch = async (input, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ url: String(input), method });
      if (method === 'POST') throw new Error('create network');
      return new Response(null, { status: 404 });
    };

    const outcome = await createTeacherRoom({
      request,
      roomId: 'room-new',
      hostPeerId: 'peer-host',
      maxUsers: 2,
    });

    expect(outcome).toEqual({ ok: false, message: 'Room creation failed. Please try again.' });
    expect(calls).toEqual([{ url: '/api/whiteboard/room/room-new', method: 'POST' }]);
  });

  it('sends the name only when one was typed', async () => {
    const bodies: unknown[] = [];
    const request: AjaxFetch = async (input, init) => {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        return jsonResponse(201, { hasCreatorGrant: true });
      }
      return new Response(null, { status: 404 });
    };

    await createTeacherRoom({
      request,
      roomId: 'room-new',
      hostPeerId: 'peer-host',
      maxUsers: 2,
    });
    await createTeacherRoom({
      request,
      roomId: 'room-two',
      hostPeerId: 'peer-host',
      maxUsers: 2,
      name: 'Geometry',
    });

    expect(bodies).toEqual([
      {
        elements: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        maxUsers: 2,
        hostPeerId: 'peer-host',
      },
      {
        elements: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        maxUsers: 2,
        hostPeerId: 'peer-host',
        name: 'Geometry',
      },
    ]);
  });
});

describe('TeacherRoomsPanel', () => {
  it('shows a retryable load error when the first rooms read fails, and unlocks Create after Retry', async () => {
    let reads = 0;
    const request: AjaxFetch = async (input) => {
      if (String(input) === '/api/whiteboard/rooms') {
        reads += 1;
        return reads === 1
          ? new Response('boom', { status: 500 })
          : jsonResponse(200, { rooms: [] });
      }
      return new Response(null, { status: 404 });
    };

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-error')).toBeTruthy();
    });
    expect(screen.queryByTestId('whiteboard-room-list-empty')).toBeNull();
    expect(screen.getByTestId('whiteboard-create-room-btn')).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByTestId('whiteboard-room-list-retry'));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-empty')).toBeTruthy();
    });
    expect(screen.queryByTestId('whiteboard-room-list-error')).toBeNull();
    expect(screen.getByTestId('whiteboard-create-room-btn')).toHaveProperty('disabled', false);
    expect(reads).toBe(2);
  });

  it('shows the load error when the rooms request rejects outright', async () => {
    const request: AjaxFetch = async () => { throw new Error('offline'); };

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-error')).toBeTruthy();
    });
    expect(screen.queryByTestId('whiteboard-room-list-empty')).toBeNull();
  });

  it('creates the room when the create form is submitted', async () => {
    const opened: string[] = [];
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/whiteboard/rooms') return jsonResponse(200, { rooms: [] });
      if (init?.method === 'POST') return jsonResponse(201, { hasCreatorGrant: true });
      return new Response(null, { status: 404 });
    };

    render(
      <TeacherRoomsPanel
        request={request}
        onOpen={(roomId) => { opened.push(roomId); }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-create-room-btn')).toHaveProperty('disabled', false);
    });

    const form = screen.getByTestId('whiteboard-new-room-form');
    expect(form.tagName).toBe('FORM');
    expect(screen.getByTestId('whiteboard-create-room-btn').getAttribute('type')).toBe('submit');

    fireEvent.submit(form);

    await waitFor(() => {
      expect(opened).toHaveLength(1);
    });
    expect(opened[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('shows the create failure and does not attempt a follow-up delete', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const opened: string[] = [];
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/api/whiteboard/rooms') return jsonResponse(200, { rooms: [] });
      if (method === 'POST') return new Response('bad', { status: 500 });
      return new Response(null, { status: 404 });
    };

    render(
      <TeacherRoomsPanel
        request={request}
        onOpen={(roomId) => { opened.push(roomId); }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-create-room-btn')).toHaveProperty('disabled', false);
    });

    fireEvent.click(screen.getByTestId('whiteboard-create-room-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-create-room-error').textContent).toMatch(/failed/i);
    });
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(opened).toHaveLength(0);
  });

  it('tells the teacher how long to wait when create is rate limited', async () => {
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/whiteboard/rooms') return jsonResponse(200, { rooms: [] });
      if (init?.method === 'POST') {
        return jsonResponse(429, { error: 'Too many requests' }, { 'Retry-After': '30' });
      }
      return new Response(null, { status: 404 });
    };

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-create-room-btn')).toHaveProperty('disabled', false);
    });

    fireEvent.click(screen.getByTestId('whiteboard-create-room-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-create-room-error').textContent)
        .toMatch(/wait 30 seconds/i);
    });
  });

  it('does not spend the local create budget on failed attempts', async () => {
    let createPosts = 0;
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/whiteboard/rooms') return jsonResponse(200, { rooms: [] });
      if (init?.method === 'POST' && !url.endsWith('/settings')) {
        createPosts += 1;
        return new Response('boom', { status: 500 });
      }
      return new Response(null, { status: 404 });
    };

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-create-room-btn')).toHaveProperty('disabled', false);
    });

    const button = screen.getByTestId('whiteboard-create-room-btn');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      fireEvent.click(button);
      await waitFor(() => {
        expect(button).toHaveProperty('disabled', false);
      });
    }
    fireEvent.click(button);
    await waitFor(() => {
      expect(createPosts).toBe(11);
    });
  });

  it('displays the last-used date the rooms API reports', async () => {
    const updatedAt = Date.now() - 2 * 60 * 60 * 1000;
    const createdAt = updatedAt - 24 * 60 * 60 * 1000;
    const request: AjaxFetch = async (input) => {
      const url = String(input);
      if (url === '/api/whiteboard/rooms') {
        return jsonResponse(200, {
          rooms: [{ roomId: 'room-one', name: 'Algebra', createdAt, updatedAt }],
        });
      }
      if (url === '/api/whiteboard/room/room-one/settings') {
        return jsonResponse(200, closedSettings);
      }
      return new Response(null, { status: 404 });
    };

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-item-room-one')).toBeTruthy();
    });

    const date = screen.getByTestId('whiteboard-room-date-room-one').textContent ?? '';
    expect(date).toContain('Last used');
    expect(date).toContain('2h ago');
  });
});
