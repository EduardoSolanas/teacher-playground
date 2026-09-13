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

describe('TeacherRoomList freshness labels', () => {
  it('names a fresh, an hour-old and a week-old room', () => {
    const now = Date.now();
    render(
      <TeacherRoomList
        rooms={[
          { roomId: 'room-now', updatedAt: now },
          { roomId: 'room-mins', updatedAt: now - 10 * 60_000 },
          { roomId: 'room-days', updatedAt: now - 5 * 24 * 60 * 60_000 },
        ]}
        onOpen={() => {}}
        request={closedSettingsRequest}
      />,
    );

    expect(screen.getByTestId('whiteboard-room-date-room-now').textContent).toContain('Just now');
    expect(screen.getByTestId('whiteboard-room-date-room-mins').textContent).toContain('10m ago');
    expect(screen.getByTestId('whiteboard-room-date-room-days').textContent).toContain('5d ago');
  });
});

describe('readGuestSettings payload shapes', () => {
  it('treats a payload that is not an object as closed settings', async () => {
    const loaded = await readGuestSettings(
      async () => jsonResponse(200, null),
      'room-alpha',
    );

    expect(loaded).toEqual({
      guestAccess: false,
      guestPin: null,
      guestPinExpiresAt: null,
      lockoutUntil: null,
    });
  });

  it('reads a numeric lockout window and leaves the rest behind', async () => {
    const loaded = await readGuestSettings(
      async () => jsonResponse(200, {
        guestAccess: true,
        guestPin: '004321',
        lockoutUntil: 1_700_000_000_000,
      }),
      'room-alpha',
    );

    expect(loaded).toEqual({
      guestAccess: true,
      guestPin: '004321',
      guestPinExpiresAt: null,
      lockoutUntil: 1_700_000_000_000,
    });
  });
});

describe('TeacherRoomList row menu details', () => {
  it('closes the menu when its kebab is pressed again', () => {
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        request={closedSettingsRequest}
      />,
    );
    const kebab = screen.getByTestId('whiteboard-room-menu-room-alpha');

    fireEvent.click(kebab);
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.click(kebab);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('cancels a rename on Escape and drops the editor', () => {
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
    const input = screen.getByTestId('whiteboard-room-name-input-room-alpha');
    fireEvent.change(input, { target: { value: 'Geometry' } });

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByTestId('whiteboard-room-name-input-room-alpha')).toBeNull();
    expect(screen.getByTestId('whiteboard-room-list-item-room-alpha').textContent)
      .toContain('Algebra');
  });

  it('opens the rename editor empty for a room that was never named', () => {
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-beta' }]}
        onOpen={() => {}}
        onRename={() => {}}
        request={closedSettingsRequest}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-beta'));
    fireEvent.click(screen.getByTestId('whiteboard-room-rename-room-beta'));

    expect(screen.getByTestId('whiteboard-room-name-input-room-beta'))
      .toHaveProperty('value', '');
  });

  it('walks focus back to the menu ends when nothing inside it has focus', () => {
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        onDelete={() => {}}
        request={closedSettingsRequest}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    const menu = screen.getByRole('menu');
    const rename = screen.getByTestId('whiteboard-room-rename-room-alpha');
    const remove = screen.getByTestId('whiteboard-room-delete-room-alpha');

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rename);

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(remove);
  });

  it('closes the menu on Tab rather than walking its items', () => {
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        onRename={() => {}}
        request={closedSettingsRequest}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('cancels a rename from its Cancel button', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByTestId('whiteboard-room-name-input-room-alpha')).toBeNull();
    expect(screen.getByTestId('whiteboard-room-list-item-room-alpha').textContent)
      .toContain('Algebra');
  });

  it('backs out of the delete confirmation without deleting', () => {
    const deleted: string[] = [];
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        onDelete={(roomId) => { deleted.push(roomId); }}
        request={closedSettingsRequest}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-delete-room-alpha'));
    expect(screen.getByTestId('whiteboard-room-delete-confirm-room-alpha')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(deleted).toEqual([]);
    expect(screen.queryByTestId('whiteboard-room-delete-confirm-room-alpha')).toBeNull();
    expect(screen.getByTestId('whiteboard-room-list-item-room-alpha')).toBeTruthy();
  });
});

describe('TeacherRoomList copy recovery', () => {
  it('clears the manual-copy fallback once a later copy lands', async () => {
    let refusing = true;
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return refusing
            ? Promise.reject(new Error('clipboard denied'))
            : Promise.resolve();
        },
      },
    });
    const request: AjaxFetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/settings')) {
        return jsonResponse(200, {
          guestAccess: true,
          guestPin: '004321',
          guestPinExpiresAt: Date.now() + 60_000,
          lockoutUntil: null,
        });
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
      expect(screen.getByTestId('whiteboard-room-pin-room-alpha')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-share-room-alpha'));
    await screen.findByTestId('whiteboard-room-copy-fallback-room-alpha');

    refusing = false;
    fireEvent.click(screen.getByTestId('whiteboard-room-share-room-alpha'));

    await waitFor(() => {
      expect(screen.queryByTestId('whiteboard-room-copy-fallback-room-alpha')).toBeNull();
    });
    expect(copied).toHaveLength(2);
    expect(screen.getByTestId('whiteboard-room-copy-status').textContent)
      .toBe('Link copied for Algebra');
  });
});

describe('TeacherRoomList class PIN rotation', () => {
  const liveSettings = (pin: string) => ({
    guestAccess: true,
    guestPin: pin,
    guestPinExpiresAt: Date.now() + 60_000,
    lockoutUntil: null,
  });

  it('strikes through the replaced PIN and says the old one is locked out', async () => {
    const bodies: Record<string, unknown>[] = [];
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/settings') && init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        return jsonResponse(200, liveSettings('222222'));
      }
      if (url.endsWith('/settings')) return jsonResponse(200, liveSettings('111111'));
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
      expect(screen.getByTestId('whiteboard-room-pin-room-alpha').textContent).toContain('111 111');
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-pin-new-room-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-pin-room-alpha').textContent).toContain('222 222');
    });
    expect(bodies).toEqual([{ guestAccess: true, rotateGuestPin: true }]);
    expect(screen.getByTestId('whiteboard-room-pin-old-room-alpha').textContent).toBe('111 111');
    expect(screen.getByText(/Anyone holding the old PIN is locked out/)).toBeTruthy();
  });

  it('strikes through a PIN that ran out of time on its own', async () => {
    const request: AjaxFetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/settings')) {
        return jsonResponse(200, {
          guestAccess: true,
          guestPin: '654321',
          guestPinExpiresAt: Date.now() - 1_000,
          lockoutUntil: null,
        });
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
      expect(screen.getByTestId('whiteboard-room-pin-old-room-alpha').textContent).toBe('654 321');
    });
    expect(screen.getByText('Expired')).toBeTruthy();
  });

  it('warns when wrong PIN attempts have locked the room out', async () => {
    const request: AjaxFetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/settings')) {
        return jsonResponse(200, {
          guestAccess: true,
          guestPin: '111111',
          guestPinExpiresAt: Date.now() + 60_000,
          lockoutUntil: Date.now() + 60_000,
        });
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
      expect(screen.getByTestId('whiteboard-room-lockout-room-alpha').textContent)
        .toContain('join is locked');
    });
  });

  it('keeps another room busy state intact when one PIN write finishes', async () => {
    const pending: Record<string, (response: Response) => void> = {};
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      const match = url.match(/^\/api\/whiteboard\/room\/(room-\w+)\/settings$/);
      if (match && init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          pending[match[1]] = resolve;
        });
      }
      if (match) return jsonResponse(200, closedSettings);
      return new Response(null, { status: 404 });
    };

    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha' }, { roomId: 'room-beta' }]}
        onOpen={() => {}}
        request={request}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-pin-new-room-alpha').textContent).toBe('Create PIN');
      expect(screen.getByTestId('whiteboard-room-pin-new-room-beta').textContent).toBe('Create PIN');
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-pin-new-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-pin-new-room-beta'));

    expect(screen.getByTestId('whiteboard-room-pin-new-room-beta').textContent).toBe('Working…');

    pending['room-alpha']?.(jsonResponse(200, liveSettings('111111')));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-pin-new-room-alpha').textContent).toBe('New PIN');
    });
    expect(screen.getByTestId('whiteboard-room-pin-new-room-beta').textContent).toBe('Working…');

    pending['room-beta']?.(jsonResponse(200, liveSettings('222222')));

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-pin-new-room-beta').textContent).toBe('New PIN');
    });
  });
});

describe('TeacherRoomList downloads', () => {
  function installObjectUrls(): string[] {
    const urls: string[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => {
        const url = `blob:room-${urls.length + 1}-${blob.size}`;
        urls.push(url);
        return url;
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: () => {},
    });
    return urls;
  }

  it('says so when a board download fails', async () => {
    const request: AjaxFetch = async (input) => {
      const url = String(input);
      if (url === '/api/whiteboard/room/room-alpha') {
        return new Response('nope', { status: 500 });
      }
      if (url.endsWith('/settings')) return jsonResponse(200, closedSettings);
      return new Response(null, { status: 404 });
    };

    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        request={request}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-download-room-alpha'));

    expect(await screen.findByText(/Could not build that download/)).toBeTruthy();
  });

  it('downloads a board without complaint when the scene comes back', async () => {
    const urls = installObjectUrls();
    const request: AjaxFetch = async (input) => {
      const url = String(input);
      if (url === '/api/whiteboard/room/room-alpha') {
        return jsonResponse(200, { elements: [] });
      }
      if (url.endsWith('/settings')) return jsonResponse(200, closedSettings);
      return new Response(null, { status: 404 });
    };

    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        request={request}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-download-room-alpha'));

    await waitFor(() => {
      expect(urls).toHaveLength(1);
    });
    expect(screen.queryByText(/Could not build that download/)).toBeNull();
  });

  it('refuses to draw an image from an empty board', async () => {
    installObjectUrls();
    const request: AjaxFetch = async (input) => {
      const url = String(input);
      if (url === '/api/whiteboard/room/room-alpha') {
        return jsonResponse(200, { elements: [] });
      }
      if (url.endsWith('/settings')) return jsonResponse(200, closedSettings);
      return new Response(null, { status: 404 });
    };

    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        request={request}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-image-room-alpha'));

    expect(await screen.findByText(/Could not build that download/)).toBeTruthy();
  });

  it('keeps another room image export from resolving the wrong busy marker', async () => {
    const pending: Record<string, (response: Response) => void> = {};
    const request: AjaxFetch = async (input) => {
      const url = String(input);
      const match = url.match(/^\/api\/whiteboard\/room\/(room-\w+)$/);
      if (match) {
        return new Promise<Response>((resolve) => {
          pending[match[1]] = resolve;
        });
      }
      if (url.endsWith('/settings')) return jsonResponse(200, closedSettings);
      return new Response(null, { status: 404 });
    };

    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha' }, { roomId: 'room-beta' }]}
        onOpen={() => {}}
        request={request}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-image-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-beta'));
    fireEvent.click(screen.getByTestId('whiteboard-room-image-room-beta'));

    pending['room-alpha']?.(jsonResponse(200, { elements: [] }));

    expect(await screen.findByText(/Could not build that download/)).toBeTruthy();

    pending['room-beta']?.(jsonResponse(200, { elements: [] }));
    await waitFor(() => {
      expect(screen.getAllByText(/Could not build that download/)).toHaveLength(1);
    });
    expect(pending['room-beta']).toBeTypeOf('function');
  });

  it('says so when the room data file cannot be built', async () => {
    const request: AjaxFetch = async (input) => {
      const url = String(input);
      if (url === '/api/whiteboard/room/room-alpha/stats') {
        return new Response('nope', { status: 500 });
      }
      if (url.endsWith('/settings')) return jsonResponse(200, closedSettings);
      return new Response(null, { status: 404 });
    };

    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        request={request}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-stats-room-alpha'));

    expect(await screen.findByText(/Could not build the room data file/)).toBeTruthy();
  });

  it('downloads the room data without complaint', async () => {
    const urls = installObjectUrls();
    const request: AjaxFetch = async (input) => {
      const url = String(input);
      if (url === '/api/whiteboard/room/room-alpha/stats') {
        return jsonResponse(200, { roomId: 'room-alpha', elements: 0 });
      }
      if (url.endsWith('/settings')) return jsonResponse(200, closedSettings);
      return new Response(null, { status: 404 });
    };

    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={() => {}}
        request={request}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-stats-room-alpha'));

    await waitFor(() => {
      expect(urls).toHaveLength(1);
    });
    expect(screen.queryByText(/Could not build the room data file/)).toBeNull();
  });

  it('keeps another room export busy state intact when one download finishes', async () => {
    const urls = installObjectUrls();
    const pending: Record<string, (response: Response) => void> = {};
    const request: AjaxFetch = async (input) => {
      const url = String(input);
      const match = url.match(/^\/api\/whiteboard\/room\/(room-\w+)$/);
      if (match) {
        return new Promise<Response>((resolve) => {
          pending[match[1]] = resolve;
        });
      }
      if (url.endsWith('/settings')) return jsonResponse(200, closedSettings);
      return new Response(null, { status: 404 });
    };

    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha' }, { roomId: 'room-beta' }]}
        onOpen={() => {}}
        request={request}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-download-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-beta'));
    fireEvent.click(screen.getByTestId('whiteboard-room-download-room-beta'));

    pending['room-alpha']?.(jsonResponse(200, { elements: [] }));

    await waitFor(() => {
      expect(urls).toHaveLength(1);
    });

    pending['room-beta']?.(jsonResponse(200, { elements: [] }));

    await waitFor(() => {
      expect(urls).toHaveLength(2);
    });
  });
});

describe('TeacherRoomList settings reads', () => {
  it('coalesces a second read for the same rooms', async () => {
    const requests: { roomId: string; resolve: (response: Response) => void }[] = [];
    const request: AjaxFetch = async (input) => {
      const match = String(input).match(/^\/api\/whiteboard\/room\/(room-\w+)\/settings$/);
      if (match) {
        return new Promise<Response>((resolve) => {
          requests.push({ roomId: match[1], resolve });
        });
      }
      return new Response(null, { status: 404 });
    };

    const view = render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha' }, { roomId: 'room-beta' }]}
        onOpen={() => {}}
        request={request}
      />,
    );

    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    view.rerender(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha' }, { roomId: 'room-beta' }]}
        onOpen={() => {}}
        request={request}
      />,
    );
    await waitFor(() => {
      expect(requests).toHaveLength(4);
    });

    for (const entry of requests) {
      entry.resolve(entry.roomId === 'room-alpha'
        ? new Response('nope', { status: 500 })
        : jsonResponse(200, closedSettings));
    }

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-room-settings-error-room-alpha')).toBeTruthy();
    });
    expect(screen.getAllByText('Not switched on')).toHaveLength(1);
  });
});
