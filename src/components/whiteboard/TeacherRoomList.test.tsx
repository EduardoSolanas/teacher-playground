import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import TeacherRoomList, { teacherRoomTitle } from './TeacherRoomList';

const UNNAMED_CREATED_AT = 1_700_000_000_000;
const UNNAMED_UTC_STAMP = new Date(UNNAMED_CREATED_AT).toISOString().replace('T', ' ').slice(0, 16);

describe('TeacherRoomList', () => {
  it('shows a named room as Algebra and an unnamed createdAt room as the UTC stamp, not roomId', () => {
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
    expect(screen.getByText(UNNAMED_UTC_STAMP)).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(container.querySelector('select')).toBeNull();

    expect(screen.getByTestId('whiteboard-room-list')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-room-list-item-room-alpha').textContent).toContain(
      'Algebra',
    );
    expect(teacherRoomTitle({ roomId: 'room-alpha', name: 'Algebra' })).toBe('Algebra');
    const unnamedItem = screen.getByTestId('whiteboard-room-list-item-room-beta');
    expect(unnamedItem.textContent).toContain(UNNAMED_UTC_STAMP);
    expect(unnamedItem.textContent).not.toContain('room-beta');
    expect(
      teacherRoomTitle({ roomId: 'room-beta', createdAt: UNNAMED_CREATED_AT }),
    ).toBe(UNNAMED_UTC_STAMP);

    const algebraLink = screen.getByRole('link', { name: /Algebra/ });
    expect(algebraLink.getAttribute('href')).toBe('/whiteboard/room-alpha');

    fireEvent.click(unnamedItem);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('room-beta');
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
});
