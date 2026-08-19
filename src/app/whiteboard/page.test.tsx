import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const push = vi.fn();
const assign = vi.fn();
const ajaxFetch = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@/lib/http/ajaxFetch', () => ({
  ajaxFetch: (...args: unknown[]) => ajaxFetch(...args),
}));

vi.mock('@/lib/crypto/randomId', () => ({
  generateRoomId: () => 'new-room',
}));

vi.mock('@/lib/whiteboard/peerId', () => ({
  getStablePeerId: () => 'peer-host',
}));

import WhiteboardRoute from './page';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

describe('WhiteboardRoute room list', () => {
  beforeEach(() => {
    push.mockReset();
    assign.mockReset();
    ajaxFetch.mockReset();
    vi.stubGlobal('location', { assign });
  });

  it('loads rooms from GET /api/whiteboard/rooms and keeps create/join', async () => {
    ajaxFetch.mockResolvedValue(
      jsonResponse({
        rooms: [
          { roomId: 'room-alpha', name: 'Algebra' },
          { roomId: 'room-beta' },
        ],
      }),
    );

    const { container } = render(<WhiteboardRoute />);

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-item-room-alpha')).toBeTruthy();
    });

    expect(ajaxFetch).toHaveBeenCalledWith('/api/whiteboard/rooms');
    expect(screen.getByRole('heading', { level: 2, name: 'Your rooms' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
    expect(screen.getByTestId('whiteboard-create-room-btn')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-room-name-input')).toBeTruthy();
  });

  it('opens a listed room via the router', async () => {
    ajaxFetch.mockResolvedValue(
      jsonResponse({
        rooms: [{ roomId: 'room-alpha', name: 'Algebra' }],
      }),
    );

    render(<WhiteboardRoute />);

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-item-room-alpha')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('link', { name: /Algebra/ }));
    expect(assign).toHaveBeenCalledWith('/whiteboard/room-alpha');
    expect(push).not.toHaveBeenCalled();
  });

  it('renames an unnamed room via settings POST then refreshes the list', async () => {
    ajaxFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/whiteboard/rooms' && (!init || !init.method || init.method === 'GET')) {
        if (ajaxFetch.mock.calls.filter((call) => call[0] === '/api/whiteboard/rooms').length > 1) {
          return Promise.resolve(
            jsonResponse({
              rooms: [{ roomId: 'room-beta', name: 'Geometry', createdAt: 1_700_000_000_000 }],
            }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            rooms: [{ roomId: 'room-beta', createdAt: 1_700_000_000_000 }],
          }),
        );
      }
      if (url === '/api/whiteboard/room/room-beta/settings' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse({}, false));
    });

    render(<WhiteboardRoute />);

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-item-room-beta')).toBeTruthy();
    });

    expect(screen.getByTestId('whiteboard-create-room-btn')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-room-name-input')).toBeTruthy();

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-beta'));
    fireEvent.click(screen.getByTestId('whiteboard-room-rename-room-beta'));
    fireEvent.change(screen.getByTestId('whiteboard-room-name-input-room-beta'), {
      target: { value: 'Geometry' },
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-name-save-room-beta'));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-item-room-beta').textContent).toContain(
        'Geometry',
      );
    });

    const settingsCall = ajaxFetch.mock.calls.find(
      (call) => call[0] === '/api/whiteboard/room/room-beta/settings',
    );
    expect(settingsCall?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(settingsCall?.[1]?.body))).toEqual({ name: 'Geometry' });
    expect(push).not.toHaveBeenCalled();
  });

  it('creates a room then assigns the real room URL', async () => {
    ajaxFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/whiteboard/rooms') {
        return Promise.resolve(jsonResponse({ rooms: [] }));
      }
      if (init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse({}, false));
    });

    render(<WhiteboardRoute />);
    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-create-room-btn')).toHaveProperty('disabled', false);
    });
    fireEvent.click(screen.getByTestId('whiteboard-create-room-btn'));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/whiteboard/new-room');
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('defaults people allowed to host plus one student', async () => {
    ajaxFetch.mockResolvedValue(jsonResponse({ rooms: [] }));
    render(<WhiteboardRoute />);

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-create-room-btn')).toBeTruthy();
    });

    const people = screen.getByLabelText('People allowed') as HTMLInputElement;
    expect(people.value).toBe('2');
    expect(people.max).toBe('2');
    expect(screen.getByRole('button', { name: 'More people' })).toHaveProperty('disabled', true);
  });

  it('posts maxUsers 2 when creating a room', async () => {
    ajaxFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/whiteboard/rooms') {
        return Promise.resolve(jsonResponse({ rooms: [] }));
      }
      if (init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse({}, false));
    });

    render(<WhiteboardRoute />);
    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-create-room-btn')).toHaveProperty('disabled', false);
    });
    fireEvent.click(screen.getByTestId('whiteboard-create-room-btn'));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/whiteboard/new-room');
    });

    const settingsCall = ajaxFetch.mock.calls.find(
      (call) => typeof call[0] === 'string' && String(call[0]).endsWith('/settings'),
    );
    expect(JSON.parse(String(settingsCall?.[1]?.body))).toMatchObject({ maxUsers: 2 });
  });

  it('disables creating another room when the free plan already has one', async () => {
    ajaxFetch.mockResolvedValue(
      jsonResponse({
        rooms: [{ roomId: 'room-alpha', name: 'Algebra' }],
      }),
    );

    render(<WhiteboardRoute />);

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-list-item-room-alpha')).toBeTruthy();
    });

    expect(screen.getByTestId('whiteboard-create-room-btn')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('whiteboard-create-room-error').textContent).toMatch(/one room/i);
  });
});
