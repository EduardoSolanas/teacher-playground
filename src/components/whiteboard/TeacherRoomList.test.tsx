import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import TeacherRoomList, {
  teacherRoomTitle,
  UNNAMED_ROOM_TITLE,
  guestPinState,
  formatGuestPin,
  replacedPin,
} from './TeacherRoomList';

const UNNAMED_CREATED_AT = 1_700_000_000_000;
const UNNAMED_UTC_STAMP = new Date(UNNAMED_CREATED_AT).toISOString().replace('T', ' ').slice(0, 16);

const ajaxFetch = vi.fn();
vi.mock('@/lib/http/ajaxFetch', () => ({
  ajaxFetch: (...args: unknown[]) => ajaxFetch(...args),
}));

describe('TeacherRoomList', () => {
  beforeEach(() => {
    ajaxFetch.mockReset();
    ajaxFetch.mockImplementation(() => new Promise(() => {}));
  });
  // A room falls back to its own code, not its creation time. The code is what
  // a teacher reads out or recognises; a UTC stamp names every room the same
  // shape and tells you nothing about which room it is.
  it('shows a named room by name and an unnamed one as untitled', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <TeacherRoomList
        rooms={[
          { roomId: 'room-alpha', name: 'Algebra' },
          { roomId: 'room-beta', createdAt: UNNAMED_CREATED_AT },
        ]}
        onOpen={onOpen}
      />,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Your rooms' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Algebra')).toBeTruthy();
    expect(screen.getByText(UNNAMED_ROOM_TITLE)).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(container.querySelector('select')).toBeNull();

    expect(screen.getByTestId('whiteboard-room-list')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-room-list-item-room-alpha').textContent).toContain(
      'Algebra',
    );
    expect(teacherRoomTitle({ roomId: 'room-alpha', name: 'Algebra' })).toBe('Algebra');

    /*
     * An unnamed room was titled by its room id, a thirty-two character
     * hexadecimal string, because nothing else identified it. Nothing in the
     * product ever asks anyone to type that id -- a student follows the link
     * and enters the PIN -- so the row does not print it and the heading says
     * what it is.
     */
    const unnamedItem = screen.getByTestId('whiteboard-room-list-item-room-beta');
    expect(unnamedItem.textContent).toContain(UNNAMED_ROOM_TITLE);
    expect(unnamedItem.textContent).not.toContain(UNNAMED_UTC_STAMP);
    // createdAt present and still ignored: it never identified anything.
    expect(
      teacherRoomTitle({ roomId: 'room-beta', createdAt: UNNAMED_CREATED_AT }),
    ).toBe(UNNAMED_ROOM_TITLE);
    expect(teacherRoomTitle({ roomId: 'room-beta', name: '   ' })).toBe(UNNAMED_ROOM_TITLE);
    expect(teacherRoomTitle({ roomId: 'room-beta', name: null })).toBe(UNNAMED_ROOM_TITLE);

    const algebraLink = screen.getByRole('link', { name: /Algebra/ });
    expect(algebraLink.getAttribute('href')).toBe('/whiteboard/room-alpha');

    fireEvent.click(unnamedItem);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('room-beta');
  });

  // A name is either a real name or absent; '' is neither. roomSettingsSchema
  // types it as a non-empty string, so a blank save would 400 and be swallowed
  // silently by handleRename, leaving the teacher with a dead Save button.
  it('refuses to submit a blank rename', () => {
    const onRename = vi.fn();
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={vi.fn()}
        onRename={onRename}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-rename-room-alpha'));

    const input = screen.getByTestId('whiteboard-room-name-input-room-alpha');
    fireEvent.change(input, { target: { value: '   ' } });

    const save = screen.getByTestId('whiteboard-room-name-save-room-alpha');
    expect(save).toHaveProperty('disabled', true);

    fireEvent.click(save);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('trims a rename before handing it on', () => {
    const onRename = vi.fn();
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={vi.fn()}
        onRename={onRename}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-rename-room-alpha'));
    fireEvent.change(screen.getByTestId('whiteboard-room-name-input-room-alpha'), {
      target: { value: '  Tuesday algebra  ' },
    });
    fireEvent.click(screen.getByTestId('whiteboard-room-name-save-room-alpha'));

    expect(onRename).toHaveBeenCalledWith('room-alpha', 'Tuesday algebra');
  });

  it('opens a named room on click and does not navigate when renaming', () => {
    const onOpen = vi.fn();
    const onRename = vi.fn();
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={onOpen}
        onRename={onRename}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-list-item-room-alpha'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('room-alpha');

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-rename-room-alpha'));
    expect(onOpen).toHaveBeenCalledTimes(1);

    const input = screen.getByTestId('whiteboard-room-name-input-room-alpha') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Geometry' } });
    fireEvent.click(screen.getByTestId('whiteboard-room-name-save-room-alpha'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith('room-alpha', 'Geometry');
  });

  it('shows an empty state when there are no rooms', () => {
    const { container } = render(<TeacherRoomList rooms={[]} onOpen={vi.fn()} />);

    expect(screen.getByTestId('whiteboard-room-list-empty')).toBeTruthy();
    expect(screen.queryByTestId('whiteboard-room-list')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
  });

  it('shows a loading state instead of the list or empty message', () => {
    const { container } = render(<TeacherRoomList rooms={[]} loading onOpen={vi.fn()} />);

    expect(screen.getByTestId('whiteboard-room-list-loading')).toBeTruthy();
    expect(screen.queryByTestId('whiteboard-room-list')).toBeNull();
    expect(screen.queryByTestId('whiteboard-room-list-empty')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
  });
  it('deletes through an inline confirmation that survives the outside-click handler', () => {
    const onDelete = vi.fn();
    render(
      <TeacherRoomList
        rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
        onOpen={vi.fn()}
        onDelete={onDelete}
      />,
    );

    fireEvent.pointerDown(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));

    const deleteItem = screen.getByTestId('whiteboard-room-delete-room-alpha');
    fireEvent.pointerDown(deleteItem);
    fireEvent.click(deleteItem);

    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('whiteboard-room-delete-confirm-room-alpha'));
    expect(onDelete).toHaveBeenCalledWith('room-alpha');
  });

  it('closes the action menu on an outside pointer press', () => {
    render(
      <TeacherRoomList rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]} onOpen={vi.fn()} onRename={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
    expect(screen.getByTestId('whiteboard-room-rename-room-alpha')).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('whiteboard-room-rename-room-alpha')).toBeNull();
  });

  describe('the class PIN line', () => {
    const live = {
      guestAccess: true,
      guestPin: '004321',
      guestPinExpiresAt: 2_000,
    };

    it('waits rather than guessing before the settings have been read', () => {
      // 'off' would be a guess, and a teacher acting on it would switch guest
      // access on for a room that already had it.
      expect(guestPinState(undefined, 1_000)).toBe('unknown');
      expect(guestPinState(live, null)).toBe('unknown');
    });

    it('reads a PIN that is still in date as live', () => {
      expect(guestPinState(live, 1_999)).toBe('live');
    });

    it('treats an elapsed expiry as expired, including the exact moment', () => {
      expect(guestPinState(live, 2_001)).toBe('expired');
      // A PIN is dead the instant it expires, not a millisecond afterwards.
      expect(guestPinState(live, 2_000)).toBe('expired');
    });

    it('treats guest access on with no PIN as expired, not as live', () => {
      expect(guestPinState({ ...live, guestPin: null }, 1_000)).toBe('expired');
      expect(guestPinState({ ...live, guestPinExpiresAt: null }, 1_000)).toBe('expired');
    });

    it('separates a room that was never opened to guests', () => {
      expect(guestPinState({ ...live, guestAccess: false }, 1_000)).toBe('off');
    });

    it('remembers the PIN a rotation replaced, so it can be struck through', () => {
      expect(replacedPin('111111', '222222')).toBe('111111');
    });

    it('leaves no corpse when nothing was actually replaced', () => {
      // A first PIN replaces nothing, and a response carrying the same digits
      // has not rotated anything: striking either through would tell a teacher
      // that somebody has been locked out when nobody has.
      expect(replacedPin(null, '222222')).toBeNull();
      expect(replacedPin(undefined, '222222')).toBeNull();
      expect(replacedPin('111111', '111111')).toBeNull();
      expect(replacedPin('111111', null)).toBeNull();
    });

    it('groups the digits for reading aloud and leaves anything else alone', () => {
      expect(formatGuestPin('004321')).toBe('004 321');
      // Zero-padded and unusual lengths both survive: the value copied is the
      // raw string, so this only ever changes what is on the screen.
      expect(formatGuestPin('12345')).toBe('12345');
      expect(formatGuestPin('')).toBe('');
    });
  });

  describe('guest-host join URL', () => {
    // The row no longer prints the URL, so the guard moves to where the URL
    // actually reaches a student: the clipboard. A teacher-host origin copied
    // here would send a minor to a surface Access sits in front of, which they
    // cannot pass.
    let copied: string[];

    beforeEach(() => {
      copied = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } },
      });
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function copyFirstShareLink() {
      fireEvent.click(screen.getByTestId('whiteboard-room-share-room-alpha'));
      await waitFor(() => expect(copied).toHaveLength(1));
      return copied[0];
    }

    it('copies the guest-host join URL, never the teacher-host origin', async () => {
      vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', 'join.example.com');
      render(
        <TeacherRoomList rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]} onOpen={vi.fn()} />,
      );

      const url = await copyFirstShareLink();
      expect(url).toBe('https://join.example.com/whiteboard/room-alpha');
      expect(url).not.toContain(window.location.origin);
      expect(url).not.toContain(`${window.location.host}/whiteboard/room-alpha`);
    });

    it('swaps the window origin to the guest host when the env var is unset', async () => {
      vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', '');
      render(
        <TeacherRoomList rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]} onOpen={vi.fn()} />,
      );

      const url = await copyFirstShareLink();
      expect(url).toMatch(/\/whiteboard\/room-alpha$/);
      expect(url).not.toBe(`${window.location.origin}/whiteboard/room-alpha`);
      expect(new URL(url).hostname).not.toBe(window.location.hostname);
    });

    /*
     * The link is not printed any more: the row keeps only the copy control,
     * which carries the same guest-host guard on the clipboard it writes.
     *
     * A URL left on the screen invites a teacher to read a teacher-origin
     * address aloud or paste it somewhere the clipboard never touches, and a
     * student following that meets Cloudflare Access. The manual-copy fallback
     * still exists, but only after a copy has actually failed, where it is the
     * only way to get the link out.
     */
    it('keeps the raw join URL off the row and offers a named copy button', async () => {
      vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', 'join.example.com');
      render(
        <TeacherRoomList rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]} onOpen={vi.fn()} />,
      );

      expect(screen.queryByTestId('whiteboard-room-url-room-alpha')).toBeNull();
      expect(screen.queryByText('https://join.example.com/whiteboard/room-alpha')).toBeNull();
      expect(screen.getByTestId('whiteboard-room-share-room-alpha').getAttribute('aria-label'))
        .toBe('Copy join link for Algebra');

      await copyFirstShareLink();
      expect(screen.queryByTestId('whiteboard-room-url-room-alpha')).toBeNull();
    });

    it('reveals the guest-host join URL when the clipboard refuses the copy', async () => {
      vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', 'join.example.com');
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('clipboard denied')) },
      });
      const onOpen = vi.fn();
      render(
        <TeacherRoomList rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]} onOpen={onOpen} />,
      );

      expect(screen.queryByTestId('whiteboard-room-url-room-alpha')).toBeNull();
      fireEvent.click(screen.getByTestId('whiteboard-room-share-room-alpha'));

      const printed = await screen.findByTestId('whiteboard-room-url-room-alpha');
      expect(printed.textContent).toBe('https://join.example.com/whiteboard/room-alpha');
      expect(printed.textContent).not.toContain(window.location.origin);

      // The revealed link is for copying by hand, not another way into the room.
      fireEvent.click(printed);
      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  describe('the whole room card', () => {
    it('opens the room from a non-interactive area of the card', () => {
      const onOpen = vi.fn();
      render(
        <TeacherRoomList rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]} onOpen={onOpen} />,
      );

      fireEvent.click(screen.getByTestId('whiteboard-room-card-room-alpha'));

      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(onOpen).toHaveBeenCalledWith('room-alpha');
    });

    it('keeps the kebab menu and its items from opening the room', () => {
      const onOpen = vi.fn();
      render(
        <TeacherRoomList
          rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]}
          onOpen={onOpen}
          onRename={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByTestId('whiteboard-room-menu-room-alpha'));
      fireEvent.click(screen.getByTestId('whiteboard-room-rename-room-alpha'));

      expect(onOpen).not.toHaveBeenCalled();
    });

    it('keeps the join-link copy button from opening the room', () => {
      const onOpen = vi.fn();
      render(
        <TeacherRoomList rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]} onOpen={onOpen} />,
      );

      fireEvent.click(screen.getByTestId('whiteboard-room-share-room-alpha'));

      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  describe('PIN actions row layout', () => {
    it('places Turn off guest join and New PIN on the right in the same horizontal actions group', async () => {
      ajaxFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            guestAccess: true,
            guestPin: '968373',
            guestPinExpiresAt: 1000,
          }),
      });

      render(
        <TeacherRoomList rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]} onOpen={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('whiteboard-room-pin-new-room-alpha')).toBeTruthy();
        expect(screen.getByTestId('whiteboard-room-guest-off-room-alpha')).toBeTruthy();
      });

      const newPinBtn = screen.getByTestId('whiteboard-room-pin-new-room-alpha');
      const offBtn = screen.getByTestId('whiteboard-room-guest-off-room-alpha');

      expect(newPinBtn.parentElement?.className).toContain('room-pin-actions');
      expect(offBtn.parentElement).toBe(newPinBtn.parentElement);
      expect(offBtn.compareDocumentPosition(newPinBtn)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it('keeps the PIN state and its guest actions in one bottom-row container', async () => {
      ajaxFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            guestAccess: true,
            guestPin: '968373',
            guestPinExpiresAt: 1000,
          }),
      });

      render(
        <TeacherRoomList rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]} onOpen={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('whiteboard-room-pin-new-room-alpha')).toBeTruthy();
      });

      const row = screen.getByTestId('whiteboard-room-actions-room-alpha');
      expect(row.textContent).toContain('Expired');
      expect(row.contains(screen.getByTestId('whiteboard-room-guest-off-room-alpha'))).toBe(true);
      expect(row.contains(screen.getByTestId('whiteboard-room-pin-new-room-alpha'))).toBe(true);
    });
  });
});
