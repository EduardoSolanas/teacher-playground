import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TeacherRoomList, { readGuestSettings } from './TeacherRoomList';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

/*
 * No test doubles live here: the request the component uses is a plain async
 * function returning real `Response` objects, and callbacks are real
 * functions recording into closures.
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

const closedSettingsRequest: AjaxFetch = async () => jsonResponse(200, closedSettings);

describe('readGuestSettings', () => {
  it('returns the parsed settings from a real 200 response', async () => {
    const loaded = await readGuestSettings(
      async () => jsonResponse(200, {
        guestAccess: true,
        guestPin: '004321',
        guestPinExpiresAt: 999,
        lockoutUntil: null,
      }),
      'room-alpha',
    );

    expect(loaded).toEqual({
      guestAccess: true,
      guestPin: '004321',
      guestPinExpiresAt: 999,
      lockoutUntil: null,
    });
  });

  it('returns null on a non-ok response or a rejected request', async () => {
    expect(await readGuestSettings(
      async () => new Response('nope', { status: 500 }),
      'room-alpha',
    )).toBeNull();
    expect(await readGuestSettings(
      async () => { throw new Error('offline'); },
      'room-alpha',
    )).toBeNull();
  });
});

describe('TeacherRoomList states', () => {
  it('shows a retryable error instead of the empty state when the list failed to load', () => {
    const retries: string[] = [];
    render(
      <TeacherRoomList
        rooms={[]}
        error
        onRetry={() => { retries.push('retry'); }}
        onOpen={() => {}}
        request={closedSettingsRequest}
      />,
    );

    expect(screen.getByTestId('whiteboard-room-list-error')).toBeTruthy();
    expect(screen.queryByTestId('whiteboard-room-list-empty')).toBeNull();
    fireEvent.click(screen.getByTestId('whiteboard-room-list-retry'));
    expect(retries).toHaveLength(1);
  });

  it('keeps the rooms already loaded visible when a refresh fails', () => {
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        error
        onRetry={() => {}}
        onOpen={() => {}}
        request={closedSettingsRequest}
      />,
    );

    expect(screen.getByTestId('whiteboard-room-list-error')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-room-list-item-room-alpha')).toBeTruthy();
    expect(screen.queryByTestId('whiteboard-room-list-empty')).toBeNull();
  });

  it('keeps the rename editor open and explains when the save fails', async () => {
    let attempts = 0;
    const onRename = async () => {
      attempts += 1;
      return false;
    };
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        onRename={onRename}
        request={closedSettingsRequest}
      />,
    );

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
    expect(attempts).toBe(1);
  });

  it('closes the rename editor once the save succeeds', async () => {
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        onRename={async () => true}
        request={closedSettingsRequest}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-rename-room-alpha'));
    fireEvent.change(screen.getByTestId('whiteboard-room-name-input-room-alpha'), {
      target: { value: 'Geometry' },
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-name-save-room-alpha'));

    await waitFor(() => {
      expect(screen.queryByTestId('whiteboard-room-name-input-room-alpha')).toBeNull();
    });
  });

  it('distinguishes a failed guest-settings read from "off" and retries it', async () => {
    let reads = 0;
    const request: AjaxFetch = async (input) => {
      if (String(input) === '/api/whiteboard/room/room-alpha/settings') {
        reads += 1;
        return reads === 1
          ? new Response('nope', { status: 500 })
          : jsonResponse(200, closedSettings);
      }
      return new Response(null, { status: 404 });
    };

    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        request={request}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-settings-error-room-alpha')).toBeTruthy();
    });
    expect(screen.queryByText('Not switched on')).toBeNull();

    fireEvent.click(screen.getByTestId('whiteboard-room-settings-retry-room-alpha'));

    await waitFor(() => {
      expect(screen.queryByTestId('whiteboard-room-settings-error-room-alpha')).toBeNull();
    });
    expect(screen.getByText('Not switched on')).toBeTruthy();
    expect(reads).toBe(2);
  });

  it('surfaces a failed guest-settings write and retries it', async () => {
    let posts = 0;
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/whiteboard/room/room-alpha/settings' && init?.method === 'POST') {
        posts += 1;
        if (posts === 1) return new Response('nope', { status: 500 });
        return jsonResponse(200, {
          guestAccess: true,
          guestPin: '004321',
          guestPinExpiresAt: Date.now() + 60_000,
          lockoutUntil: null,
        });
      }
      if (url === '/api/whiteboard/room/room-alpha/settings') {
        return jsonResponse(200, closedSettings);
      }
      return new Response(null, { status: 404 });
    };

    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        request={request}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-pin-new-room-alpha')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-pin-new-room-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-pin-error-room-alpha')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('whiteboard-room-pin-retry-room-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-pin-room-alpha').textContent).toContain('004 321');
    });
    expect(screen.queryByTestId('whiteboard-room-pin-error-room-alpha')).toBeNull();
    expect(posts).toBe(2);
  });

  it('disables the join-link copy while guest access is off and explains why', async () => {
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        request={closedSettingsRequest}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-link-inactive-room-alpha')).toBeTruthy();
    });
    expect(screen.getByTestId('whiteboard-room-share-room-alpha')).toHaveProperty('disabled', true);
  });

  it('keeps the join-link copy enabled once guest access has a live PIN', async () => {
    const request: AjaxFetch = async () => jsonResponse(200, {
      guestAccess: true,
      guestPin: '004321',
      guestPinExpiresAt: Date.now() + 60_000,
      lockoutUntil: null,
    });

    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        request={request}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-pin-room-alpha')).toBeTruthy();
    });
    expect(screen.getByTestId('whiteboard-room-share-room-alpha')).toHaveProperty('disabled', false);
    expect(screen.queryByTestId('whiteboard-room-link-inactive-room-alpha')).toBeNull();
  });

  it('announces a link copy and names the room in each copy label', async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } },
    });
    const request: AjaxFetch = async () => jsonResponse(200, {
      guestAccess: true,
      guestPin: '004321',
      guestPinExpiresAt: Date.now() + 60_000,
      lockoutUntil: null,
    });

    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        request={request}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-pin-room-alpha')).toBeTruthy();
    });
    expect(screen.getByTestId('whiteboard-room-share-room-alpha').getAttribute('aria-label'))
      .toBe('Copy join link for Algebra');
    expect(screen.getByRole('button', { name: 'Copy class PIN for Algebra' })).toBeTruthy();

    fireEvent.click(screen.getByTestId('whiteboard-room-share-room-alpha'));

    await waitFor(() => {
      expect(copied).toHaveLength(1);
      expect(screen.getByTestId('whiteboard-room-copy-status').textContent)
        .toBe('Link copied for Algebra');
    });
  });

  it('does not open the room from the guest-access actions on the card', async () => {
    const opened: string[] = [];
    const request: AjaxFetch = async () => jsonResponse(200, {
      guestAccess: true,
      guestPin: '004321',
      guestPinExpiresAt: Date.now() + 60_000,
      lockoutUntil: null,
    });

    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={(roomId) => { opened.push(roomId); }}
        request={request}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-guest-off-room-alpha')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('whiteboard-room-guest-off-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-pin-new-room-alpha'));

    expect(opened).toEqual([]);
  });

  it('shows when the room was last used, not when it was created', () => {
    const updatedAt = Date.now() - 3 * 60 * 60 * 1000;
    const createdAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra', createdAt, updatedAt }]}
        onOpen={() => {}}
        request={closedSettingsRequest}
      />,
    );

    const date = screen.getByTestId('whiteboard-room-date-room-alpha');
    expect(date.textContent).toContain('Last used');
    expect(date.textContent).toContain('3h ago');
  });

  it('falls back to the creation date for rooms the list has no updated date for', () => {
    const createdAt = Date.now() - 2 * 60 * 60 * 1000;
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra', createdAt }]}
        onOpen={() => {}}
        request={closedSettingsRequest}
      />,
    );

    expect(screen.getByTestId('whiteboard-room-date-room-alpha').textContent).toContain('2h ago');
  });

  it('tells the teacher how long a board is kept', () => {
    render(<TeacherRoomList rooms={[]} onOpen={() => {}} request={closedSettingsRequest} />);

    expect(screen.getByTestId('whiteboard-rooms-retention').textContent).toContain('90 days');
  });

  it('states the empty list as the documented muted line, not a bordered callout (UX-B21)', () => {
    /*
     * DESIGN.md §5: "Empty state: short muted text-xs slate-400 line, no
     * illustration". The list was wearing a dashed `callout` box, which reads
     * as a warning about rooms that merely do not exist yet.
     */
    render(<TeacherRoomList rooms={[]} onOpen={() => {}} request={closedSettingsRequest} />);

    const empty = screen.getByTestId('whiteboard-room-list-empty');
    expect(empty.className).toContain('app-small');
    expect(empty.className).not.toContain('callout');
  });

  it('prints the room code on an unnamed room so its row can be identified', () => {
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-beta' }, { roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        request={closedSettingsRequest}
      />,
    );

    expect(screen.getByTestId('whiteboard-room-code-room-beta').textContent).toBe('room-beta');
    expect(screen.queryByTestId('whiteboard-room-code-room-alpha')).toBeNull();
  });

  it('says the board is permanently deleted before confirming a delete', () => {
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        onDelete={() => {}}
        request={closedSettingsRequest}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-delete-room-alpha'));

    expect(screen.getByText(/permanently deletes the board/i)).toBeTruthy();
    expect(screen.getByTestId('whiteboard-room-delete-confirm-room-alpha').className)
      .toContain('btn-danger');
  });

  it('calls the diagnostics download what it is', () => {
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        request={closedSettingsRequest}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));

    expect(screen.getByTestId('whiteboard-room-stats-room-alpha').textContent)
      .toBe('Download room data');
  });

  it('moves focus into a row menu and returns it to the kebab on Escape (UX-A5)', async () => {
    const user = userEvent.setup();
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        onDelete={() => {}}
        request={closedSettingsRequest}
      />,
    );
    const kebab = screen.getByTestId('whiteboard-room-menu-room-alpha');

    await user.click(kebab);

    const rename = screen.getByTestId('whiteboard-room-rename-room-alpha');
    const download = screen.getByTestId('whiteboard-room-download-room-alpha');
    const remove = screen.getByTestId('whiteboard-room-delete-room-alpha');
    expect(document.activeElement).toBe(rename);

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(download);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(remove);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(rename);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(remove);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(kebab);
  });

  it('labels the rename input so it can be addressed by name (UX-A18)', () => {
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        onRename={() => {}}
        request={closedSettingsRequest}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-rename-room-alpha'));

    expect(screen.getByRole('textbox', { name: 'Room name for Algebra' }))
      .toBe(screen.getByTestId('whiteboard-room-name-input-room-alpha'));
  });

  it('keeps the action kebab on the name row and clamps its menu to the viewport', () => {
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        onRename={() => {}}
        request={closedSettingsRequest}
      />,
    );

    const row = screen.getByTestId('whiteboard-room-row-room-alpha');
    expect(row.contains(screen.getByTestId('whiteboard-room-list-item-room-alpha'))).toBe(true);
    expect(row.contains(screen.getByTestId('whiteboard-room-menu-room-alpha'))).toBe(true);
    // `.row-flex` stacks its children on phones, which is what pushed the
    // kebab onto its own line and hung the menu off the left edge.
    expect(row.className).not.toContain('row-flex');
    expect(row.className).toContain('items-center');

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    expect(screen.getByRole('menu').className).toContain('max-w-[calc(100vw-2rem)]');
  });

  it('draws the kebab at the same 14px glyph as the other menus (UX-B19)', () => {
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        request={closedSettingsRequest}
      />,
    );

    const icon = screen.getByTestId('whiteboard-room-menu-room-alpha').querySelector('svg');
    expect(icon).toBeTruthy();
    expect(icon?.classList.contains('h-3.5')).toBe(true);
    expect(icon?.classList.contains('w-3.5')).toBe(true);
  });
});
