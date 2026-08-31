import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import RoomNameField from './RoomNameField';
import { UNNAMED_ROOM_TITLE } from './TeacherRoomList';

describe('RoomNameField', () => {
  it('says what the room is called', () => {
    render(<RoomNameField name="Year 4 Maths" canRename={false} onRename={vi.fn()} />);
    expect(screen.getByTestId('room-name').textContent).toBe('Year 4 Maths');
  });

  it('falls back to the same words the room list uses', () => {
    // One name for an unnamed room, so a teacher does not meet two.
    render(<RoomNameField name={null} canRename={false} onRename={vi.fn()} />);
    expect(screen.getByTestId('room-name').textContent).toBe(UNNAMED_ROOM_TITLE);
  });

  it('offers the pencil only to somebody who may rename', () => {
    // Renaming is owner-only on the server. A pencil for anybody else is a
    // button whose only outcome is a 403.
    const { rerender } = render(
      <RoomNameField name="Maths" canRename={false} onRename={vi.fn()} />,
    );
    expect(screen.queryByTestId('room-name-edit')).toBeNull();

    rerender(<RoomNameField name="Maths" canRename onRename={vi.fn()} />);
    expect(screen.getByTestId('room-name-edit')).toBeTruthy();
  });

  it('edits in place, starting from the name it already has', () => {
    /*
     * The field reports the new name and shows whatever it is then given: the
     * room owns its name, not the box that edits it. The caller is expected to
     * take the rename it is handed straight away rather than wait for a fetch,
     * or the words would snap back under the person who just typed them.
     */
    const onRename = vi.fn();
    const { rerender } = render(
      <RoomNameField name="Maths" canRename onRename={onRename} />,
    );

    fireEvent.click(screen.getByTestId('room-name-edit'));
    const input = screen.getByTestId('room-name-input') as HTMLInputElement;
    expect(input.value).toBe('Maths');

    fireEvent.change(input, { target: { value: 'Year 4 Maths' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('Year 4 Maths');

    rerender(<RoomNameField name="Year 4 Maths" canRename onRename={onRename} />);
    expect(screen.getByTestId('room-name').textContent).toBe('Year 4 Maths');
  });

  it('leaves the name alone when the edit is abandoned', () => {
    const onRename = vi.fn();
    render(<RoomNameField name="Maths" canRename onRename={onRename} />);

    fireEvent.click(screen.getByTestId('room-name-edit'));
    const input = screen.getByTestId('room-name-input');
    fireEvent.change(input, { target: { value: 'Half-typed' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId('room-name').textContent).toBe('Maths');
  });

  it('refuses a blank name rather than saving one', () => {
    /*
     * roomSettingsSchema takes a non-empty string or nothing at all, so a
     * blank save would 400 and be swallowed -- an edit that looks committed
     * and changed nothing. Better to keep the box open.
     */
    const onRename = vi.fn();
    render(<RoomNameField name="Maths" canRename onRename={onRename} />);

    fireEvent.click(screen.getByTestId('room-name-edit'));
    const input = screen.getByTestId('room-name-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId('room-name-input')).toBeTruthy();
  });

  it('follows a rename that came from somewhere else', () => {
    // The name arrives from the room fetch, so it can change under a peer who
    // is not the one editing it.
    const { rerender } = render(
      <RoomNameField name="Maths" canRename={false} onRename={vi.fn()} />,
    );
    rerender(<RoomNameField name="Science" canRename={false} onRename={vi.fn()} />);
    expect(screen.getByTestId('room-name').textContent).toBe('Science');
  });
});
