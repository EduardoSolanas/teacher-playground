import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

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
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('shows the guest-host join URL, never the teacher-host origin', () => {
      vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', 'join.example.com');
      render(
        <TeacherRoomList rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]} onOpen={vi.fn()} />,
      );

      const url = screen.getByTestId('guest-join-url');
      expect(url.textContent).toBe('https://join.example.com/whiteboard/room-alpha');
      expect(url.textContent).not.toContain(window.location.origin);
      expect(url.textContent).not.toContain(`${window.location.host}/whiteboard/room-alpha`);
    });

    it('swaps the window origin to the guest host when the env var is unset', () => {
      vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', '');
      render(
        <TeacherRoomList rooms={[{ roomId: 'room-alpha', name: 'Algebra' }]} onOpen={vi.fn()} />,
      );

      const url = screen.getByTestId('guest-join-url').textContent ?? '';
      expect(url).toMatch(/\/whiteboard\/room-alpha$/);
      expect(url).not.toBe(`${window.location.origin}/whiteboard/room-alpha`);
      expect(new URL(url).hostname).not.toBe(window.location.hostname);
    });
  });
});
