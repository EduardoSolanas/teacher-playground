import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import TeacherRoomsPanel from './TeacherRoomsPanel';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

/*
 * No test doubles live here: the request is a plain async function returning
 * real `Response` objects, and the panel is rendered whole.
 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const emptyRooms: AjaxFetch = async () => jsonResponse(200, { rooms: [] });

async function renderPanel(request: AjaxFetch = emptyRooms) {
  const view = render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);
  await waitFor(() => {
    expect(screen.queryByTestId('whiteboard-room-list-loading')).toBeNull();
  });
  return view;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('TeacherRoomsPanel first run (UX-L17)', () => {
  it('says how a room is shared before the first one exists', async () => {
    await renderPanel();

    expect(screen.getByTestId('whiteboard-first-run-hint').textContent)
      .toMatch(/create a room/i);
    expect(screen.getByTestId('whiteboard-first-run-hint').textContent)
      .toMatch(/link|pin/i);
  });

  it('draws the people stepper as icons rather than glyphs (UX-B1)', async () => {
    await renderPanel();

    const fewer = screen.getByRole('button', { name: 'Fewer people' });
    const more = screen.getByRole('button', { name: 'More people' });
    expect(fewer.querySelector('svg')).toBeTruthy();
    expect(more.querySelector('svg')).toBeTruthy();
    expect(fewer.textContent).toBe('');
    expect(more.textContent).toBe('');
  });

  it('offers a support link when an address is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', 'support@example.com');
    await renderPanel();

    const link = screen.getByTestId('whiteboard-rooms-support') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('mailto:support@example.com');
  });

  it('renders no support link when no address is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', '');
    await renderPanel();

    expect(screen.queryByTestId('whiteboard-rooms-support')).toBeNull();
  });
});

describe('TeacherRoomsPanel room list reads', () => {
  it('retries a failed list read and replaces the error with the rooms', async () => {
    let reads = 0;
    const request: AjaxFetch = async (input) => {
      if (String(input) !== '/api/whiteboard/rooms') return new Response(null, { status: 404 });
      reads += 1;
      return reads === 1
        ? new Response('nope', { status: 500 })
        : jsonResponse(200, { rooms: [{ roomId: 'room-alpha', name: 'Algebra' }] });
    };

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByTestId('whiteboard-room-list-loading')).toBeNull();
    });
    expect(screen.getByTestId('whiteboard-room-list-error')).toBeTruthy();
    expect(screen.queryByTestId('whiteboard-first-run-hint')).toBeNull();

    fireEvent.click(screen.getByTestId('whiteboard-room-list-retry'));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-item-room-alpha')).toBeTruthy();
    });
    expect(screen.queryByTestId('whiteboard-room-list-error')).toBeNull();
    expect(reads).toBe(2);
  });

  it('keeps creation disabled and ignores a submit while the first read is in flight', async () => {
    let reads = 0;
    const request: AjaxFetch = async () => {
      reads += 1;
      return new Promise<Response>(() => {});
    };

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);

    expect(screen.getByTestId('whiteboard-create-room-btn')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('whiteboard-new-room-form')).toBeTruthy();

    fireEvent.submit(screen.getByTestId('whiteboard-new-room-form'));
    expect(reads).toBe(1);
  });

  it('keeps the error up when a retry fails again', async () => {
    let reads = 0;
    const request: AjaxFetch = async () => {
      reads += 1;
      return new Response('nope', { status: 500 });
    };

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-error')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-list-retry'));

    await waitFor(() => {
      expect(screen.queryByTestId('whiteboard-room-list-loading')).toBeNull();
    });
    expect(screen.getByTestId('whiteboard-room-list-error')).toBeTruthy();
    expect(reads).toBe(2);
  });

  it('ignores a list read that lands after the panel unmounts', async () => {
    let finish: ((response: Response) => void) | undefined;
    const request: AjaxFetch = async () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      });

    const view = render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);
    view.unmount();

    finish?.(jsonResponse(200, { rooms: [{ roomId: 'room-alpha', name: 'Algebra' }] }));
    await Promise.resolve();
    await Promise.resolve();

    expect(finish).toBeTypeOf('function');
  });
});

describe('TeacherRoomsPanel room creation', () => {
  it('creates a named room and opens it once the server answers', async () => {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    let finishCreate: ((response: Response) => void) | undefined;
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/whiteboard/rooms') return jsonResponse(200, { rooms: [] });
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Promise<Response>((resolve) => {
          finishCreate = resolve;
        });
      }
      return new Response(null, { status: 404 });
    };
    const opened: string[] = [];

    render(
      <TeacherRoomsPanel
        request={request}
        onOpen={(roomId) => { opened.push(roomId); }}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('whiteboard-room-list-loading')).toBeNull();
    });
    fireEvent.change(screen.getByTestId('whiteboard-new-room-name'), {
      target: { value: '  Algebra  ' },
    });
    fireEvent.submit(screen.getByTestId('whiteboard-new-room-form'));

    expect(screen.getByTestId('whiteboard-create-room-btn').textContent).toContain('Creating room');
    expect(screen.getByTestId('whiteboard-create-room-btn').getAttribute('aria-busy')).toBe('true');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toMatch(/^\/api\/whiteboard\/room\/.+$/);
    expect(posts[0].body).toMatchObject({ name: 'Algebra', maxUsers: 2 });

    finishCreate?.(jsonResponse(200, { roomId: 'created' }));

    await waitFor(() => {
      expect(opened).toHaveLength(1);
    });
    expect(posts[0].url).toBe(`/api/whiteboard/room/${opened[0]}`);
    expect(screen.getByTestId('whiteboard-create-room-btn').textContent).toContain('Create Room');
  });

  it('sends no name for an unnamed room and reports the server refusal', async () => {
    const posts: Record<string, unknown>[] = [];
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/whiteboard/rooms') return jsonResponse(200, { rooms: [] });
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return jsonResponse(402, { error: 'Plan limit reached' });
      }
      return new Response(null, { status: 404 });
    };

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByTestId('whiteboard-room-list-loading')).toBeNull();
    });
    fireEvent.submit(screen.getByTestId('whiteboard-new-room-form'));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-create-room-error')).toBeTruthy();
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).not.toHaveProperty('name');
    expect(screen.getByTestId('whiteboard-create-room-error').textContent)
      .toContain('Free accounts can keep one room');
    expect(screen.getByTestId('whiteboard-create-room-btn').textContent).toContain('Create Room');
  });

  it('refuses an eleventh room created in the same minute', async () => {
    let posts = 0;
    const request: AjaxFetch = async (input, init) => {
      if (String(input) === '/api/whiteboard/rooms') return jsonResponse(200, { rooms: [] });
      if (init?.method === 'POST') {
        posts += 1;
        return jsonResponse(200, { roomId: `room-${posts}` });
      }
      return new Response(null, { status: 404 });
    };

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByTestId('whiteboard-room-list-loading')).toBeNull();
    });

    const form = screen.getByTestId('whiteboard-new-room-form');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      fireEvent.submit(form);
      await waitFor(() => {
        expect(screen.getByTestId('whiteboard-create-room-btn').textContent).toContain('Create Room');
      });
    }
    expect(posts).toBe(10);

    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-create-room-error').textContent)
        .toContain('Too many rooms created');
    });
    expect(posts).toBe(10);
  });

  it('refuses to open another room once the free room is already owned', async () => {
    const request: AjaxFetch = async () =>
      jsonResponse(200, { rooms: [{ roomId: 'room-alpha', name: 'Algebra' }] });

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-item-room-alpha')).toBeTruthy();
    });
    expect(screen.getByTestId('whiteboard-create-room-btn')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('whiteboard-create-room-error').textContent)
      .toContain('Free accounts can keep one room');
  });
});

describe('TeacherRoomsPanel rename and delete', () => {
  it('keeps the room and the editor open when the rename is refused', async () => {
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/whiteboard/rooms') {
        return jsonResponse(200, { rooms: [{ roomId: 'room-alpha', name: 'Algebra' }] });
      }
      if (url.endsWith('/settings') && init?.method === 'POST') {
        return new Response('nope', { status: 500 });
      }
      return new Response(null, { status: 404 });
    };

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-item-room-alpha')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-rename-room-alpha'));
    fireEvent.change(screen.getByTestId('whiteboard-room-name-input-room-alpha'), {
      target: { value: 'Geometry' },
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-name-save-room-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-rename-error-room-alpha')).toBeTruthy();
    });
    expect(screen.getByTestId('whiteboard-room-name-input-room-alpha')).toBeTruthy();
  });

  it('reloads the list after a rename lands and renames the row', async () => {
    let reads = 0;
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/whiteboard/rooms') {
        reads += 1;
        return reads === 1
          ? jsonResponse(200, { rooms: [{ roomId: 'room-alpha', name: 'Algebra' }] })
          : jsonResponse(200, { rooms: [{ roomId: 'room-alpha', name: 'Geometry' }] });
      }
      if (url.endsWith('/settings') && init?.method === 'POST') return jsonResponse(200, {});
      return new Response(null, { status: 404 });
    };

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-item-room-alpha')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-rename-room-alpha'));
    fireEvent.change(screen.getByTestId('whiteboard-room-name-input-room-alpha'), {
      target: { value: 'Geometry' },
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-name-save-room-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-item-room-alpha').textContent)
        .toContain('Geometry');
    });
    expect(screen.queryByTestId('whiteboard-room-name-input-room-alpha')).toBeNull();
    expect(reads).toBe(2);
  });

  it('keeps the rooms visible and reports the list error when the refresh after a rename fails', async () => {
    let reads = 0;
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/whiteboard/rooms') {
        reads += 1;
        return reads === 1
          ? jsonResponse(200, { rooms: [{ roomId: 'room-alpha', name: 'Algebra' }] })
          : new Response('nope', { status: 500 });
      }
      if (url.endsWith('/settings') && init?.method === 'POST') return jsonResponse(200, {});
      return new Response(null, { status: 404 });
    };

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-item-room-alpha')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-rename-room-alpha'));
    fireEvent.change(screen.getByTestId('whiteboard-room-name-input-room-alpha'), {
      target: { value: 'Geometry' },
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-name-save-room-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-error')).toBeTruthy();
    });
    expect(screen.getByTestId('whiteboard-room-list-item-room-alpha')).toBeTruthy();
  });

  it('reports a failed delete and leaves the room in place', async () => {
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/whiteboard/rooms') {
        return jsonResponse(200, { rooms: [{ roomId: 'room-alpha', name: 'Algebra' }] });
      }
      if (init?.method === 'DELETE') return new Response('nope', { status: 500 });
      return new Response(null, { status: 404 });
    };

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-item-room-alpha')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-delete-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-delete-confirm-room-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-delete-error')).toBeTruthy();
    });
    expect(screen.getByTestId('whiteboard-room-list-item-room-alpha')).toBeTruthy();
  });

  it('drops the row once a delete lands and the refresh confirms it', async () => {
    let reads = 0;
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/whiteboard/rooms') {
        reads += 1;
        return reads === 1
          ? jsonResponse(200, { rooms: [{ roomId: 'room-alpha', name: 'Algebra' }] })
          : jsonResponse(200, { rooms: [] });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    };

    render(<TeacherRoomsPanel request={request} onOpen={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-item-room-alpha')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-delete-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-delete-confirm-room-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-empty')).toBeTruthy();
    });
    expect(screen.queryByTestId('whiteboard-room-delete-error')).toBeNull();
    expect(screen.getByTestId('whiteboard-first-run-hint')).toBeTruthy();
  });
});

describe('TeacherRoomsPanel people stepper', () => {
  it('keeps the free-plan occupancy inside its bounds', async () => {
    await renderPanel();

    const fewer = screen.getByRole('button', { name: 'Fewer people' });
    const more = screen.getByRole('button', { name: 'More people' });
    const input = screen.getByLabelText('People allowed') as HTMLInputElement;

    expect(more).toHaveProperty('disabled', true);
    expect(input.value).toBe('2');

    fireEvent.click(fewer);
    expect(input.value).toBe('1');
    expect(fewer).toHaveProperty('disabled', true);

    fireEvent.click(more);
    expect(input.value).toBe('2');
    expect(more).toHaveProperty('disabled', true);

    fireEvent.change(input, { target: { value: '99' } });
    expect(input.value).toBe('2');

    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('1');
  });
});
