import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import TeacherRoomList, { teacherRoomTitle } from './TeacherRoomList';

const UNNAMED_CREATED_AT = 1_700_000_000_000;
const UNNAMED_UTC_STAMP = new Date(UNNAMED_CREATED_AT).toISOString().replace('T', ' ').slice(0, 16);

describe('TeacherRoomList', () => {
  // A room falls back to its own code, not its creation time. The code is what
  // a teacher reads out or recognises; a UTC stamp names every room the same
  // shape and tells you nothing about which room it is.
  it('shows a named room by name and an unnamed room by its code', () => {
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
    expect(screen.getByText('room-beta')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(container.querySelector('select')).toBeNull();

    expect(screen.getByTestId('whiteboard-room-list')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-room-list-item-room-alpha').textContent).toContain(
      'Algebra',
    );
    expect(teacherRoomTitle({ roomId: 'room-alpha', name: 'Algebra' })).toBe('Algebra');
    const unnamedItem = screen.getByTestId('whiteboard-room-list-item-room-beta');
    expect(unnamedItem.textContent).toContain('room-beta');
    expect(unnamedItem.textContent).not.toContain(UNNAMED_UTC_STAMP);
    // createdAt present and still ignored: only a name beats the code.
    expect(
      teacherRoomTitle({ roomId: 'room-beta', createdAt: UNNAMED_CREATED_AT }),
    ).toBe('room-beta');
    expect(teacherRoomTitle({ roomId: 'room-beta', name: '   ' })).toBe('room-beta');
    expect(teacherRoomTitle({ roomId: 'room-beta', name: null })).toBe('room-beta');

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

    it('does not print the raw URL in the row', () => {
      vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', 'join.example.com');
      render(
        <TeacherRoomList rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]} onOpen={vi.fn()} />,
      );

      expect(screen.queryByTestId('guest-join-url')).toBeNull();
      expect(screen.getByTestId('whiteboard-room-list').textContent)
        .not.toContain('https://');
    });
  });
});
