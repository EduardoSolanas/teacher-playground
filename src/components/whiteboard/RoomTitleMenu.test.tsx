import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import RoomTitleMenu from './RoomTitleMenu';
import { UNNAMED_ROOM_TITLE } from './TeacherRoomList';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

function make(overrides: Partial<Parameters<typeof RoomTitleMenu>[0]> = {}) {
  return {
    name: 'Year 4 Maths',
    roomId: 'room-alpha',
    canManage: true,
    onRename: vi.fn(),
    onSaveAs: vi.fn(),
    onOpenLibrary: vi.fn(),
    // A real async function returning real Response objects, the same seam the
    // room list uses; no test doubles.
    request: (async () => new Response(null, { status: 500 })) as AjaxFetch,
    ...overrides,
  };
}

function settingsResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const liveSettings = {
  guestAccess: true,
  guestPin: '004321',
  guestPinExpiresAt: Date.now() + 60_000,
  lockoutUntil: null,
};

describe('RoomTitleMenu', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('says what the room is called', () => {
    render(<RoomTitleMenu {...make()} />);
    expect(screen.getByTestId('room-name').textContent).toContain('Year 4 Maths');
  });

  it('falls back to the same words the room list uses', () => {
    render(<RoomTitleMenu {...make({ name: null })} />);
    expect(screen.getByTestId('room-name').textContent).toContain(UNNAMED_ROOM_TITLE);
  });

  it('looks like a menu before it is opened', () => {
    // A bare title tells nobody it can be pressed. The chevron and the
    // expanded state are what say so, to a mouse and to a screen reader.
    render(<RoomTitleMenu {...make()} />);
    const trigger = screen.getByTestId('room-title-trigger');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('room-title-chevron')).toBeTruthy();
  });

  it('offers save, rename and the library', () => {
    render(<RoomTitleMenu {...make()} />);
    fireEvent.click(screen.getByTestId('room-title-trigger'));
    expect(screen.getByTestId('room-title-trigger').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('room-menu-save')).toBeTruthy();
    expect(screen.getByTestId('room-menu-rename')).toBeTruthy();
    expect(screen.getByTestId('room-menu-library')).toBeTruthy();
  });

  it('says what the library item does, which is more than adding to it', () => {
    // It opens Excalidraw's library panel: what is in there, what has been
    // installed, and removing any of it. "Add to library" named a third of it.
    render(<RoomTitleMenu {...make()} />);
    fireEvent.click(screen.getByTestId('room-title-trigger'));
    expect(screen.getByTestId('room-menu-library').textContent).toBe('Manage library');
  });

  it('gives every menu item the 14px inline icon the menu contract calls for (UX-B19)', () => {
    render(<RoomTitleMenu {...make()} />);
    fireEvent.click(screen.getByTestId('room-title-trigger'));

    for (const id of ['room-menu-share', 'room-menu-save', 'room-menu-rename', 'room-menu-library']) {
      const icon = screen.getByTestId(id).querySelector('svg');
      expect(icon, `${id} has no icon`).toBeTruthy();
      expect(icon?.getAttribute('width'), `${id} icon width`).toBe('14');
      expect(icon?.getAttribute('height'), `${id} icon height`).toBe('14');
    }
  });

  it('saves and opens the library through the caller', () => {
    const props = make();
    render(<RoomTitleMenu {...props} />);

    fireEvent.click(screen.getByTestId('room-title-trigger'));
    fireEvent.click(screen.getByTestId('room-menu-save'));
    expect(props.onSaveAs).toHaveBeenCalledTimes(1);
    // The menu closes behind a choice, or it sits over the board.
    expect(screen.queryByTestId('room-menu-save')).toBeNull();

    fireEvent.click(screen.getByTestId('room-title-trigger'));
    fireEvent.click(screen.getByTestId('room-menu-library'));
    expect(props.onOpenLibrary).toHaveBeenCalledTimes(1);
  });

  it('renames in place, starting from the name it already has', () => {
    const props = make();
    const { rerender } = render(<RoomTitleMenu {...props} />);

    fireEvent.click(screen.getByTestId('room-title-trigger'));
    fireEvent.click(screen.getByTestId('room-menu-rename'));
    const input = screen.getByTestId('room-name-input') as HTMLInputElement;
    expect(input.value).toBe('Year 4 Maths');

    fireEvent.change(input, { target: { value: 'Year 5 Maths' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onRename).toHaveBeenCalledWith('Year 5 Maths');

    rerender(<RoomTitleMenu {...make({ name: 'Year 5 Maths' })} />);
    expect(screen.getByTestId('room-name').textContent).toContain('Year 5 Maths');
  });

  it('abandons a rename on Escape and refuses a blank one', () => {
    /*
     * roomSettingsSchema takes a non-empty string or nothing at all, so a
     * blank save would 400 and be swallowed -- an edit that looked committed
     * and changed nothing.
     */
    const props = make();
    render(<RoomTitleMenu {...props} />);

    fireEvent.click(screen.getByTestId('room-title-trigger'));
    fireEvent.click(screen.getByTestId('room-menu-rename'));
    fireEvent.change(screen.getByTestId('room-name-input'), { target: { value: '   ' } });
    fireEvent.keyDown(screen.getByTestId('room-name-input'), { key: 'Enter' });
    expect(props.onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId('room-name-input')).toBeTruthy();

    fireEvent.keyDown(screen.getByTestId('room-name-input'), { key: 'Escape' });
    expect(props.onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId('room-name').textContent).toContain('Year 4 Maths');
  });

  describe('share from inside the room (UX-L9)', () => {
    function openShare() {
      fireEvent.click(screen.getByTestId('room-title-trigger'));
      fireEvent.click(screen.getByTestId('room-menu-share'));
    }

    function continueShare() {
      fireEvent.click(screen.getByTestId('room-menu-share'));
    }

    it('shows the join link and the class PIN without leaving the room', async () => {
      vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', 'join.example.com');
      const props = make({ request: async () => settingsResponse(liveSettings) });
      render(<RoomTitleMenu {...props} />);

      fireEvent.click(screen.getByTestId('room-title-trigger'));
      expect(screen.getByTestId('room-menu-share').textContent).toMatch(/share join link/i);

      continueShare();
      expect(screen.getByTestId('room-share-url').textContent)
        .toBe('https://join.example.com/whiteboard/room-alpha');
      await waitFor(() => {
        expect(screen.getByTestId('room-share-pin').textContent).toContain('004 321');
      });

      // Nothing behind the entry navigates away from the board.
      expect(props.onSaveAs).not.toHaveBeenCalled();
      expect(props.onOpenLibrary).not.toHaveBeenCalled();
    });

    it('copies the join link from the share panel', async () => {
      vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', 'join.example.com');
      const copied: string[] = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } },
      });
      render(<RoomTitleMenu {...make({ request: async () => settingsResponse(liveSettings) })} />);

      openShare();
      await waitFor(() => expect(screen.getByTestId('room-share-pin')).toBeTruthy());
      fireEvent.click(screen.getByTestId('room-share-copy'));

      await waitFor(() => {
        expect(copied).toEqual(['https://join.example.com/whiteboard/room-alpha']);
      });
    });

    it('says the link will not work until guest access is on', async () => {
      const request = async () => settingsResponse({
        guestAccess: false,
        guestPin: null,
        guestPinExpiresAt: null,
        lockoutUntil: null,
      });
      render(<RoomTitleMenu {...make({ request })} />);

      openShare();

      await waitFor(() => {
        expect(screen.getByTestId('room-share-pin-off').textContent).toContain('Not switched on');
      });
      expect(screen.getByTestId('room-share-copy')).toHaveProperty('disabled', true);
      expect(screen.getByText(/create a pin to let students use this link/i)).toBeTruthy();
    });

    it('distinguishes a failed settings read from "off" and retries it', async () => {
      let reads = 0;
      const request = async () => {
        reads += 1;
        return reads === 1
          ? new Response('nope', { status: 500 })
          : settingsResponse(liveSettings);
      };
      render(<RoomTitleMenu {...make({ request })} />);

      openShare();
      await waitFor(() => {
        expect(screen.getByTestId('room-share-pin-error')).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId('room-share-retry'));
      await waitFor(() => {
        expect(screen.getByTestId('room-share-pin').textContent).toContain('004 321');
      });
      expect(reads).toBe(2);
    });
  });

  it('leaves the focus ring to the global indigo style (UX-B12)', () => {
    render(<RoomTitleMenu {...make()} />);
    fireEvent.click(screen.getByTestId('room-title-trigger'));
    fireEvent.click(screen.getByTestId('room-menu-rename'));

    const input = screen.getByTestId('room-name-input');
    expect(input.className).not.toContain('outline-none');
    expect(input.className).not.toContain('focus:border');
  });

  it('uses the one in-room dropdown recipe (UX-B6, UX-B14)', () => {
    render(<RoomTitleMenu {...make()} />);
    fireEvent.click(screen.getByTestId('room-title-trigger'));

    const menu = screen.getByTestId('room-title-menu');
    expect(menu.className).toContain('bg-slate-800');
    expect(menu.className).toContain('border-slate-700');
    expect(menu.className).toContain('rounded-xl');
    expect(menu.className).not.toContain('bg-slate-900');
    expect(menu.className).not.toContain('rounded-2xl');
  });

  it('shows the name without a menu to anybody who may not manage the room', () => {
    // Every item behind it is the owner's: renaming is owner-only on the
    // server, and so is taking a copy of a child's work away.
    render(<RoomTitleMenu {...make({ canManage: false })} />);
    expect(screen.getByTestId('room-name').textContent).toContain('Year 4 Maths');
    expect(screen.queryByTestId('room-title-trigger')).toBeNull();
    expect(screen.queryByTestId('room-title-chevron')).toBeNull();
  });

  it('closes when the room is clicked away from', () => {
    render(<RoomTitleMenu {...make()} />);
    fireEvent.click(screen.getByTestId('room-title-trigger'));
    expect(screen.getByTestId('room-menu-save')).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('room-menu-save')).toBeNull();
  });

  it('moves focus into the menu and walks it with the arrow keys (UX-A5)', async () => {
    const user = userEvent.setup();
    render(<RoomTitleMenu {...make()} />);

    await user.click(screen.getByTestId('room-title-trigger'));

    const share = screen.getByTestId('room-menu-share');
    const save = screen.getByTestId('room-menu-save');
    const rename = screen.getByTestId('room-menu-rename');
    const library = screen.getByTestId('room-menu-library');
    expect(document.activeElement).toBe(share);

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(save);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rename);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(library);
    // Wraps at the end rather than falling out of the menu.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(share);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(library);

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(share);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(library);
  });

  it('closes on Escape and gives focus back to the trigger (UX-A5)', async () => {
    const user = userEvent.setup();
    render(<RoomTitleMenu {...make()} />);
    const trigger = screen.getByTestId('room-title-trigger');

    await user.click(trigger);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByTestId('room-menu-save'));
    await user.keyboard('{Escape}');

    expect(screen.queryByTestId('room-title-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
